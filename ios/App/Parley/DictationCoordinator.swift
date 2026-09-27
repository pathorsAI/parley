import Foundation
import ParleyKit
import SwiftUI
import UIKit
import os

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
/// the user already is instead of throwing them into Parley. A window never
/// starts; it continues.
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
    /// The host app we are bouncing back to. Set optimistically the moment the
    /// jump is attempted and cleared again if it does not land, so this is the
    /// single thing the dictation screen reads to choose between "taking you
    /// back" and the manual "swipe to go back" guidance. `nil` covers all four
    /// ways there is nothing to return to: no host id, the remote kill switch,
    /// this device having given up on this OS build, and an attempt that
    /// failed. See `HostReturnPolicy`.
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
    /// When the running session began, for the clock on the Live Activity.
    ///
    /// A stored property rather than something read off the existing state
    /// because none of it carries a time. `state` is an enum, the downlink is
    /// re-stamped on every transcript change rather than at the start, and the
    /// window's `openedAt` is the microphone's clock, not the session's — a
    /// second dictation inside one window would inherit the first one's start
    /// and put a card on the lock screen claiming to have been listening for
    /// minutes. Set once in `launch()`, never cleared: what makes it stop
    /// counting is `state.isLive` going false, which is the same predicate the
    /// keyboard reads, and a resumed `micTaken` session deliberately picks the
    /// original start back up rather than restarting the clock.
    private var sessionStartedAt: Date?
    /// Which door the running session came in through, and the app it was
    /// dictating into when the keyboard could tell — both only for the entry
    /// `recordHistory()` keeps. Set by the entry point before `launch()`.
    private var sessionSource: DictationHistoryEntry.Source = .keyboard
    private var sessionHost: String?
    /// This session's transcript is already in the history. One session ends
    /// once, but it has three endings that keep it (`settle`, `fail`,
    /// `endSessionWithMicTaken`) and nothing else stops a late `fail` from
    /// keeping it twice.
    private var historyRecorded = false
    /// The microphone. Not a session's: once the user has chosen a window it
    /// outlives the dictation that opened it, and the *next* dictation borrows
    /// it rather than opening its own. That is the entire mechanism — see the
    /// microphone-window section below.
    private var capture: AudioCapture?
    private var opening: Task<AudioCapture?, Never>?
    private var relay: SttRelayClient?
    /// Bumped for every `AudioCapture` this object opens. Statuses carry the
    /// capture they came from, for exactly the reason relay events carry their
    /// leg (see `handle(_:from:)`): a status is a hop to the main actor, and a
    /// backgrounded process does not run main-actor work until it is resumed. So
    /// the `.lost` a capture published while giving up in the background can be
    /// delivered *after* the user's next tap has brought the app forward and
    /// opened a fresh microphone — and `handle(capture:)` had no way to tell, so
    /// it killed the new session and closed the new window on the strength of the
    /// old one's obituary. That is the shape the founder's report takes once the
    /// microphone is gone: tap, get thrown into Parley, "lost the microphone",
    /// repeat.
    private var captureGeneration = 0
    /// The system holds the microphone for the session that is running — its own
    /// dictation, Siri, a call — and `AudioCapture` is trying to take it back.
    ///
    /// While it is set the session publishes `micTaken` whatever else happens. A
    /// relay redial in particular must not win: its copy asks the user to keep
    /// talking, which is the one instruction that cannot be true when the
    /// microphone is the thing that is gone.
    private var micTaken = false
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
    private var holdTask: Task<Void, Never>?
    private static let holdAfterDictation: Duration = .seconds(30)
    /// A meeting recording has taken the microphone (see `yieldMicrophone`).
    private var yieldedToMeeting = false
    /// Whether the microphone's level is still worth reporting. Read on the
    /// audio thread for every chunk, so it cannot be main-actor state: while a
    /// window is open with no session, the microphone runs for up to an hour
    /// with nothing on screen to show a level to, and hopping to the main actor
    /// a dozen times a second to set a number nobody reads is exactly the kind
    /// of background wakeup that shows up as battery.
    ///
    /// The same gate now decides whether the *keyboard* is told (see
    /// `publishKeyboardLevel`), and the reasoning carries across unchanged —
    /// with the bill larger rather than smaller, because a keyboard reading is
    /// a file write and a Darwin post on top of the hop. The keyboard's record
    /// button only swells while a session is live; while a window is open with
    /// no session there is nothing on either screen for a level to move.
    private let reportsLevel = LevelGate()
    /// When the keyboard's level mailbox was last written, so the throttle in
    /// `publishKeyboardLevel` has something to measure against.
    private var levelPublishedAt = Date.distantPast
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
    ///
    /// The number itself is `MicActivityPolicy.dictationLimit` rather than a
    /// literal here, because the Live Activity needs it as well: its clock is a
    /// `Text(timerInterval:)`, which reserves the width of the widest value its
    /// range can reach, so the card has to be told where this session ends or
    /// it lays out for eight hours. Written up where the constant is.
    private let maxSeconds: TimeInterval = MicActivityPolicy.dictationLimit

    /// Dictation redials faster and gives up sooner than a meeting does:
    /// someone is standing there mid-sentence, and the whole session is capped
    /// at two minutes. `ReconnectPolicy.dictation` is that ladder.
    private static let reconnect = ReconnectPolicy.dictation

    /// Where the chosen window length lives. `AppState` binds a picker to the
    /// same key; the coordinator reads it directly because it has to know the
    /// answer in the background, long after any view is gone.
    nonisolated static let windowLengthKey = "micWindowLength"

    /// Where the "Polish with AI" switch lives. Read straight out of
    /// `UserDefaults` for the same reason `windowLengthKey` is: a session can
    /// end with the app in the background and no view alive to have bound it.
    nonisolated static let polishKey = "dictationPolishEnabled"

    var windowLength: MicWindowLength {
        MicWindowLength(
            rawValue: UserDefaults.standard.string(forKey: Self.windowLengthKey) ?? "") ?? .off
    }

    /// On unless the user turned it off. "Never touched" is not "off": the
    /// pass is what makes dictated text read like writing instead of like
    /// speech, and its every failure mode is "keep the raw words" — so the
    /// absent key defaults to true rather than to the `bool(forKey:)` false.
    var polishEnabled: Bool {
        guard UserDefaults.standard.object(forKey: Self.polishKey) != nil else { return true }
        return UserDefaults.standard.bool(forKey: Self.polishKey)
    }

    /// The coordinator's own cloud client. `AppState`'s is not reachable from
    /// here — a session can end in the background, long after any view that
    /// held one — and both read the same Keychain token, so a second client
    /// costs nothing and owns nothing.
    private lazy var cloud = CloudClient { KeychainStore.get(AppState.tokenKey) }

    /// How long the cleanup pass may hold the finished transcript.
    ///
    /// This is the user's foreground wait: they have stopped speaking and are
    /// watching the field where the words are about to land. The raw words are
    /// ready the whole time, so everything past this budget is time spent on a
    /// nicety nobody asked to wait for — short enough to read as a beat, not as
    /// a hang, and the raw transcript is what ships when it runs out.
    private nonisolated static let polishBudget = Duration.seconds(6)

    private init() {
        window = .closed(length: MicWindowLength(
            rawValue: UserDefaults.standard.string(forKey: Self.windowLengthKey) ?? "") ?? .off)
        // Before anything else can start a session: a live-state downlink at
        // this point belongs to a process that is no longer running.
        reapOrphanedSession()
        armRequestObserver()
        armWindowControlObserver()
        armLifecycleLinger()
        armPresence()
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
        let owner = leg
        if active { await stop() }
        guard leg == owner else { return }
        self.session = session

        let host = DictationChannel.readUplink()?.hostBundleID
        sessionSource = .keyboard
        sessionHost = host
        await launch()

        // Only try the jump-back when the host resolved, the policy allows it
        // on this device today, AND the app actually came forward (the URL
        // path). A session started over the Darwin channel never left the host
        // app, so there is nothing to return from.
        guard let host, state == .listening,
            UIApplication.shared.applicationState == .active,
            HostReturn.decide(host: host).isAttempt
        else {
            returnableHost = nil
            return
        }

        // Optimistic, then honest. The screen says "taking you back" while the
        // launch is in flight, and takes it back if the launch does not land —
        // stranding someone on a promise is the one outcome worse than asking
        // them to swipe. `attemptAndVerify` also writes the outcome to
        // `HostReturnLedger`, which is what stops a device that genuinely
        // cannot do this from paying the grace period on every dictation.
        //
        // On success we are in the background from here; the audio session
        // keeps the mic alive (UIBackgroundModes: audio).
        returnableHost = host
        if await HostReturn.attemptAndVerify(bundleID: host) == false {
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
        sessionSource = .actionButton
        sessionHost = nil
        await launch()
    }

    // MARK: engine

    private func launch() async {
        endLinger()  // the live audio session keeps the process awake from here
        holdTask?.cancel()
        holdTask = nil
        reportsLevel.set(true)
        yieldedToMeeting = false
        errorMessage = nil
        runs = []
        committed = ""
        partial = ""
        sessionStartedAt = Date()
        historyRecorded = false
        state = .starting
        micTaken = false
        active = true
        // Bumped, never reset — the same shape as `captureGeneration`, and for
        // the same reason. A leg number that restarted at zero every session
        // made the `eventLeg == leg` guard in `handle(_:from:)` blind to the
        // only case it could not see: an event from the *previous* session's
        // first leg, which had the same number as this one's. `finishUp` drops
        // the relay without cancelling it, so that socket is still alive and
        // still holding a closure that will publish `.closed` whenever the
        // relay eventually idles it out — and a backgrounded process runs no
        // main-actor work until something resumes it, which is the next
        // `parley://dictate`. So the stale obituary was routinely delivered
        // *into* the session that had just replaced it, and `handle` read it as
        // this session's socket dying: `scheduleReconnect()` then cancelled the
        // new client, which is "Connection failed. Please try again." when it
        // lands during `start()`, and a pane listening to a socket that no
        // longer exists when it lands after.
        leg += 1
        let owner = leg
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
            guard owns(owner) else { return }
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

        let client = makeRelay(token: token, leg: leg, timeOffsetMs: 0)
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
        let microphone = await openMicrophone()
        guard owns(owner) else {
            // An ending that ran during the open found no capture to release;
            // this one is nobody's.
            if !active { await closeMicrophone() }
            return
        }
        guard microphone != nil else {
            client.cancel()
            relay = nil
            audio.discard()
            // The realistic cause is iOS refusing a backgrounded process the
            // microphone. `fail` closes the window too, so the keyboard's pane
            // goes back to promising a trip through Parley, where the
            // microphone can be opened from the foreground.
            fail(
                UIApplication.shared.applicationState == .active
                    ? String(localized: "Couldn't open the microphone.")
                    : String(
                        localized:
                            "Couldn't open the microphone. Open Parley and tap the mic again."
                    ))
            return
        }

        do {
            try await client.start()
        } catch {
            client.cancel()
            guard owns(owner) else { return }
            relay = nil
            audio.discard()
            // `fail` closes the microphone and any window with it — see there
            // for why an error is not something to leave an open window behind.
            fail(String(localized: "Connection failed. Please try again."))
            return
        }
        guard owns(owner) else { return }

        publishLive(.listening)
        armCap()
    }

    /// Whether the session that read `owner` off `leg` is still the one
    /// running. Every continuation in this object that resumes after an
    /// `await` checks it before touching shared state; a relay event checks
    /// its leg the same way.
    private func owns(_ owner: Int) -> Bool {
        leg == owner && active
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
        captureGeneration += 1
        let generation = captureGeneration
        return AudioCapture(
            onChunk: { [weak self, audio, reportsLevel] samples, level in
                audio.send(samples)
                guard reportsLevel.isOpen else { return }
                // One measurement, two readers. `level` is the RMS this chunk
                // already computed for the dictation screen's meter; the
                // keyboard gets the same number normalised, and nothing here
                // measures the audio a second time.
                //
                // Published from the main-actor hop rather than from this
                // audio-thread callback, and that is not tidiness: writing a
                // file from an `AVAudioEngine` tap is exactly the kind of
                // blocking work that costs dropped buffers. The hop is one the
                // in-app meter already pays for, so the keyboard's mailbox
                // costs no extra wake-up — only the write, which
                // `publishKeyboardLevel` rations.
                Task { @MainActor in
                    self?.micLevel = level
                    self?.publishKeyboardLevel(.init(rms: level))
                }
            },
            onStatus: { [weak self] status in
                Task { @MainActor in self?.handle(capture: status, from: generation) }
            })
    }

    // MARK: the keyboard's level meter

    /// Hand the keyboard a microphone level, at most `publishInterval` apart.
    ///
    /// The throttle is here rather than inside `DictationChannel` because it
    /// has to be suspendable: `force` is how the end of a session writes its
    /// one final silence, and that write is the whole guarantee that a record
    /// button is never left mid-swell. A rate limiter that swallowed it would
    /// turn the guarantee into a race with `MicLevelReading.staleAfter`.
    ///
    /// **Silence is written once and then left to go stale.** Someone pausing
    /// mid-sentence is the common case, not the exception, and there is no
    /// reason to spend twelve writes a second saying nothing is happening: a
    /// stale reading and a fresh silent one draw the same flat button (see
    /// `MicLevelReading.current(at:)`), so stopping is not a shortcut, it is
    /// the same answer for free. Writing resumes on the first chunk that is
    /// loud enough to say something new.
    private func publishKeyboardLevel(_ reading: MicLevelReading, force: Bool = false) {
        if !force {
            let now = Date()
            guard now.timeIntervalSince(levelPublishedAt) >= MicLevelReading.publishInterval,
                !reading.isSilent
            else { return }
            levelPublishedAt = now
        } else {
            levelPublishedAt = Date()
        }
        DictationChannel.writeMicLevel(reading)
    }

    /// Both meters to rest — the dictation screen's and the keyboard's.
    ///
    /// The keyboard's write is unconditional: it is the last thing the mailbox
    /// will say until someone speaks again, and it has to be true the instant
    /// it lands rather than `staleAfter` later.
    private func restLevel() {
        micLevel = 0
        publishKeyboardLevel(.silent, force: true)
    }

    /// Stop measuring for anybody, and leave both meters flat.
    ///
    /// Every ending calls this — ⏹, ✕, an error, the cap, the microphone being
    /// taken, the window closing — because every ending is a moment where the
    /// alternative is a level that stops moving without ever saying why.
    private func stopReportingLevel() {
        reportsLevel.set(false)
        restLevel()
    }

    /// One relay leg. `feature: "voice_typing"` is the cloud's whitelisted tag
    /// for this flow (the relay attributes meeting | voice_typing | realtime;
    /// anything else is billed unattributed).
    ///
    /// A relay session cannot be resumed, so a reconnect is a new leg with its
    /// own Soniox session — hence the per-leg id prefix and the offset, which
    /// keep the second leg's segments from overwriting the first's.
    ///
    /// Every leg is prefixed, including the first. It used to be
    /// `leg == 0 ? nil : …`, which was only ever an economy — leg 0 had nothing
    /// to collide with, so it saved a few bytes per id. That stopped being true
    /// when `leg` became monotonic across sessions (see `launch`): there is no
    /// leg 0 any more, and a conditional whose condition can no longer hold is
    /// worse than no conditional. `runs` is emptied per session and keyed by
    /// id, `SegmentBuilder` files the tail under `"\(source)-tail"` whatever the
    /// prefix, and nothing outside this object reads the shape of a dictation
    /// segment id — so the format is this file's to choose.
    private func makeRelay(token: String, leg: Int, timeOffsetMs: UInt64) -> SttRelayClient {
        SttRelayClient(
            options: .init(
                bearerToken: token, feature: "voice_typing",
                idPrefix: "mix@\(leg)",
                timeOffsetMs: timeOffsetMs)
        ) { [weak self] event in
            Task { @MainActor in self?.handle(event, from: leg) }
        }
    }

    /// The uplink channel, listened to for the process's whole life:
    ///   - stop: the keyboard's ⏹ for the running session, or its ✕ — the same
    ///     request with `wantsCancel` set, which ends the session without
    ///     delivering anything.
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
                    guard self.active, up.session == self.session else { return }
                    // ✕ before ⏹: a cancel is written as both, so that an
                    // uplink this app only half understands still ends the
                    // session rather than leaving a microphone open.
                    if up.wantsCancel {
                        await self.cancel()
                    } else {
                        await self.stop()
                    }
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
                    if !self.canServeInPlace {
                        // Ahead of `begin`, so a refusal leaves the request
                        // unanswered and the keyboard's URL fallback brings the
                        // app forward, instead of `launch` publishing a failure.
                        guard await self.openMicrophone() != nil else { return }
                    }
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
                    guard let self else { return }
                    // What a tap would get just changed: the foreground is
                    // gone, and only a running microphone can now answer in
                    // place. Say so before the next heartbeat would.
                    self.publishPresence()
                    // A live session's audio keeps the process awake already,
                    // and so does an open microphone window — `beginLinger`
                    // declines in both cases; this is only about not asking.
                    guard !self.active, self.window.openedAt == nil else { return }
                    self.beginLinger()
                }
            },
            center.addObserver(
                forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
            ) { [weak self] _ in
                Task { @MainActor in
                    // Foreground needs no assertion; the next backgrounding
                    // re-arms.
                    self?.endLinger()
                    // The heartbeat loop may have been frozen mid-sleep for
                    // however long the process was suspended; a keyboard that
                    // is up right now (this app's own, say) should not wait
                    // out the remainder to learn the app is back.
                    self?.publishPresence()
                }
            },
            center.addObserver(
                forName: UIApplication.willTerminateNotification, object: nil, queue: .main
            ) { _ in
                // The microphone goes with the process. Say so on the way out
                // rather than leaving a file claiming an open window: the
                // keyboard's staleness check would get there eventually, but
                // the truth is available right now. The same goes for the
                // process itself.
                MainActor.assumeIsolated {
                    DictationChannel.writeWindow(
                        .closed(
                            length: MicWindowLength(
                                rawValue: UserDefaults.standard.string(
                                    forKey: DictationCoordinator.windowLengthKey) ?? "") ?? .off))
                    DictationChannel.writePresence(.gone)
                }
            },
        ]
    }

    private func armCap() {
        let limit = maxSeconds
        capTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(limit))
            guard !Task.isCancelled else { return }
            await self?.stop()
        }
    }

    /// The microphone's own state. `AudioCapture` recovers from interruptions and
    /// route changes on its own, so the interesting cases are the two the user
    /// has to be told about: the microphone being gone, and it coming back.
    ///
    /// `generation` is which capture is speaking — see `captureGeneration`. A
    /// status from a capture this object has already replaced says nothing about
    /// the microphone it is holding now, and acting on one is how a fresh session
    /// used to be killed by its predecessor's obituary.
    private func handle(capture status: AudioCapture.Status, from generation: Int) {
        guard generation == captureGeneration else { return }
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
            case .interrupted, .lost:
                Task { await endWindow() }
            }
            return
        }
        switch status {
        case .running:
            break
        case .resumed:
            // The microphone is back and the transcript picks up where it
            // stopped: `runs` and `committed` were never touched, the relay leg
            // is whatever it was, and the state goes back to what it would have
            // been. This is the whole point of not ending the session on an
            // interruption — a system dictation the user cancelled after two
            // seconds costs two seconds of a pane that said so.
            micTaken = false
            // Only back to a state this handler took away. A session that has
            // moved on to `finishing` is draining a relay the user asked to
            // drain, and a microphone coming back is no reason to reopen it.
            guard state == .micTaken else { break }
            if relay == nil, !finishRequested {
                // The socket died while the microphone was gone and the redial
                // was deliberately not spent then (see `scheduleReconnect`).
                // Now there is something to send again, so it is worth a leg.
                reconnectAttempts = 0
                scheduleReconnect()
            } else {
                publishLive(.listening)
            }
        case .interrupted:
            restLevel()
            micTaken = true
            // The window goes now rather than when the recovery gives up. It is
            // a promise that the *next* tap will be served in place, and the
            // moment the microphone is gone that promise is false — the keyboard
            // renders it as a ready-microphone chip and as "Tap to speak", and
            // both would be inviting the user to talk into nothing.
            closeWindowState()
            publishPresence()
            guard state.isLive, state != .finishing else { break }
            publishLive(.listening)
        case .lost(let loss):
            // The drain owns an ending it has already started: it publishes
            // `done` with whatever the relay flushed, and `releaseMicrophone`
            // then finds a capture that is not capturing and closes it. Stepping
            // in here would replace a transcript about to be typed with a notice
            // about the microphone.
            guard state != .finishing else { break }
            switch loss {
            case .takenBySystem:
                // Deliberately not `fail`: nothing is broken, so the copy is not
                // red, and what the user needs is not an explanation but a way
                // back in. `micTaken` is the state that says so, and the tap that
                // leaves it goes through the ordinary start path — which opens a
                // brand-new capture in the foreground, where iOS allows one.
                endSessionWithMicTaken()
            case .broken(let message):
                // The audio stack itself refused, rather than somebody else
                // holding the input. Name it: "tap to restart" would be advice
                // that cannot work.
                fail(String(localized: "Lost the microphone: \(message)"))
            }
        }
    }

    /// The microphone is gone and the recovery has run out of ways to get it
    /// back. End the session, keep every word it heard visible in the keyboard's
    /// echo, and leave the pane in the one state that is both honest and
    /// tappable.
    ///
    /// Close kin to `fail`, and separate on purpose: `fail` is red copy about
    /// something that went wrong, and it is the path that sets `errorMessage`,
    /// which the keyboard renders in the recording red. Being interrupted by the
    /// system is not a fault — it is the user having used their phone — so it
    /// gets a state of its own instead of a paragraph of apology.
    private func endSessionWithMicTaken() {
        capTimer?.cancel()
        capTimer = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        let dying = relay
        relay = nil
        audio.discard()
        dying?.cancel()
        // The tail the relay will never settle is still the best record of what
        // was said before the microphone went — the same reason `finishUp` folds
        // it in. Nothing is inserted from this state, so it only ever shows up
        // in the keyboard's echo.
        foldPartialIn()
        let cap = capture
        capture = nil
        stopReportingLevel()
        // Detached for the same reason `fail` does it: closing an audio session
        // is slow and nothing below depends on it. It really does close now — a
        // capture that had given up used to make `stop()` a no-op, which left
        // the session un-deactivated and the music it interrupted paused.
        Task { await cap?.stop() }
        closeWindowState()
        errorMessage = nil
        micTaken = false
        state = .micTaken
        publish()
        // Nothing is inserted from `micTaken`, so like `fail` this is a session
        // whose words would otherwise exist nowhere.
        recordHistory()
        active = false
        // The answer to "will the next tap stay put" just became no, and the
        // keyboard draws that answer on the record button. Said now rather than
        // at the next heartbeat, so the glyph and the notice agree from the
        // moment the notice appears.
        publishPresence()
        beginLinger()
    }

    /// Publish a live state, with the microphone having the last word.
    ///
    /// Every `listening` / `reconnecting` transition goes through here so that
    /// none of them can quietly contradict a microphone that is not there. The
    /// relay's ladder is the one that would: a socket dying during an
    /// interruption is ordinary, and `reconnecting` tells the user to keep
    /// talking.
    private func publishLive(_ candidate: DictationChannel.Downlink.State) {
        state = micTaken ? .micTaken : candidate
        publish()
    }

    private func handle(_ event: SttRelayEvent, from eventLeg: Int) {
        // A leg that dies slowly can still deliver: ignore anything from a leg
        // this session has already replaced.
        guard eventLeg == leg else { return }
        switch event {
        case .segment(let seg):
            // Same rule the two ending branches below already follow: a session
            // that is over does not grow. It matters most for ✕ — a segment
            // landing from a socket that is still dying would put the discarded
            // words straight back into a `cancelled` downlink — and the drain
            // after ⏹ is unaffected, because a session stays `active` until
            // `finishUp` runs.
            guard active else { return }
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

        // Nothing to redial *into* while the system holds the microphone. A leg
        // costs a handshake and a billing session, the bridge has nothing to hand
        // it, and spending the four-rung ladder here would end the session in
        // seconds with "lost the connection" copy over what is really a
        // microphone somebody else is using. The capture's own recovery owns this
        // stretch and redials on `.resumed` — see `handle(capture:from:)`.
        guard !micTaken else { return }

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
        publishLive(.reconnecting)

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
            publishLive(.listening)
        } catch {
            guard leg == targetLeg, active, !finishRequested else { return }
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

    /// Rewrite the finished transcript through the user's personal dictionary,
    /// so the keyboard types the words they actually use (see `LexiconStore`).
    ///
    /// **Once, at the fold, and never mid-session.** While a sentence is still
    /// arriving the relay keeps revising it, so a correction applied to
    /// half-settled words would be applied to text that then changes underneath
    /// it — and the keyboard would have typed the uncorrected version anyway.
    /// The fold is the first moment the transcript is finished and the last
    /// moment before the keyboard reads it.
    ///
    /// **And only the part the keyboard has not typed yet.** The boundary is
    /// `Uplink.insertedCount`, the plain character count the keyboard keeps of
    /// what it has already put in the document. Rewriting text that is already
    /// there would move that count out from under it and splice the next
    /// insertion in at the wrong offset — a correction bought at the price of
    /// mangling the sentence around it. Since #312 the keyboard inserts once,
    /// at `done`, so in practice the count is zero and the whole transcript
    /// goes through the dictionary; the boundary stays because it is what makes
    /// that safe rather than merely true right now.
    ///
    /// This is the last write to `committed`: the relay leg is finished and
    /// detached by the time `finishUp` runs, so no further segment can rebuild
    /// it from `runs`.
    private func applyLexicon() {
        guard !committed.isEmpty else { return }
        let typed = DictationChannel.readUplink().map {
            $0.session == session ? $0.insertedCount : 0
        } ?? 0
        let boundary = min(max(typed, 0), committed.count)
        let tail = String(committed.dropFirst(boundary))
        guard !tail.isEmpty else { return }
        committed = String(committed.prefix(boundary)) + LexiconStore.apply(to: tail)
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
        stopReportingLevel()
        state = .finishing
        publish()
        let owner = leg
        if let relay {
            await relay.finish()
        }
        guard owns(owner) else { return }
        finishUp()  // which hands the microphone to the window, or closes it
    }

    /// The keyboard's ✕: end the session and throw away everything it heard.
    ///
    /// Deliberately not `stop()` with the transcript blanked afterwards. `stop`
    /// is the *delivery* path — it drains the relay for the last utterance,
    /// folds the partial in, and spends a cloud round trip polishing text that
    /// is about to be inserted. None of that is work anyone wants done to words
    /// they have just decided to throw away, and the drain in particular is a
    /// network wait standing between the user's finger and a microphone going
    /// quiet. So the relay is cut rather than finished, and the session ends
    /// with `cancelled` — a terminal state the keyboard never inserts from.
    ///
    /// Not `fail()` either: nothing went wrong, so this keeps the microphone
    /// window the user chose (`releaseMicrophone` decides) instead of closing
    /// it the way an error does. The next tap is still served in place.
    func cancel() async {
        guard active else { return }
        #if DEBUG
            demoTask?.cancel()
            demoTask = nil
        #endif
        // Same as `stop`: from here a closing socket is expected, and no redial
        // already in flight should land.
        finishRequested = true
        reconnectTask?.cancel()
        reconnectTask = nil
        capTimer?.cancel()
        capTimer = nil
        audio.discard()
        stopReportingLevel()
        let dying = relay
        relay = nil
        dying?.cancel()
        // Cleared before publishing, so the file the keyboard reads never
        // carries the discarded words at all — `cancelled` with a transcript
        // still in it would be a downlink whose two halves disagree.
        runs = []
        committed = ""
        partial = ""
        errorMessage = nil
        micTaken = false
        state = .cancelled
        publish()
        // In this order, and for the same reason `finishUp` uses it:
        // `releaseMicrophone` declines to act while the session still looks
        // live, and it is what arms either the window or the ~30 s linger.
        active = false
        Task { await releaseMicrophone() }
    }

    private func finishUp() {
        // One session ends once. The relay signing off lands here while `stop`
        // is still awaiting the drain that provoked it, and then `stop`'s own
        // tail arrives — everything below used to be idempotent enough not to
        // care, but a network round trip is not, and the second caller must not
        // start a second one.
        guard active else { return }
        // Closed, not merely dropped. `finish()` sends the finalize frame and
        // then deliberately leaves the socket open for the drain — but it also
        // cancels the keepalive and the liveness watchdog, so once the drain is
        // in, nothing here is keeping that connection alive and nothing is
        // killing it either. Every successful dictation used to leave one for
        // the relay to idle out at its leisure, which is a connection per ⏹ on
        // an account that may well be metered on them. This was the only ending
        // that did it: `fail`, `cancel` and `endSessionWithMicTaken` all cancel.
        //
        // It does not fix the cross-session leak on its own — `readLoop`'s catch
        // publishes `.closed` for a deliberate teardown exactly as it does for a
        // dead peer, so cancelling changes when the stale event is emitted, not
        // whether. The monotonic `leg` in `launch` is what makes it harmless.
        let finished = relay
        relay = nil
        finished?.cancel()
        reconnectTask?.cancel()
        reconnectTask = nil
        audio.discard()
        micTaken = false
        stopReportingLevel()
        // Fold the last partial into the committed text so nothing said right
        // before the endpoint is dropped from what the keyboard inserts.
        foldPartialIn()

        guard wantsPolish() else {
            settle()
            // Not `beginLinger()` any more: whether this leaves a ~30 s
            // background task or an open microphone window is
            // `releaseMicrophone`'s decision, and the two must never both be in
            // flight. Reached from the relay signing off as well as from
            // `stop`, hence the Task.
            Task { await releaseMicrophone() }
            return
        }

        // The cleanup pass runs *before* `done`, not after it, because `done`
        // is the keyboard's one and only cue to insert: it stopped typing
        // deltas in 1.5 and now pastes the whole transcript once, when this
        // state arrives. So the session simply stays `finishing` a moment
        // longer, and the text that eventually ships with `done` already is the
        // final text — no second insertion, no swap under the cursor, and not a
        // byte of the wire protocol changes. Publishing here keeps `updatedAt`
        // fresh so the keyboard's adoption window cannot age out mid-request.
        publish()
        // The session is over as far as this app's own UI is concerned, and
        // `releaseMicrophone` declines to act while it thinks otherwise. It
        // goes first on purpose: an HTTP call needs no microphone, and what
        // releasing arms — the window, or the ~30 s linger — is exactly what
        // keeps this process resident long enough to finish one.
        active = false
        Task { await releaseMicrophone() }

        let raw = committed
        let target = session
        let client = cloud
        // The dictionary rides along so the model cannot "fix" the corrections
        // the user made by hand; `applyLexicon` then has the last word anyway.
        let terms = LexiconStore.recognitionTerms()
        Task {
            let polished = await Self.polished(raw: raw, cloud: client, terms: terms)
            // A new session, or a `fail`, may have landed while the request was
            // out. Either way this is no longer the transcript the keyboard is
            // waiting for, and publishing it now would be publishing over
            // somebody else's.
            guard self.session == target, self.state == .finishing else { return }
            self.committed = polished ?? raw
            self.settle()
        }
    }

    /// Whether the finished transcript is worth a trip to the cloud.
    private func wantsPolish() -> Bool {
        #if DEBUG
            // ScreenshotDemo runs with no account and no network by design —
            // the whole flow has to be capturable without either — so its
            // sessions keep the plain synchronous ending.
            if ScreenshotDemo.isActive { return false }
        #endif
        guard polishEnabled else { return false }
        // The keyboard only reaches a signed-in app, but a session can have
        // expired mid-dictation. No token, no request; the raw words stand.
        guard KeychainStore.get(AppState.tokenKey) != nil else { return false }
        return TranscriptPolisher.shouldPolish(committed)
    }

    /// The last beat of a session: hand the finished text to the keyboard as
    /// `done`, which is its cue to insert.
    private func settle() {
        state = .done
        // After the polish, never before. The dictionary holds corrections the
        // user made by hand, and a model that undid one of them has to lose to
        // the person who typed it.
        applyLexicon()
        publish()
        // After the lexicon and after the publish: what is kept is exactly the
        // text the keyboard was just handed, and the keyboard is not kept
        // waiting on a file write to get it.
        recordHistory()
        active = false
        // No haptic here, deliberately. `done` is not delivery — it is this
        // process saying the text is *ready* — and the transcript is only ever
        // handed to anyone by the keyboard's one `insertText` (see
        // `KeyboardViewController.drainDownlink`). That holds for both entry
        // points: `DictationView` is a hand-off screen that shows no transcript
        // and has no stop control, and `StartDictationIntent` is delivered by
        // "whatever Parley keyboard is frontmost" too. So the success pattern
        // belongs to the keyboard process, which is also the one the user is
        // actually holding — this one is usually in the background by now, and
        // iOS drops haptics from a background app.
    }

    /// The cleanup pass with a deadline on it. Every way this can go wrong — a
    /// timeout, no network, an HTTP error, a reply that failed `accept` — comes
    /// back as `nil`, which the caller reads as "keep the raw transcript". None
    /// of them is ever news the user has to be told.
    ///
    /// `nonisolated` so the waiting happens off the main actor: the coordinator
    /// is the main actor, and holding it for six seconds to be polite about
    /// punctuation would be a strange trade.
    private nonisolated static func polished(
        raw: String, cloud: CloudClient, terms: [String]
    ) async -> String? {
        let outcome = try? await withThrowingTaskGroup(of: String?.self) { group -> String? in
            group.addTask {
                try await TranscriptPolisher.polish(
                    raw: raw, cloud: cloud, protectedTerms: terms)
            }
            group.addTask {
                try await Task.sleep(for: polishBudget)
                throw PolishTimedOut()
            }
            defer { group.cancelAll() }
            return try await group.next() ?? nil
        }
        return outcome ?? nil
    }

    private func fail(_ message: String) {
        errorMessage = message
        micTaken = false
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
        stopReportingLevel()
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
        // The case the history exists for: the keyboard never inserts from
        // `error`, so whatever had settled is lost unless it is kept here.
        recordHistory()
        active = false
        beginLinger()
    }

    /// Keep this session's transcript in the app's voice-typing history
    /// (pathorsAI/parley#290), if it has one.
    ///
    /// Called from the three endings the keyboard either inserts from or never
    /// will: `settle` (`done`), `fail` (`error`) and `endSessionWithMicTaken`.
    /// **Never from `cancel`**: ✕ is the user throwing the words away, and
    /// `cancel` clears `committed` before it publishes for that reason. The
    /// switch in Settings and blank text are the store's to refuse.
    private func recordHistory() {
        guard !historyRecorded, let startedAt = sessionStartedAt else { return }
        guard !committed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        historyRecorded = true
        DictationHistory.shared.record(
            text: committed, startedAt: startedAt, source: sessionSource,
            hostBundleID: sessionHost)
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
        // `isCapturing`, not `capture != nil`: an open window is a promise to
        // the keyboard that the next tap will be served where the user already
        // is, and the keyboard renders that promise. Publishing one over a
        // capture that is not capturing makes it a lie the user only discovers
        // by tapping — the same "holding it is not having it" mistake `launch`
        // and `endWindow` were both making, reached from the third side. A
        // transient interruption landing exactly here costs the window, and a
        // window nobody opened is a state the keyboard already knows how to
        // describe.
        if !yieldedToMeeting,
            let opened = MicWindowState.opened(length: windowLength, at: Date()),
            capture?.isCapturing == true
        {
            openWindow(opened)
            return
        }
        if !yieldedToMeeting, capture?.isCapturing == true {
            holdMicrophone()
            return
        }
        await closeMicrophone()
        beginLinger()
    }

    /// With no window, the microphone still stays open for `holdAfterDictation`
    /// after a dictation ends, so the next tap borrows it instead of asking a
    /// backgrounded process to start one. iOS can refuse that start, and a
    /// suspended process never hears the tap at all; either way the second
    /// dictation went through Parley. Sound that arrives during the hold is
    /// dropped exactly as it is during a window.
    private func holdMicrophone() {
        endLinger()
        publishPresence()
        holdTask?.cancel()
        holdTask = Task { [weak self] in
            try? await Task.sleep(for: Self.holdAfterDictation)
            guard !Task.isCancelled, let self else { return }
            self.holdTask = nil
            guard !self.active, self.window.openedAt == nil else { return }
            await self.closeMicrophone()
            self.beginLinger()
        }
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

    /// Opened at most once at a time: the keyboard's URL fallback fires
    /// `startAckWindow` (700 ms) into a background start that is still
    /// activating the audio session, and the foreground `launch` it triggers
    /// used to open a second capture; the loser was never stopped and both fed
    /// the bridge. A capture that exists but is not capturing is a corpse (the
    /// engine can be torn down with no status reaching this object) and is
    /// replaced.
    private func openMicrophone() async -> AudioCapture? {
        if let capture, capture.isCapturing { return capture }
        if let opening { return await opening.value }
        let task = Task { () -> AudioCapture? in
            if let stale = self.capture {
                self.capture = nil
                // Stopped rather than dropped: `AudioCapture.deinit` does not
                // deactivate the audio session the fresh one is about to take.
                await stale.stop()
            }
            let fresh = self.makeCapture()
            let started = Date()
            do {
                try await fresh.start()
            } catch {
                let ms = Int(Date().timeIntervalSince(started) * 1000)
                Self.log.notice(
                    "mic start refused after \(ms, privacy: .public) ms: \(error.localizedDescription, privacy: .public)"
                )
                return nil
            }
            let ms = Int(Date().timeIntervalSince(started) * 1000)
            Self.log.notice("mic start took \(ms, privacy: .public) ms")
            self.capture = fresh
            return fresh
        }
        opening = task
        defer { opening = nil }
        return await task.value
    }

    private static let log = Logger(subsystem: "com.pathors.parley", category: "Dictation")

    private func closeMicrophone() async {
        holdTask?.cancel()
        holdTask = nil
        let cap = capture
        capture = nil
        stopReportingLevel()
        await cap?.stop()
        // No microphone to borrow any more: a backgrounded tap now has to open
        // Parley, and the keyboard's button should say so at once.
        publishPresence()
    }

    /// Start (or restart) the window and the loop that heartbeats and expires
    /// it. The microphone must already be running.
    private func openWindow(_ opened: MicWindowState) {
        holdTask?.cancel()
        holdTask = nil
        // A background task and a window must never overlap: ending a
        // background assertion in the background can suspend a process the
        // audio session was keeping up.
        endLinger()
        windowProblem = nil
        window = opened
        publishWindow()
        publishPresence()
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
    ///
    /// ## Why the guard is not "is a window open"
    ///
    /// It was, and that turned out to drop the call that mattered most. A
    /// capture can outlive its window: the window expires, or is ended from the
    /// keyboard, and the microphone is closed — but a capture that dies *first*
    /// arrives here through `handle(capture:)` with the window already closed
    /// behind it, and an `openedAt`-only guard sent it away with the dead
    /// `AudioCapture` still held. The next dictation then borrowed a corpse.
    ///
    /// So the question is whether there is anything left to end, which is the
    /// window *or* the microphone it was holding. The "one window ends once"
    /// property survives: the first call closes both, and a second finds
    /// neither and returns before touching anything.
    func endWindow() async {
        guard window.openedAt != nil || capture != nil else { return }
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
        if capture?.isCapturing != true {
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
            guard await openMicrophone() != nil else {
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
        publishMicActivity()
    }

    /// Tell the Live Activity the same two things the keyboard was just told.
    ///
    /// Hung off `publish()` and `publishWindow()` rather than off the ~15 places
    /// that call them, and that is the whole point: those two functions already
    /// exist because "the session changed" and "the window changed" each needed
    /// one place to be said from, and the card is a third reader of exactly
    /// those two facts. Calling the controller from the call sites instead would
    /// be a second set of them to keep in step with the first, and the failure
    /// would be silent — a lock screen that disagrees with the keyboard about
    /// whether the microphone is open. The card is a second keyboard as far as
    /// this object is concerned; it should be told in the same breath.
    ///
    /// `isLive` is the existing predicate for "a process is holding a microphone
    /// on this session's behalf" (`starting` / `listening` / `reconnecting` /
    /// `finishing`); the four states outside it are claims about the past, and
    /// there is no dictation left to draw.
    ///
    /// `trouble` is `micTaken` and `error` only. Not `reconnecting`: the
    /// microphone is still open there and the audio is being held, so it is a
    /// pause in the words arriving rather than an interruption — the same
    /// distinction `publishLive` and `DictationChannel.Downlink.State` draw, and
    /// the one the card would lose first if nobody wrote it down again here.
    private func publishMicActivity() {
        MicActivityController.shared.dictationChanged(
            startedAt: state.isLive ? sessionStartedAt : nil,
            window: window,
            trouble: state == .micTaken || state == .error)
    }

    // MARK: background linger

    /// With the audio session closed the system suspends this process within
    /// seconds, and a suspended process can't hear the keyboard's next start
    /// note — the user would get bounced through the app again. ~30 s of
    /// background-task time covers the common "stop, think, dictate again"
    /// beat with no app switch.
    private func beginLinger() {
        // Never alongside a window or a hold. Their audio session is what is
        // holding the process up; a background assertion added on top buys
        // nothing and its expiry is a documented way to get suspended anyway.
        guard window.openedAt == nil, holdTask == nil else { return }
        endLinger()
        lingerTask = UIApplication.shared.beginBackgroundTask(withName: "dictation-relaunch") {
            [weak self] in
            guard let self else { return }
            self.endLinger()
            // The assertion ran out, and with nothing else holding the
            // process up iOS suspends it from here — which is the one moment
            // this process gets to tell the keyboard it is going, instead of
            // leaving it to notice the heartbeat stopping. Only when nothing
            // else is in fact holding it: a session or a window that began in
            // the meantime already ended this task, and the handler is not
            // called then, but the check is cheap and the wrong goodbye is not.
            if !self.active, self.window.openedAt == nil {
                DictationChannel.writePresence(.gone)
            }
        }
    }

    private func endLinger() {
        guard lingerTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(lingerTask)
        lingerTask = .invalid
    }

    // MARK: presence

    /// The heartbeat behind `AppPresence`, for the process's whole life.
    ///
    /// A loop rather than a timer keyed to any particular state, because the
    /// fact it reports is the process itself: while the app runs it stamps,
    /// and while it is suspended it cannot — the sleep simply does not return
    /// until the process does. That silence is the signal the keyboard reads,
    /// so nothing here has to know *why* the process went quiet. The two
    /// goodbyes (`beginLinger`'s expiry and `willTerminate`) are the cases
    /// where the app can see the silence coming and says so early.
    ///
    /// The cost is one small file write every ten seconds while awake. During
    /// an hour-long microphone window that is on top of the window's own
    /// twenty-second stamp; both are far below what the running microphone
    /// itself costs, which is the thing a window has already agreed to pay.
    private func armPresence() {
        presenceTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                self.publishPresence()
                try? await Task.sleep(for: .seconds(AppPresence.heartbeat))
            }
        }
    }

    private var presenceTask: Task<Void, Never>?

    /// Stamp the presence file with what a tap would get right now. Also
    /// called at the transitions that change the answer — backgrounding,
    /// foregrounding, the microphone opening or closing — so the keyboard
    /// never waits out a heartbeat to learn something the app knew at once.
    ///
    /// `servesInPlace` is `canServeInPlace`, the same predicate
    /// `armRequestObserver` reads before honoring a start. The observer goes
    /// one step further when it is false and tries to open a microphone; the
    /// heartbeat only reports, so the keyboard's promise stays the pessimistic
    /// one.
    private func publishPresence() {
        DictationChannel.writePresence(.init(awake: true, servesInPlace: canServeInPlace))
    }

    /// A start request would be served without Parley coming forward: the app
    /// is in front, where it can open a microphone, or it holds a running one
    /// to borrow.
    private var canServeInPlace: Bool {
        UIApplication.shared.applicationState == .active || capture?.isCapturing == true
    }

    /// A session that outlived its process.
    ///
    /// The downlink is the keyboard's picture of the session, and a process
    /// that was killed mid-dictation — jetsam, a crash, the user swiping it
    /// away — leaves that picture frozen on `listening`. The keyboard now
    /// stops believing it once the presence heartbeat goes quiet, but *this*
    /// process's heartbeat starts the moment it launches, and a fresh
    /// heartbeat would vouch for a session it never had. So the leftover is
    /// closed here, first thing, as an error: nothing is inserted from an
    /// error, which is right for a transcript whose tail was lost with the
    /// process, and the message says what happened where the user will read
    /// it. Safe by construction — no session can be active before `init`
    /// finishes.
    private func reapOrphanedSession() {
        guard let stale = DictationChannel.readDownlink(), stale.state.isLive else { return }
        DictationChannel.writeDownlink(
            .init(
                session: stale.session, committed: stale.committed, state: .error,
                errorMessage: String(
                    localized:
                        "Parley was closed before the dictation finished. Tap the mic to try again."
                )))
    }

    /// Mirror the live state into the downlink the keyboard reads.
    private func publish() {
        DictationChannel.writeDownlink(
            .init(
                session: session, committed: committed, partial: partial,
                state: state, errorMessage: errorMessage))
        publishMicActivity()
    }

    /// Dismiss the dictation screen back to the app's normal UI (used when the
    /// user came back to Parley itself rather than bouncing to a host app).
    func dismiss() async {
        if active { await stop() }
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
                // `committed` is rebuilt from `runs` at the fold, so the fake
                // stream has to keep one too — without it `foldPartialIn` threw
                // the settled text away and a stopped demo delivered only its
                // last few characters.
                runs = settled.isEmpty ? [] : [(id: "demo", text: settled)]
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

/// The polish budget ran out. Never surfaced: it exists only to lose the race
/// inside `polished`, where losing means the raw transcript ships.
private struct PolishTimedOut: Error {}

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
