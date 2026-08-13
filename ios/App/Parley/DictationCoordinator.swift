import Foundation
import ParleyKit
import SwiftUI
import UIKit

/// Drives a keyboard-triggered dictation session inside the app, and hands the
/// transcript back to the keyboard through the App Group.
///
/// This is the phone's answer to the desktop's `voice_typing.rs`: the meeting
/// transcription stack (mic → hosted relay) with none of the meeting overhead —
/// no diarization UI, no recording upload — reduced to plain growing text. The
/// keyboard extension can't record, so it opens `parley://dictate`, this object
/// records, and the keyboard inserts the text when the user is back in their app.
///
/// One session at a time. A single coordinator is shared by both entry points —
/// the keyboard's URL (`begin(session:)`) and the Action Button App Intent
/// (`beginFromIntent()`) — so the two can never race two microphones open.
@MainActor
final class DictationCoordinator: ObservableObject {
    static let shared = DictationCoordinator()

    /// A session is live (or finishing). The root view presents the dictation
    /// screen while this is true.
    @Published private(set) var active = false
    @Published private(set) var committed = ""
    @Published private(set) var partial = ""
    @Published private(set) var micLevel: Float = 0
    @Published private(set) var state: DictationChannel.Downlink.State = .starting
    @Published private(set) var errorMessage: String?
    /// The host app to bounce back to, when the keyboard could resolve it and
    /// this iOS still allows the jump (see `HostReturn`). `nil` → show the
    /// manual "swipe to go back" guidance instead.
    @Published private(set) var returnableHost: String?

    private var session = ""
    private var capture: AudioCapture?
    private var relay: SttRelayClient?
    private var capTimer: Task<Void, Never>?
    /// Persistent uplink listener (armed for the process's whole life): stop
    /// requests for the running session, and — the no-jump path — start
    /// requests from a keyboard while this process is awake in the background.
    private var requestObserver: DarwinObserver?
    /// Keeps the process awake ~30 s after a session ends so an immediate
    /// re-tap of the keyboard's mic starts over the Darwin channel with no
    /// app switch. `.invalid` when no window is open.
    private var lingerTask: UIBackgroundTaskIdentifier = .invalid

    /// Flatten the diarized segment stream to plain text: non-tail segments are
    /// settled runs (`mix-0`, `mix-1`, …) kept by id in arrival order; `mix-tail`
    /// is the tentative partial. Dictation doesn't care who spoke.
    private var runs: [(id: String, text: String)] = []

    /// Safety cap mirroring the desktop's single-session voice-typing limit: a
    /// session the user forgets to stop can't quietly burn the whole hosted
    /// quota. The backstop stops the mic; the tail still flushes.
    private let maxSeconds: UInt64 = 120

    private init() {
        armRequestObserver()
    }

    // MARK: entry points

    /// Start from the keyboard's `parley://dictate?session=…`.
    func begin(session: String) async {
        // A fresh open for the session the keyboard just wrote. If the same
        // session is already running (double-delivery of the URL, or the
        // Darwin start raced the URL), ignore.
        if active && session == self.session { return }
        if active { await stop() }
        self.session = session

        let host = DictationChannel.readUplink()?.hostBundleID
        await launch()

        // Only offer the jump-back when the host resolved, this iOS still
        // honors it, AND the app actually came forward (the URL path). A
        // session started over the Darwin channel never left the host app, so
        // there is nothing to return from. On success `HostReturn` sends us to
        // the background; the audio session keeps the mic alive
        // (UIBackgroundModes: audio).
        if state == .listening, let host, HostReturn.canReturn,
            UIApplication.shared.applicationState == .active
        {
            returnableHost = host
            HostReturn.attempt(bundleID: host)
        } else {
            returnableHost = nil
        }
    }

    /// Start from the Action Button / Control Center App Intent — no jump at
    /// all, the app never comes forward. There may be no keyboard session yet,
    /// so mint one and publish it for whichever Parley keyboard is frontmost.
    func beginFromIntent() async {
        if active { return }
        session = "ab-" + UUID().uuidString
        DictationChannel.writeUplink(.init(session: session))
        returnableHost = nil
        await launch()
    }

    // MARK: engine

    private func launch() async {
        endLinger()  // the live audio session keeps the process awake from here
        errorMessage = nil
        runs = []
        committed = ""
        partial = ""
        state = .starting
        active = true
        publish()

        #if DEBUG
            // ScreenshotDemo: fake the session so the whole flow can be
            // experienced (and captured) with no account, mic, or network.
            // Only the transcript source is faked — the App Group hand-off,
            // keyboard insertion, and stop path are the production code.
            if ScreenshotDemo.servesFixtures {
                state = .listening
                publish()
                armCap()
                // The real path stays awake through the live audio session;
                // the fake one has no audio, so it needs background-task time
                // or iOS suspends the app the moment the user swipes back and
                // the stream (and the Darwin channel) freezes.
                beginLinger()
                demoTask = Task { [weak self] in await self?.streamDemoTranscript() }
                return
            }
        #endif

        // The keyboard reaches the app only for signed-in users (it never sees
        // the token — recording and the relay are the app's job), but a session
        // can still have expired. Fail loudly into the keyboard, not silently.
        guard let token = KeychainStore.get(AppState.tokenKey) else {
            fail(String(localized: "Sign in to the Parley app before using the voice keyboard."))
            return
        }

        guard await AudioCapture.requestPermission() else {
            fail(
                String(
                    localized:
                        "Dictation needs microphone access. Turn it on in Settings › Parley."))
            return
        }

        let client = SttRelayClient(
            options: .init(bearerToken: token, feature: "dictation")
        ) { [weak self] event in
            Task { @MainActor in self?.handle(event) }
        }
        do {
            try await client.start()
            relay = client
        } catch {
            fail(String(localized: "Connection failed. Please try again."))
            return
        }

        let cap = AudioCapture { [weak self] samples, level in
            Task { @MainActor in self?.micLevel = level }
            if let client = self?.relay {
                Task { try? await client.send(pcm: samples) }
            }
        }
        do {
            try cap.start()
            capture = cap
        } catch {
            await relay?.finish()
            relay = nil
            fail(String(localized: "Couldn't open the microphone."))
            return
        }

        state = .listening
        publish()
        armCap()
    }

    /// The uplink channel, listened to for the process's whole life:
    ///   - stop: the keyboard's ⏹ for the running session.
    ///   - start: a keyboard minted a new session while this process happens
    ///     to be awake (foreground, or lingering in the background right after
    ///     a session). Starting here means the user never leaves their app —
    ///     the keyboard only falls back to `parley://dictate` when this note
    ///     lands on nobody (see `KeyboardViewController.startDictation`).
    private func armRequestObserver() {
        requestObserver = DarwinObserver(DictationChannel.upNote) { [weak self] in
            Task { @MainActor in
                guard let self, let up = DictationChannel.readUplink() else { return }
                if up.stopRequested {
                    if self.active, up.session == self.session { await self.stop() }
                } else if !up.session.isEmpty, up.session != self.session {
                    await self.begin(session: up.session)
                }
            }
        }
    }

    private func armCap() {
        let limit = maxSeconds
        capTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Double(limit)))
            guard !Task.isCancelled else { return }
            await self?.stop()
        }
    }

    private func handle(_ event: SttRelayEvent) {
        switch event {
        case .segment(let seg):
            if seg.id.hasSuffix("-tail") {
                partial = seg.text
            } else if let i = runs.firstIndex(where: { $0.id == seg.id }) {
                runs[i].text = seg.text
            } else {
                runs.append((seg.id, seg.text))
            }
            committed = runs.map(\.text).joined()
            publish()
        case .closed:
            if active { finishUp() }
        case .error(let message):
            fail(message)
        }
    }

    // MARK: stop / teardown

    func stop() async {
        guard active else { return }
        #if DEBUG
            demoTask?.cancel()
            demoTask = nil
        #endif
        capTimer?.cancel()
        capTimer = nil
        capture?.stop()
        capture = nil
        micLevel = 0
        state = .finishing
        publish()
        if let relay {
            await relay.finish()  // drain: the relay flushes the last utterance
        }
        finishUp()
    }

    private func finishUp() {
        relay = nil
        state = .done
        // Fold the last partial into the committed text so nothing said right
        // before the endpoint is dropped from what the keyboard inserts.
        if !partial.isEmpty {
            committed += partial
            partial = ""
        }
        publish()
        active = false
        beginLinger()
    }

    private func fail(_ message: String) {
        errorMessage = message
        state = .error
        capTimer?.cancel()
        capTimer = nil
        capture?.stop()
        capture = nil
        publish()
        active = false
        beginLinger()
    }

    // MARK: background linger

    /// With the audio session closed the system suspends this process within
    /// seconds, and a suspended process can't hear the keyboard's next start
    /// note — the user would get bounced through the app again. ~30 s of
    /// background-task time covers the common "stop, think, dictate again"
    /// beat with no app switch.
    private func beginLinger() {
        endLinger()
        lingerTask = UIApplication.shared.beginBackgroundTask(withName: "dictation-relaunch") {
            [weak self] in self?.endLinger()
        }
    }

    private func endLinger() {
        guard lingerTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(lingerTask)
        lingerTask = .invalid
    }

    /// Mirror the live state into the downlink the keyboard reads.
    private func publish() {
        DictationChannel.writeDownlink(
            .init(
                session: session, committed: committed, partial: partial,
                state: state, errorMessage: errorMessage))
    }

    /// Dismiss the dictation screen back to the app's normal UI (used when the
    /// user came back to Parley itself rather than bouncing to a host app).
    func dismiss() async {
        if active { await stop() }
        active = false
    }

    #if DEBUG
        private var demoTask: Task<Void, Never>?

        /// Feed the scripted transcript through the same
        /// committed/partial/publish path the relay events drive, at roughly
        /// speaking pace. Whatever is left as the tail when the user stops is
        /// folded in by `finishUp`, exactly like a real session.
        private func streamDemoTranscript() async {
            // Real STT takes a beat before the first words settle (connect +
            // actually speaking). Matching it also means text never lands in
            // the sliver between the mic tap and the app switch, where a
            // dying keyboard's insertText silently goes nowhere.
            try? await Task.sleep(for: .milliseconds(1500))
            var settled = ""
            var tail = ""
            for piece in ScreenshotDemo.dictationScript {
                guard !Task.isCancelled, active else { return }
                tail += piece
                if tail.count >= 9 {
                    settled += tail
                    tail = ""
                }
                committed = settled
                partial = tail
                micLevel = Float.random(in: 0.08...0.45)
                publish()
                try? await Task.sleep(for: .milliseconds(200))
            }
            micLevel = 0.1
        }

        /// ScreenshotDemo (`parley://demo/dictation`): the stranded-listening
        /// state — no host to bounce back to, so the screen shows the swipe
        /// guide — with a fixture transcript. No mic, no relay, no account.
        func seedDemoListening(committed: String, partial: String) {
            guard ScreenshotDemo.isActive else { return }
            session = "demo"
            self.committed = committed
            self.partial = partial
            errorMessage = nil
            micLevel = 0.15
            returnableHost = nil
            state = .listening
            active = true
        }
    #endif
}
