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
///
/// ## The microphone is not a session's
///
/// The interesting part of this object is what happens *between* dictations.
/// When the user has chosen a microphone window (`MicWindowLength`), the end of
/// a session does not close the microphone: the audio session stays active,
/// which keeps this process resident for minutes instead of the ~30 seconds a
/// background task buys, and the next session **borrows the running capture**
/// rather than opening one. That is what lets a keyboard tap be served where
/// the user already is instead of throwing them into Parley — and it is also
/// the only way it can work at all, because iOS refuses to let a backgrounded
/// process *start* recording. A window never starts; it continues.
///
/// The cost is that the orange microphone indicator is lit for the whole
/// window, which is why the window is a setting, is bounded, is announced in
/// three places, and can be ended from any of them. See
/// `docs/design/ios-voice-keyboard.md`.
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
    /// The system microphone prompt is up. The dictation screen must not say
    /// "swipe back to your app" while it shows: obeying that guidance
    /// backgrounds the app, which cancels the prompt as a refusal — the loop
    /// that ended with users told to visit Settings for a permission they were
    /// never actually asked for.
    @Published private(set) var awaitingMicPermission = false
    /// The microphone window the app is holding right now (see `MicWindow`).
    /// Mirrored into the App Group so the keyboard can tell the user whether
    /// the next tap will stay put.
    @Published private(set) var window: MicWindowState
    /// Why a window the user asked for could not be opened — a denied
    /// microphone, or the audio session refusing. Shown in Settings, because a
    /// picker that silently does nothing is worse than no picker.
    @Published private(set) var windowProblem: String?

    private var session = ""
    /// The microphone. Not a session's: once the user has chosen a window it
    /// outlives the dictation that opened it, and the *next* dictation borrows
    /// it rather than opening its own. That is the entire mechanism — see the
    /// microphone-window section below.
    private var capture: AudioCapture?
    private var relay: SttRelayClient?
    /// The microphone's only counterparty. It forwards to the current relay
    /// leg and *holds* what is spoken while there is none, so a dropped socket
    /// costs a pause in the words appearing rather than the sentence said
    /// during it. See `RelayAudioBridge`.
    private let audio = RelayAudioBridge(holdLimit: .seconds(20))
    /// Bumped per relay connection. Events carry their leg, so a socket dying
    /// slowly cannot write into a session its replacement has moved on from,
    /// and each leg's committed ids get their own prefix (a leg numbers its
    /// segments from zero — without the prefix leg 2's first sentence would
    /// overwrite leg 1's).
    private var leg = 0
    private var reconnectTask: Task<Void, Never>?
    private var reconnectAttempts = 0
    /// The session is ending on purpose, so a socket close is the expected end
    /// of the stream rather than something to redial.
    private var finishRequested = false
    private var capTimer: Task<Void, Never>?
    /// Persistent uplink listener (armed for the process's whole life): stop
    /// requests for the running session, and — the no-jump path — start
    /// requests from a keyboard while this process is awake in the background.
    private var requestObserver: DarwinObserver?
    /// The keyboard asking for the microphone window to end now. Armed for the
    /// process's whole life, like `requestObserver`.
    private var windowControlObserver: DarwinObserver?
    /// Heartbeat + expiry for the open window, in one loop (see `runWindow`).
    private var windowTask: Task<Void, Never>?
    /// A meeting recording has taken the microphone (see `yieldMicrophone`).
    private var yieldedToMeeting = false
    /// Whether the microphone's level is still worth reporting. Read on the
    /// audio thread for every chunk, so it cannot be main-actor state: while a
    /// window is open with no session, the microphone runs for up to an hour
    /// with nothing on screen to show a level to, and hopping to the main actor
    /// a dozen times a second to set a number nobody reads is exactly the kind
    /// of background wakeup that shows up as battery.
    private let reportsLevel = LevelGate()
    /// Keeps the process awake ~30 s after a session ends — and after any trip
    /// to the background (see `armLifecycleLinger`) — so the keyboard's next
    /// mic tap starts over the Darwin channel with no app switch. `.invalid`
    /// when no background task is held.
    ///
    /// This is the *fallback*, not the mechanism: `beginBackgroundTask` is
    /// worth roughly 30 seconds, which is why the keyboard almost never won
    /// the race. It is deliberately never used while a microphone window is
    /// open — an active recording session is what keeps the process resident,
    /// and mixing a background task into it risks the assertion's end
    /// suspending an app the audio session was holding up.
    private var lingerTask: UIBackgroundTaskIdentifier = .invalid
    /// See `armLifecycleLinger`. Held for the process's whole life, like
    /// `requestObserver`.
    private var lifecycleObservers: [NSObjectProtocol] = []

    /// Flatten the diarized segment stream to plain text: non-tail segments are
    /// settled runs (`mix-0`, `mix-1`, …) kept by id in arrival order; `mix-tail`
    /// is the tentative partial. Dictation doesn't care who spoke.
    private var runs: [(id: String, text: String)] = []

    /// Safety cap mirroring the desktop's single-session voice-typing limit: a
    /// session the user forgets to stop can't quietly burn the whole hosted
    /// quota. The backstop stops the mic; the tail still flushes.
    private let maxSeconds: UInt64 = 120

    /// Dictation redials faster and gives up sooner than a meeting does:
    /// someone is standing there mid-sentence, and the whole session is capped
    /// at two minutes. `ReconnectPolicy.dictation` is that ladder.
    private static let reconnect = ReconnectPolicy.dictation

    /// Where the chosen window length lives. `AppState` binds a picker to the
    /// same key; the coordinator reads it directly because it has to know the
    /// answer in the background, long after any view is gone.
    nonisolated static let windowLengthKey = "micWindowLength"

    var windowLength: MicWindowLength {
        MicWindowLength(
            rawValue: UserDefaults.standard.string(forKey: Self.windowLengthKey) ?? "") ?? .off
    }

    private init() {
        window = .closed(length: MicWindowLength(
            rawValue: UserDefaults.standard.string(forKey: Self.windowLengthKey) ?? "") ?? .off)
        armRequestObserver()
        armWindowControlObserver()
        armLifecycleLinger()
        // Publish once at launch so a keyboard that comes up before anything
        // else has happened already knows whether the feature is on — that is
        // what it needs to say "this tap will open Parley" rather than nothing.
        publishWindow()
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
        reportsLevel.set(true)
        yieldedToMeeting = false
        errorMessage = nil
        runs = []
        committed = ""
        partial = ""
        state = .starting
        active = true
        leg = 0
        reconnectAttempts = 0
        finishRequested = false
        reconnectTask?.cancel()
        reconnectTask = nil
        audio.reset()
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

        switch AudioCapture.permission {
        case .granted:
            break
        case .denied:
            fail(
                String(
                    localized:
                        "Dictation needs microphone access. Turn it on in Settings › Parley."))
            return
        default:
            // First ask. The flag swaps the dictation screen's guidance from
            // "swipe back" to "allow the prompt" while the system alert is up —
            // swiping away would cancel the alert as a refusal.
            awaitingMicPermission = true
            let granted = await AudioCapture.requestPermission()
            awaitingMicPermission = false
            // The prompt is the moment the keyboard's pane can stop saying
            // "set up voice typing" — or must start saying it. Published
            // either way, since a refusal is news too.
            AppState.publishKeyboardReadiness()
            guard granted else {
                // Re-read to name the actual situation: a refusal in the
                // prompt is a Settings trip; a prompt that never got answered
                // (backgrounding dismisses it) stays undetermined, and the
                // next tap will simply ask again.
                if AudioCapture.permission == .denied {
                    fail(
                        String(
                            localized:
                                "Dictation needs microphone access. Turn it on in Settings › Parley."
                        ))
                } else {
                    fail(
                        String(
                            localized:
                                "Microphone access wasn't granted. Tap the mic to try again."))
                }
                return
            }
        }

        let client = makeRelay(token: token, leg: 0, timeOffsetMs: 0)
        relay = client
        audio.attach(client)

        // Microphone first, socket second. The bridge buffers whatever the
        // microphone hands it while the handshake is still in flight, so the
        // round trip to the relay stops being a round trip the user waits
        // through before their first word is captured. `AudioCapture.start()`
        // is `async` for the same reason: activating the audio session is slow
        // enough to be felt if it runs on the main actor.
        //
        // **Or there is nothing to start.** With a microphone window open the
        // capture is already running and this session simply borrows it. That
        // is not merely faster: iOS refuses to *start* recording from a
        // backgrounded process, so a session that had to open the microphone
        // here would have to bring the app forward first — which is the app
        // switch this whole feature exists to avoid.
        if capture == nil {
            let fresh = makeCapture()
            do {
                try await fresh.start()
                capture = fresh
            } catch {
                relay = nil
                audio.discard()
                client.cancel()
                fail(String(localized: "Couldn't open the microphone."))
                return
            }
        }

        do {
            try await client.start()
        } catch {
            relay = nil
            audio.discard()
            client.cancel()
            // `fail` closes the microphone and any window with it — see there
            // for why an error is not something to leave an open window behind.
            fail(String(localized: "Connection failed. Please try again."))
            return
        }

        state = .listening
        publish()
        armCap()
    }

    /// The microphone, wired to the bridge once and for all.
    ///
    /// The same object serves every session for as long as it is running,
    /// because what it is wired to never changes: `audio` is the coordinator's
    /// one bridge, and while no session is attached to it the bridge counts
    /// chunks and drops them. That is what makes holding the microphone open
    /// between dictations safe — an open window records nothing, because there
    /// is nowhere for the audio to go.
    private func makeCapture() -> AudioCapture {
        AudioCapture(
            onChunk: { [weak self, audio, reportsLevel] samples, level in
                audio.send(samples)
                guard reportsLevel.isOpen else { return }
                Task { @MainActor in self?.micLevel = level }
            },
            onStatus: { [weak self] status in
                Task { @MainActor in self?.handle(capture: status) }
            })
    }

    /// One relay leg. `feature: "voice_typing"` is the cloud's whitelisted tag
    /// for this flow (the relay attributes meeting | voice_typing | realtime;
    /// anything else is billed unattributed).
    ///
    /// A relay session cannot be resumed, so a reconnect is a new leg with its
    /// own Soniox session — hence the per-leg id prefix and the offset, which
    /// keep the second leg's segments from overwriting the first's.
    private func makeRelay(token: String, leg: Int, timeOffsetMs: UInt64) -> SttRelayClient {
        SttRelayClient(
            options: .init(
                bearerToken: token, feature: "voice_typing",
                idPrefix: leg == 0 ? nil : "mix@\(leg)",
                timeOffsetMs: timeOffsetMs)
        ) { [weak self] event in
            Task { @MainActor in self?.handle(event, from: leg) }
        }
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
                    // Only honor a start here if the mic can actually open.
                    // A background process cannot show the permission prompt —
                    // answering the request anyway published "no microphone
                    // access" for a permission the user had never been asked
                    // for. Staying silent instead lets the keyboard's URL
                    // fallback bring the app forward, where the prompt (or the
                    // Settings guidance) can actually be seen.
                    guard AudioCapture.permission == .granted
                        || UIApplication.shared.applicationState == .active
                    else { return }
                    await self.begin(session: up.session)
                }
            }
        }
    }

    /// Arm the ~30 s linger every time the app leaves the foreground, not only
    /// after a dictation session. The linger used to arm only in
    /// `finishUp`/`fail`, so the most common beat — open Parley, switch to
    /// another app, tap the keyboard's mic — always found this process
    /// suspended and bounced the user through the app, even seconds after they
    /// had it open. Thirty seconds is the platform's ceiling for a background
    /// task; past it the URL round trip is the only way to wake us — which is
    /// the whole reason the microphone window exists, and why this linger is
    /// now only what happens when no window is open.
    private func armLifecycleLinger() {
        let center = NotificationCenter.default
        lifecycleObservers = [
            center.addObserver(
                forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
            ) { [weak self] _ in
                Task { @MainActor in
                    // A live session's audio keeps the process awake already,
                    // and so does an open microphone window — `beginLinger`
                    // declines in both cases; this is only about not asking.
                    guard let self, !self.active, self.window.openedAt == nil else { return }
                    self.beginLinger()
                }
            },
            center.addObserver(
                forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
            ) { [weak self] _ in
                // Foreground needs no assertion; the next backgrounding re-arms.
                Task { @MainActor in self?.endLinger() }
            },
            center.addObserver(
                forName: UIApplication.willTerminateNotification, object: nil, queue: .main
            ) { _ in
                // The microphone goes with the process. Say so on the way out
                // rather than leaving a file claiming an open window: the
                // keyboard's staleness check would get there eventually, but
                // the truth is available right now.
                MainActor.assumeIsolated {
                    DictationChannel.writeWindow(
                        .closed(
                            length: MicWindowLength(
                                rawValue: UserDefaults.standard.string(
                                    forKey: DictationCoordinator.windowLengthKey) ?? "") ?? .off))
                }
            },
        ]
    }

    private func armCap() {
        let limit = maxSeconds
        capTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Double(limit)))
            guard !Task.isCancelled else { return }
            await self?.stop()
        }
    }

    /// The microphone's own state. `AudioCapture` recovers from interruptions
    /// and route changes on its own, so only the give-up case ends the session.
    private func handle(capture status: AudioCapture.Status) {
        guard active else {
            // No session: the microphone is only up because a window is
            // holding it, and a window that cannot be honoured is worse than
            // one that ended early — the user can see the second and cannot
            // see the first. So anything other than "running" ends it, and the
            // next tap goes back to the ordinary trip through Parley, which
            // can open the microphone properly from the foreground.
            switch status {
            case .running, .resumed:
                break
            case .interrupted, .failed:
                Task { await endWindow() }
            }
            return
        }
        switch status {
        case .running, .resumed:
            break
        case .interrupted:
            micLevel = 0
        case .failed(let message):
            fail(String(localized: "Lost the microphone: \(message)"))
        }
    }

    private func handle(_ event: SttRelayEvent, from eventLeg: Int) {
        // A leg that dies slowly can still deliver: ignore anything from a leg
        // this session has already replaced.
        guard eventLeg == leg else { return }
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
            // After `finish()` this is the relay signing off, which is the end
            // of the session. Any other time it is a dropped socket, and the
            // microphone is still open — so redial instead of ending a session
            // the user is still speaking into.
            guard active else { return }
            if finishRequested {
                finishUp()
            } else {
                scheduleReconnect()
            }
        case .error:
            // The message is wire text ("relay error 402: …"), never something
            // to put in front of someone; the reconnect path owns the copy.
            guard active else { return }
            if finishRequested {
                finishUp()
            } else if event.isQuotaExceeded {
                // The one failure a redial cannot fix — the next handshake is
                // refused the same way, so say what actually happened instead
                // of spending the ladder to arrive at "lost the connection".
                foldPartialIn()
                fail(
                    String(
                        localized:
                            "You're out of transcription quota. Dictation works again once it resets."
                    ))
            } else {
                scheduleReconnect()
            }
        }
    }

    // MARK: reconnect

    /// Redial the relay while the microphone keeps running.
    ///
    /// The gap is what this is really about: the bridge holds what is said
    /// while there is no socket and hands it to the next leg, so a five-second
    /// blip costs a pause in the words appearing, not the words. Only when the
    /// ladder runs out does the session end — and it ends holding on to
    /// everything that was already typed.
    private func scheduleReconnect() {
        guard reconnectTask == nil, active, !finishRequested else { return }

        let previous = relay
        relay = nil
        audio.hold()
        previous?.cancel()

        // The tentative tail died with the socket: the relay will never settle
        // it, and its audio was already sent to the leg that is gone. Folding
        // it into the settled text is what `finishUp` does at the end of every
        // session, for the same reason — it is the best record there is of
        // what was said.
        foldPartialIn()
        publish()

        guard let token = KeychainStore.get(AppState.tokenKey) else {
            // The session expired mid-dictation. Redialling would only be
            // refused, and the user needs to be told the actual reason.
            audio.discard()
            fail(String(localized: "Sign in to the Parley app before using the voice keyboard."))
            return
        }
        guard case .retry(let backoff) = Self.reconnect.decide(attempt: reconnectAttempts + 1)
        else {
            endAfterLostConnection()
            return
        }

        reconnectAttempts += 1
        leg += 1
        let nextLeg = leg
        state = .reconnecting
        publish()

        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: backoff)
            guard !Task.isCancelled, let self else { return }
            await self.performReconnect(token: token, leg: nextLeg)
        }
    }

    private func performReconnect(token: String, leg targetLeg: Int) async {
        reconnectTask = nil
        guard leg == targetLeg, active, !finishRequested else { return }
        // The bridge decides the offset: it is what knows where in the session
        // the audio it held was actually spoken.
        guard
            let client = audio.attach({ offsetMs in
                self.makeRelay(token: token, leg: targetLeg, timeOffsetMs: offsetMs)
            })
        else { return }
        relay = client
        do {
            try await client.start()
            guard leg == targetLeg, active, !finishRequested else { return }
            reconnectAttempts = 0
            state = .listening
            publish()
        } catch {
            guard leg == targetLeg else { return }
            audio.hold()
            scheduleReconnect()
        }
    }

    /// Out of redials. End the session rather than leave a microphone running
    /// into nothing.
    ///
    /// The copy used to say the settled words had already been typed. They had,
    /// when the keyboard inserted every delta as it arrived; it now inserts once
    /// at `.done`, and an error is not `.done` — so an ended session leaves the
    /// user's field untouched, and saying otherwise would send them looking for
    /// text that is not there.
    private func endAfterLostConnection() {
        audio.discard()
        fail(
            String(
                localized:
                    "Lost the connection before anything could be typed. Tap the mic to try again."
            ))
    }

    /// Move the tentative tail into the settled text, as a run of its own.
    ///
    /// It has to become a *run*, not just an append to `committed`: `committed`
    /// is rebuilt from `runs` on every segment, so text appended to it directly
    /// would vanish the moment the next leg said anything. The id cannot
    /// collide with a relay's (`mix-N`, `mix@L-N`), and only one tail per leg
    /// is ever folded. Callers publish.
    private func foldPartialIn() {
        guard !partial.isEmpty else { return }
        runs.append((id: "folded@\(leg)", text: partial))
        partial = ""
        committed = runs.map(\.text).joined()
    }

    // MARK: stop / teardown

    func stop() async {
        guard active else { return }
        #if DEBUG
            demoTask?.cancel()
            demoTask = nil
        #endif
        // From here a socket close is the expected end of the stream, not
        // something to redial, and no redial already in flight should land.
        finishRequested = true
        reconnectTask?.cancel()
        reconnectTask = nil
        capTimer?.cancel()
        capTimer = nil
        // Cut the microphone off from the relay *before* draining rather than
        // stopping it: with a window open the microphone keeps running, and
        // what is said after ⏹ must not ride along in the finalize. Discarding
        // also drops anything held for a leg that will never exist; the
        // finalize below drains what actually reached the relay.
        audio.discard()
        reportsLevel.set(false)
        micLevel = 0
        state = .finishing
        publish()
        if let relay {
            await relay.finish()  // drain: the relay flushes the last utterance
        }
        finishUp()  // which hands the microphone to the window, or closes it
    }

    private func finishUp() {
        relay = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        audio.discard()
        reportsLevel.set(false)
        state = .done
        // Fold the last partial into the committed text so nothing said right
        // before the endpoint is dropped from what the keyboard inserts.
        foldPartialIn()
        publish()
        active = false
        // Not `beginLinger()` any more: whether this leaves a ~30 s background
        // task or an open microphone window is `releaseMicrophone`'s decision,
        // and the two must never both be in flight. Reached from the relay
        // signing off as well as from `stop`, hence the Task.
        Task { await releaseMicrophone() }
    }

    private func fail(_ message: String) {
        errorMessage = message
        state = .error
        capTimer?.cancel()
        capTimer = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        let dying = relay
        relay = nil
        audio.discard()
        dying?.cancel()
        let cap = capture
        capture = nil
        reportsLevel.set(false)
        // Detached because `fail` is the sync tail of half a dozen paths and
        // closing the audio session is slow; nothing after this depends on it.
        Task { await cap?.stop() }
        // And the window goes with it. A window is the microphone the user
        // agreed to leave open for a keyboard that works; after being told
        // something went wrong, an indicator they now have no reason to expect
        // is the worst of both — so an error always ends with the microphone
        // visibly off.
        closeWindowState()
        publish()
        active = false
        beginLinger()
    }

    // MARK: the microphone window

    /// The end of a session: hand the microphone to the window the user chose,
    /// or close it.
    ///
    /// This is the replacement for "stop the microphone, then hold a ~30 s
    /// background task and hope the next tap lands inside it". A window keeps
    /// the audio session live, and a live audio session — not a background
    /// task — is what keeps the process resident for minutes rather than
    /// seconds. Idempotent: both `stop` and the relay signing off reach it.
    private func releaseMicrophone() async {
        guard !active else { return }
        if !yieldedToMeeting,
            let opened = MicWindowState.opened(length: windowLength, at: Date()), capture != nil
        {
            openWindow(opened)
            return
        }
        await closeMicrophone()
        beginLinger()
    }

    /// A meeting is about to take the microphone. There is one microphone, so
    /// give it up completely.
    ///
    /// The flag matters because the end of a dictation opens its window from a
    /// detached task: without it, a meeting started in the beat between a
    /// session finishing and that task running would find a second
    /// `AudioCapture` opened underneath it, and the two would rebuild the audio
    /// session out from under each other. Cleared by the next `launch`.
    func yieldMicrophone() async {
        yieldedToMeeting = true
        closeWindowState()
        guard !active else { return }
        await closeMicrophone()
    }

    private func closeMicrophone() async {
        let cap = capture
        capture = nil
        reportsLevel.set(false)
        micLevel = 0
        await cap?.stop()
    }

    /// Start (or restart) the window and the loop that heartbeats and expires
    /// it. The microphone must already be running.
    private func openWindow(_ opened: MicWindowState) {
        // A background task and a window must never overlap: ending a
        // background assertion in the background can suspend a process the
        // audio session was keeping up.
        endLinger()
        windowProblem = nil
        window = opened
        publishWindow()
        windowTask?.cancel()
        windowTask = Task { [weak self] in await self?.runWindow() }
    }

    /// Heartbeat and expiry in one loop.
    ///
    /// The heartbeat is not decoration. The keyboard cannot tell an open window
    /// from the file a killed process left behind except by how fresh the file
    /// is, so a window that stops being re-stamped stops being believed within
    /// `MicWindowState.staleAfter` — see `MicWindowState`. Sleeping the shorter
    /// of a heartbeat and whatever is left is what keeps expiry punctual: a
    /// window sold as five minutes has to end at five minutes, not at the next
    /// heartbeat after it.
    private func runWindow() async {
        while !Task.isCancelled {
            let left = window.remaining()
            guard left > 0 else { break }
            let nap = min(MicWindowState.heartbeat, left)
            try? await Task.sleep(for: .seconds(nap))
            guard !Task.isCancelled else { return }
            guard window.openedAt != nil else { return }
            if window.remaining() <= 0 { break }
            publishWindow()
        }
        guard !Task.isCancelled else { return }
        await endWindow()
    }

    /// End the window, closing the microphone unless a dictation is using it.
    ///
    /// Ending a window during a live session is not a stop: the user asked for
    /// the microphone not to be *held afterwards*, and taking their sentence
    /// away mid-word to honour that would be a strange reading of it. The
    /// session finishes and `releaseMicrophone` then finds no window to open.
    func endWindow() async {
        guard window.openedAt != nil else { return }
        windowTask?.cancel()
        windowTask = nil
        closeWindowState()
        guard !active else { return }
        await closeMicrophone()
        beginLinger()
    }

    private func closeWindowState() {
        windowTask?.cancel()
        windowTask = nil
        window = .closed(length: windowLength)
        publishWindow()
    }

    /// The user chose a window length in Settings.
    ///
    /// Turning one on opens it immediately rather than at the end of the next
    /// dictation. That is the point: the cost of this setting is a microphone
    /// indicator, and the moment to show someone an indicator is the moment
    /// they agree to it — with the row right there to end it again.
    func setWindowLength(_ length: MicWindowLength) async {
        UserDefaults.standard.set(length.rawValue, forKey: Self.windowLengthKey)
        windowProblem = nil
        guard length != .off else {
            await endWindow()
            window.length = .off
            publishWindow()
            return
        }
        // A running session will open the window itself when it ends.
        guard !active else {
            window.length = length
            publishWindow()
            return
        }
        await beginWindowFromForeground(length: length)
    }

    /// Open a window on demand, opening the microphone if it is not already.
    ///
    /// Foreground only, and not out of caution: iOS refuses to let a
    /// backgrounded process *start* recording at all. A window can only ever be
    /// born in the foreground — after that it survives backgrounding because
    /// the session it is holding was activated while the app was up.
    private func beginWindowFromForeground(length: MicWindowLength) async {
        guard UIApplication.shared.applicationState == .active else {
            window.length = length
            publishWindow()
            return
        }
        if capture == nil {
            switch AudioCapture.permission {
            case .granted:
                break
            case .denied:
                windowProblem = String(
                    localized: "Parley needs microphone access. Turn it on in Settings › Parley.")
                window = .closed(length: length)
                publishWindow()
                return
            default:
                let granted = await AudioCapture.requestPermission()
                AppState.publishKeyboardReadiness()
                guard granted else {
                    windowProblem = String(
                        localized: "Microphone access wasn't granted, so there is no window to keep open.")
                    window = .closed(length: length)
                    publishWindow()
                    return
                }
            }
            let fresh = makeCapture()
            do {
                try await fresh.start()
                capture = fresh
            } catch {
                windowProblem = String(localized: "Couldn't open the microphone.")
                window = .closed(length: length)
                publishWindow()
                return
            }
        }
        guard let opened = MicWindowState.opened(length: length, at: Date()) else { return }
        openWindow(opened)
    }

    /// The keyboard's "end now". A timestamp rather than a flag, so neither
    /// side has to clear anything and a stale request cannot refuse to let the
    /// next window open — see `MicWindowState.closeApplies(requestedAt:)`.
    private func armWindowControlObserver() {
        windowControlObserver = DarwinObserver(DictationChannel.windowControlNote) {
            [weak self] in
            Task { @MainActor in
                guard let self,
                    self.window.closeApplies(
                        requestedAt: DictationChannel.readWindowControl()?.closeRequestedAt)
                else { return }
                await self.endWindow()
            }
        }
    }

    /// Mirror the window into the App Group, re-stamping the local copy with
    /// the same beat so the app's own reading of `isOpen` cannot go stale while
    /// the app is very much alive.
    private func publishWindow() {
        window.updatedAt = Date()
        DictationChannel.writeWindow(window)
    }

    // MARK: background linger

    /// With the audio session closed the system suspends this process within
    /// seconds, and a suspended process can't hear the keyboard's next start
    /// note — the user would get bounced through the app again. ~30 s of
    /// background-task time covers the common "stop, think, dictate again"
    /// beat with no app switch.
    private func beginLinger() {
        // Never alongside a window. The window's audio session is what is
        // holding the process up; a background assertion added on top buys
        // nothing and its expiry is a documented way to get suspended anyway.
        guard window.openedAt == nil else { return }
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

/// A boolean the audio thread may read on every chunk.
///
/// The microphone level is the one thing the capture callback reports that only
/// matters while a screen is watching. With a microphone window open the
/// callback runs a dozen times a second for up to an hour with nothing on
/// screen at all, and each report is a hop to the main actor — a background
/// wakeup a minute is a battery line item, not a rounding error. So the hop is
/// gated by a flag cheap enough to read from the audio thread.
private final class LevelGate: @unchecked Sendable {
    private let lock = NSLock()
    private var open = false

    var isOpen: Bool {
        lock.lock()
        defer { lock.unlock() }
        return open
    }

    func set(_ value: Bool) {
        lock.lock()
        open = value
        lock.unlock()
    }
}
