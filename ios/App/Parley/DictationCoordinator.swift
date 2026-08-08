import Foundation
import ParleyKit
import SwiftUI

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
    private var stopObserver: DarwinObserver?

    /// Flatten the diarized segment stream to plain text: non-tail segments are
    /// settled runs (`mix-0`, `mix-1`, …) kept by id in arrival order; `mix-tail`
    /// is the tentative partial. Dictation doesn't care who spoke.
    private var runs: [(id: String, text: String)] = []

    /// Safety cap mirroring the desktop's single-session voice-typing limit: a
    /// session the user forgets to stop can't quietly burn the whole hosted
    /// quota. The backstop stops the mic; the tail still flushes.
    private let maxSeconds: UInt64 = 120

    private init() {}

    // MARK: entry points

    /// Start from the keyboard's `parley://dictate?session=…`.
    func begin(session: String) async {
        // A fresh open for the session the keyboard just wrote. If the same
        // session is already running (double-delivery of the URL), ignore.
        if active && session == self.session { return }
        if active { await stop() }
        self.session = session

        let host = DictationChannel.readUplink()?.hostBundleID
        await launch()

        // Only offer the jump-back when the host resolved AND this iOS still
        // honors it. On success `HostReturn` sends us to the background; the
        // audio session keeps the mic alive (UIBackgroundModes: audio).
        if state == .listening, let host, HostReturn.canReturn {
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
        errorMessage = nil
        runs = []
        committed = ""
        partial = ""
        state = .starting
        active = true
        publish()

        // The keyboard reaches the app only for signed-in users (it never sees
        // the token — recording and the relay are the app's job), but a session
        // can still have expired. Fail loudly into the keyboard, not silently.
        guard let token = KeychainStore.get(AppState.tokenKey) else {
            fail("請先在 Parley App 登入，再用語音鍵盤。")
            return
        }

        guard await AudioCapture.requestPermission() else {
            fail("需要麥克風權限才能聽寫。請到「設定 › Parley」開啟麥克風。")
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
            fail("連線失敗，請稍後再試。")
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
            fail("無法開啟麥克風。")
            return
        }

        state = .listening
        publish()
        armStopObserver()
        armCap()
    }

    /// Listen for the keyboard's stop request (its ⏹ button) while recording.
    private func armStopObserver() {
        stopObserver = DarwinObserver(DictationChannel.upNote) { [weak self] in
            Task { @MainActor in
                guard let self, self.active else { return }
                if DictationChannel.readUplink()?.stopRequested == true {
                    await self.stop()
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
        stopObserver = nil
        state = .done
        // Fold the last partial into the committed text so nothing said right
        // before the endpoint is dropped from what the keyboard inserts.
        if !partial.isEmpty {
            committed += partial
            partial = ""
        }
        publish()
        active = false
    }

    private func fail(_ message: String) {
        errorMessage = message
        state = .error
        capTimer?.cancel()
        capTimer = nil
        capture?.stop()
        capture = nil
        stopObserver = nil
        publish()
        active = false
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
}
