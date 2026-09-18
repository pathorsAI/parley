import Foundation
import ParleyKit
import SwiftUI

/// One live meeting, from the tap on Start to the recording landing in the
/// cloud. The Android counterpart is `meeting/MeetingSession.kt`, and this is
/// deliberately the same shape.
///
/// ## Why this is an object and not a handful of `@State`
///
/// The record button used to drive `start()` straight from the view, holding
/// the capture, the relay, and the uploader in `@State`, and flipping
/// `isRecording` only once everything was up. Between the tap and that flip sat
/// a WebSocket handshake — on a cold cellular radio, seconds — during which the
/// button still read "Start recording" and still did what it said. A second tap
/// in that window ran `start()` again: two `AVAudioEngine`s tapping the mic,
/// **two relay sockets transcribing the same room** into one transcript, and
/// two uploaders, of which only the last was still referenced. That is the
/// duplicated-transcript bug, and no amount of care inside `start()` fixes it
/// while "am I recording?" is a variable set at the end.
///
/// So the state machine is the type. `phase` moves to `.starting`
/// *synchronously* on the tap, every entry point is guarded by it, and the
/// button reads it rather than a success flag.
///
/// ## What is allowed to fail
///
/// Only the microphone is load-bearing. The relay is not: if it never connects,
/// or dies mid-meeting, the audio file keeps being written and is uploaded at
/// the end. `MeetingUploader` then measures the transcript against the audio
/// (`TranscriptCoverage`) and, when it comes up short, transcribes the whole
/// recording again from the file. So a relay failure is a line of status text
/// and a reconnect, never the end of a recording — and never a transcript with
/// a hole in it either.
///
/// That last step used to be missing, and the status copy promised it anyway:
/// a meeting whose relay died quietly at minute five uploaded 49 minutes of
/// audio with five minutes of transcript, and nothing ever went back for the
/// rest. If the sentence above is ever true only in this comment again, that
/// is the bug.
@MainActor
final class MeetingRecorder: ObservableObject {

    enum Phase: Equatable {
        case idle
        /// Microphone opening and relay connecting. Already recording as far as
        /// the user is concerned, and already un-startable.
        case starting
        case recording
        /// Draining the relay's last utterance.
        case finishing
        case uploading
    }

    @Published private(set) var phase: Phase = .idle {
        didSet {
            Self.holdsTheMicrophone = Self.holdsMic(phase)
            publishMicActivity()
        }
    }

    /// Whether *any* meeting anywhere in the app currently has the microphone.
    ///
    /// A static because the recorder is a `@StateObject` inside `LiveView`, and
    /// the thing that needs the answer is on another tab: `PlaybackController`
    /// refuses to start while a recording is running, and there is no path from
    /// a pushed detail screen to the live screen's object. Derived from `phase`
    /// rather than set by hand at each of the twelve transitions, so it cannot
    /// drift from the state machine it describes.
    ///
    /// `.uploading` is excluded on purpose: the microphone is already closed by
    /// then and a person who has stopped recording should be able to play
    /// something back while the upload finishes.
    private(set) static var holdsTheMicrophone = false

    private static func holdsMic(_ phase: Phase) -> Bool {
        switch phase {
        case .starting, .recording, .finishing: return true
        case .idle, .uploading: return false
        }
    }

    @Published private(set) var segments: [TranscriptSegment] = []
    @Published private(set) var micLevel: Float = 0
    /// Bumped once per audio chunk. `micLevel` alone cannot drive a scrolling
    /// waveform: two silent chunks publish the same value and `onChange` never
    /// fires, so the field would stop moving exactly when it should show silence.
    @Published private(set) var micSample: Int = 0
    #if DEBUG
        private var demoLevelTimer: Timer?
    #endif
    /// When this meeting started, for the live screen's timer. Set on the tap
    /// rather than when the microphone finally opens — the timer and the record
    /// control have to agree about when the recording began, and the control
    /// flips on the tap (see the type doc). Nil between meetings.
    ///
    /// A `Date` rather than a ticking count: the view hands it to
    /// `Text(_:style:.timer)` and the system redraws the digits, so nothing here
    /// publishes once a second.
    ///
    /// Carries a `didSet` for the same reason `phase` does: it is the second
    /// half of what the lock-screen card is about, and `start()` sets it
    /// *after* moving `phase`, so the phase's own notification is one that has
    /// not heard about this meeting yet.
    @Published private(set) var startedAt: Date? {
        didSet { publishMicActivity() }
    }
    /// One line under the transcript. `nil` when there is nothing to say.
    @Published private(set) var status: String?
    /// The microphone could not be recovered. The view watches this and ends
    /// the meeting, which is what gets the audio captured so far onto disk and
    /// into the cloud instead of leaving a dead recording on screen.
    ///
    /// The third `didSet`, because losing the microphone changes neither
    /// `phase` nor `startedAt` — the meeting is still running, it has just
    /// stopped hearing anything — and a card that kept animating through it
    /// would be exactly the lie the card exists to prevent.
    @Published private(set) var lostMicrophone = false {
        didSet { publishMicActivity() }
    }
    /// How the live transcript is doing, separately from `status`, so the view
    /// can draw "reconnecting" as the temporary state it is instead of styling
    /// it like the sentence that says the transcript is over.
    @Published private(set) var transcription: TranscriptionHealth = .idle
    /// The recording that has landed in the cloud, and what it landed as. Nil
    /// until an upload settles, and nil again the moment the next meeting
    /// starts.
    ///
    /// This is the beat the filing suggestion hangs off, rather than the
    /// microphone stopping: renaming or re-filing a recording is a write
    /// against something the server has to already hold, so the earliest
    /// honest moment to offer one is here. See `FilingSuggestionModel`.
    @Published private(set) var settled: Settled?

    /// A recording the cloud has accepted. Carries the transcript too: the pass
    /// reads it, and reading it off `segments` instead would be reading a
    /// property the next meeting is free to clear.
    struct Settled {
        let id: String
        let title: String
        let folderId: String?
        let segments: [TranscriptSegment]
    }

    /// The live transcript's side of the meeting. None of these ends the
    /// recording: the audio file is written from the tap and uploaded either
    /// way (see the type doc).
    enum TranscriptionHealth: Equatable {
        /// No relay this meeting — signed out, or nothing started yet.
        case idle
        case connecting
        case live
        /// The socket dropped; audio is being held for the next leg.
        case reconnecting
        /// Out of reach. The recording continues and the cloud transcribes the
        /// upload; only the *live* transcript is over.
        case stopped
    }

    /// What the record button reflects. True from the tap, not from the moment
    /// the socket came up.
    var isRecording: Bool { phase == .starting || phase == .recording }
    /// The meeting is winding down; the button is a spinner, not a control.
    var isBusy: Bool { phase == .finishing || phase == .uploading }

    private var capture: AudioCapture?
    private var relay: SttRelayClient?
    private var uploader: MeetingUploader?
    /// The audio thread writes here, not to a client it captured once. A
    /// reconnect swaps the client behind it; a tap closure holding the old one
    /// directly would keep feeding a socket nobody reads. It also *holds* the
    /// audio spoken while there is no socket, so a blip costs a pause in the
    /// live transcript rather than the sentence that was said during it.
    private let audio = RelayAudioBridge()

    /// Bumped for every relay connection this recording makes. Events carry the
    /// leg they came from so a socket that dies slowly cannot write into a
    /// transcript its replacement has already moved on from.
    private var leg = 0
    private var reconnectTask: Task<Void, Never>?
    private var reconnectAttempts = 0
    /// The user asked to stop, so a socket close is the expected end of the
    /// stream rather than something to reconnect from.
    private var finishRequested = false

    /// How often and how fast to redial. The offset each new leg needs comes
    /// from the bridge rather than the wall clock — the bridge is what knows
    /// where in the recording the audio it held was spoken.
    private static let reconnect = ReconnectPolicy()

    /// The Live Activity's ⏹, arriving as a Darwin note (see
    /// `MeetingControlChannel`). Same shape as
    /// `DictationCoordinator.windowControlObserver`, and held for the same
    /// reason: `DarwinObserver` unregisters itself in `deinit`, so the property
    /// *is* the lifetime.
    private var stopObserver: DarwinObserver?

    /// The `AppState` the running meeting was started from, weakly.
    ///
    /// `stop(app:)` needs one — the upload reads the account, the default save
    /// destination and the org list off it — and this object has no other way
    /// to reach one. Everywhere else that is fine, because every caller is
    /// `LiveView`, which holds it from the environment and passes it in;
    /// `FilingSuggestionModel.consider(_:app:)` is handed it the same way, and
    /// `DictationCoordinator` answers the same problem by owning nothing and
    /// building its own `CloudClient` off the Keychain. Neither answer works
    /// here: a stop has to reach *this* meeting's uploader, with this user's
    /// filing settings.
    ///
    /// The card's ⏹ is the one caller that does not arrive through a view, and
    /// it arrives with the app in the background — where SwiftUI is under no
    /// obligation to evaluate a body. So routing it back out through a
    /// `@Published` flag and an `.onChange`, the way `lostMicrophone` is
    /// routed, would make stopping a recording from a locked phone depend on
    /// the view layer running while the screen is off.
    ///
    /// Weak, so it is a reference and not a second owner — `ParleyApp` holds
    /// the process's only `AppState` — and re-pointed by each `start`. Nil
    /// means the app that started the meeting is gone, and so is the meeting.
    private weak var host: AppState?

    /// Arming here rather than from the view, and the claim that makes it safe
    /// is worth checking rather than assuming: this object is a `@StateObject`
    /// of `LiveView`, `LiveView` is the Record tab of `MainTabs`, and `start()`
    /// is reachable from nowhere else — so a recording cannot exist without
    /// this object existing, and this object cannot exist without having run
    /// `init`. The observer is therefore armed for exactly as long as there is
    /// anything it could stop, which is a tighter and more honest lifetime than
    /// `DictationCoordinator`'s process-long observers get to have (that object
    /// is a singleton, and its notes can arrive for a session it has not
    /// started yet).
    init() {
        armStopObserver()
    }

    // MARK: control

    /// Begin recording. A second call while a meeting is live is a no-op — the
    /// guard that makes the double-tap harmless.
    func start(token: String?, app: AppState) async {
        guard phase == .idle else { return }
        // Before anything can go wrong, and before the card exists: this is the
        // `AppState` the card's ⏹ will stop the meeting with. See `host`.
        host = app
        // The dictation keyboard may be holding the microphone open for its
        // window. There is one microphone: take it before opening a meeting's
        // own capture, rather than leaving two `AudioCapture`s to rebuild the
        // audio session out from under each other.
        await DictationCoordinator.shared.yieldMicrophone()
        phase = .starting
        // Warm the haptic engine on the tap, for the beat that answers it a
        // permission check and an engine start later. Unconditional and
        // unchecked — a device with haptics off ignores it, and nothing below
        // waits on it (see `Haptics`).
        Haptics.prepareForRecording()
        status = String(localized: "Starting…")
        startedAt = Date()
        segments = []
        // Whatever the last meeting left on screen belongs to the last meeting.
        settled = nil
        finishRequested = false
        lostMicrophone = false
        leg = 0
        reconnectAttempts = 0
        transcription = .idle
        audio.reset()

        guard await AudioCapture.requestPermission() else {
            phase = .idle
            startedAt = nil
            status = String(localized: "Microphone access is required")
            return
        }
        // `stop()` can land while the permission sheet is up.
        guard phase == .starting else { return }

        let recorder = try? MeetingUploader()
        uploader = recorder

        // The relay client exists before it is connected, and buffers what the
        // microphone gives it in the meantime. That is what lets the mic open
        // first: the handshake stops being something the user waits through.
        let client = token.map { makeRelay(token: $0, leg: 0, timeOffsetMs: 0) }
        relay = client
        if let client { audio.attach(client) }

        let cap = AudioCapture(
            onChunk: { [weak self, audio] samples, level in
                recorder?.append(samples)
                audio.send(samples)
                Task { @MainActor in
                    self?.micLevel = level
                    self?.micSample &+= 1
                }
            },
            onStatus: { [weak self] captureStatus in
                Task { @MainActor in self?.handle(captureStatus) }
            })

        do {
            try await cap.start()
        } catch {
            uploader = nil
            relay = nil
            audio.discard()
            client?.cancel()
            phase = .idle
            startedAt = nil
            status = String(localized: "Audio error: \(error.localizedDescription)")
            return
        }
        guard phase == .starting else {
            // Stopped during the mic open; unwind rather than leave it running.
            await cap.stop()
            return
        }

        capture = cap
        phase = .recording
        // The microphone is open, which is the first moment that is actually
        // true: the button flipped on the tap and the timer has been running
        // since, so a rise fired there would have been a claim about a capture
        // that could still fail. See `Haptics.recordingStarted`.
        Haptics.recordingStarted()

        guard let client else {
            status = String(localized: "Not signed in — microphone test only")
            return
        }
        transcription = .connecting
        status = String(localized: "Connecting transcription…")
        await connect(client, leg: 0)
    }

    /// End the meeting: stop the microphone, let the relay flush its last
    /// utterance, then save and upload. A second call while that runs is a
    /// no-op.
    func stop(app: AppState) async {
        guard isRecording else { return }
        finishRequested = true
        phase = .finishing
        // Here rather than after the awaits below: closing the microphone,
        // draining the relay and uploading are seconds of work, and a beat that
        // waited for them would be answering a later question than the one that
        // was asked.
        //
        // Fired and forgotten, which is load-bearing nowhere and matters most
        // at the second door into this method: the Live Activity's ⏹ on a
        // locked screen runs in a backgrounded process, and iOS drops haptics
        // from one, so that path plays nothing at all. That is the same rule
        // `Haptics` already documents for the keyboard extension without Full
        // Access, and it is not worked around — a recording that stopped in
        // silence still stopped, and the card is what said so.
        Haptics.recordingStopped()
        reconnectTask?.cancel()
        reconnectTask = nil

        let cap = capture
        capture = nil
        await cap?.stop()
        // Whatever the bridge is still holding belongs to no leg now; the
        // finalize below drains what actually reached the relay.
        audio.discard()
        micLevel = 0

        if let relay {
            status = String(localized: "Wrapping up…")
            await relay.finish()  // drain: the relay flushes the last utterance
        }
        relay = nil

        await upload(app: app)
    }

    /// Throw the meeting away: stop the microphone, drop the relay without
    /// draining it, delete the audio file, and clear the transcript. Nothing is
    /// saved and nothing is uploaded — this is the exit for a recording that
    /// should never have started, which otherwise had no way out but `stop()`
    /// and a zombie recording in the library.
    func discard() async {
        guard isRecording else { return }
        finishRequested = true
        phase = .finishing
        // A third outcome gets the third beat, exactly as dictation's ✕ does —
        // and it is that same beat, because throwing something away is one
        // meaning (see `Haptics.recordingDiscarded`). Never from the lock
        // screen: the card has no Discard, by design, because nothing that
        // deletes recorded audio is reachable from a locked phone.
        Haptics.recordingDiscarded()
        reconnectTask?.cancel()
        reconnectTask = nil

        let cap = capture
        capture = nil
        await cap?.stop()
        audio.discard()
        micLevel = 0

        relay?.cancel()
        relay = nil
        uploader?.abandon()
        uploader = nil

        segments = []
        settled = nil
        startedAt = nil
        status = nil
        phase = .idle
    }

    // MARK: the card

    /// The Live Activity's ⏹ — `StopMeetingRecordingIntent` writing
    /// `MeetingControlChannel` from the widget's process and posting its note.
    ///
    /// It runs the in-app Stop button's path and nothing else: `stop(app:)`, so
    /// the microphone closes, the relay drains its last utterance, and the
    /// recording is saved and uploaded exactly as it would be from a tap on the
    /// Record tab. A lock screen must not have its own way of ending a meeting.
    ///
    /// The three guards are each a different "no":
    ///
    /// - `applies(toRecordingStartedAt:)` — a stop request is a timestamp, not a
    ///   flag, so a control file left behind by a crash cannot stop the *next*
    ///   recording. Neither side ever clears it.
    /// - `isRecording` — and this is the case worth being deliberate about. A
    ///   note can wake an app that iOS relaunched *into the background* for the
    ///   intent, and what it finds there is an idle recorder: the recording
    ///   really did die with the process, because nothing brings a stopped
    ///   `AVAudioSession` back on its own. Doing nothing is the correct and
    ///   complete answer — the card will stop being vouched for, and the widget
    ///   says so on its own.
    /// - `host` — no `AppState` means no app around the recording either.
    private func armStopObserver() {
        stopObserver = DarwinObserver(MeetingControlChannel.note) { [weak self] in
            Task { @MainActor in
                guard let self, self.isRecording, let app = self.host,
                    MeetingControlChannel.read()?
                        .applies(toRecordingStartedAt: self.startedAt) == true
                else { return }
                await self.stop(app: app)
            }
        }
    }

    /// The meeting's half of what the microphone card says (the other half is
    /// `DictationCoordinator`'s). Driven from the `didSet` of the three
    /// properties that can change it rather than from the twelve transitions
    /// that set them — the same reason `holdsTheMicrophone` is derived there.
    ///
    /// `holdsMic` and not `startedAt != nil`: `.uploading` must produce no card.
    /// The microphone is already closed by then, and a card is a claim about the
    /// microphone — the same line `holdsTheMicrophone` draws so that playback
    /// can start while an upload finishes.
    ///
    /// The title is `nil`, and that is the answer rather than a gap to fill
    /// later. A recording has no name while it runs: `MeetingUploader` creates
    /// the pending record with `title: nil` and `displayTitle` falls back to
    /// `title(for:)` — a date — at upload time, which is after the card is gone.
    /// Sending an English "Recording" here would be worse than sending nothing,
    /// because nothing is what tells the widget to supply its own localized
    /// default, and the widget is the only side that knows what language the
    /// reader is looking at.
    private func publishMicActivity() {
        MicActivityController.shared.meetingChanged(
            startedAt: Self.holdsMic(phase) ? startedAt : nil,
            title: nil,
            trouble: lostMicrophone)
    }

    // MARK: relay

    private func makeRelay(token: String, leg: Int, timeOffsetMs: UInt64) -> SttRelayClient {
        SttRelayClient(
            options: .init(
                bearerToken: token, feature: "meeting",
                // Every leg numbers its own segments from zero, so without a
                // per-leg prefix a reconnect would overwrite the opening of the
                // meeting with its own first sentence.
                idPrefix: leg == 0 ? nil : "mix@\(leg)",
                timeOffsetMs: timeOffsetMs)
        ) { [weak self] event in
            Task { @MainActor in self?.handle(event, from: leg) }
        }
    }

    private func connect(_ client: SttRelayClient, leg: Int) async {
        do {
            try await client.start()
            guard self.leg == leg, phase == .recording else { return }
            reconnectAttempts = 0
            transcription = .live
            status = String(localized: "Transcribing live")
        } catch {
            guard self.leg == leg else { return }
            // The handshake failed, so this leg never carried anything: hand
            // the audio back to the hold buffer for the next one.
            audio.hold()
            scheduleReconnect()
        }
    }

    private func handle(_ event: SttRelayEvent, from eventLeg: Int) {
        guard eventLeg == leg else { return }
        switch event {
        case .segment(let seg):
            upsert(seg)
        case .closed:
            guard !finishRequested, isRecording else { return }
            scheduleReconnect()
        case .error:
            // The message is wire text ("relay error 402: …"), never something
            // to put in front of someone. While recording the reconnect path
            // owns the copy; once the meeting is winding down the stop path
            // does, and neither wants this overwriting it.
            guard !finishRequested, isRecording else { return }
            guard !event.isQuotaExceeded else {
                // Out of quota is the one failure a redial cannot fix: the
                // next handshake is refused the same way.
                let dying = relay
                relay = nil
                dying?.cancel()
                giveUpOnTranscription(
                    String(
                        localized:
                            "You're out of transcription quota — live transcription stopped. The recording keeps running, and the audio is transcribed in full after it syncs."
                    ))
                return
            }
            scheduleReconnect()
        }
    }

    /// Reopen the relay while the microphone keeps running. The audio file is
    /// untouched by any of this — the only thing at stake is how much of the
    /// transcript appears live rather than after the upload, and the bridge
    /// keeps the words spoken in between for the leg that comes next.
    private func scheduleReconnect() {
        guard reconnectTask == nil, isRecording, !finishRequested else { return }

        let previous = relay
        relay = nil
        audio.hold()
        previous?.cancel()

        guard let token = KeychainStore.get(AppState.tokenKey) else {
            giveUpOnTranscription(
                String(
                    localized: "Live transcription stopped — the recording is still running"))
            return
        }
        guard case .retry(let backoff) = Self.reconnect.decide(attempt: reconnectAttempts + 1)
        else {
            giveUpOnTranscription(
                String(
                    localized:
                        "Live transcription stopped. The recording keeps running, and the audio is transcribed in full after it syncs."
                ))
            return
        }

        reconnectAttempts += 1
        leg += 1
        let nextLeg = leg
        transcription = .reconnecting
        status = String(localized: "Transcription dropped — reconnecting…")

        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: backoff)
            guard !Task.isCancelled, let self else { return }
            await self.performReconnect(token: token, leg: nextLeg)
        }
    }

    /// No leg is coming. Drop the held audio rather than carry a buffer nobody
    /// will ever read for the rest of the meeting — the recording itself is
    /// unaffected, and the cloud transcribes it after the upload.
    private func giveUpOnTranscription(_ message: String) {
        audio.discard()
        transcription = .stopped
        status = message
    }

    private func performReconnect(token: String, leg targetLeg: Int) async {
        reconnectTask = nil
        guard leg == targetLeg, isRecording, !finishRequested else { return }
        // The bridge decides the offset, because the bridge is what knows where
        // in the recording the audio it is holding was actually spoken. A leg
        // offset to "now" would file a gap's worth of speech after the words
        // that followed it.
        guard
            let client = audio.attach({ offsetMs in
                self.makeRelay(token: token, leg: targetLeg, timeOffsetMs: offsetMs)
            })
        else { return }
        relay = client
        await connect(client, leg: targetLeg)
    }

    // MARK: microphone status

    private func handle(_ captureStatus: AudioCapture.Status) {
        guard isRecording else { return }
        switch captureStatus {
        case .running:
            break
        case .interrupted:
            micLevel = 0
            status = String(localized: "Microphone paused by the system — waiting to resume")
        case .resumed:
            status = String(localized: "Microphone is back — still recording")
        case .lost(let loss):
            // The mic is gone and the capture has run out of ways to take it
            // back. Everything captured so far is still good, so hand the view
            // the cue to end the meeting properly rather than leave a recording
            // that records nothing. A meeting is recorded from the foreground,
            // so the two reasons are worth telling apart: another app holding
            // the input is something the person in the room can act on, and an
            // audio stack that refused is not.
            switch loss {
            case .takenBySystem:
                status = String(
                    localized: "Lost the microphone — something else is using it")
            case .broken(let message):
                status = String(localized: "Lost the microphone: \(message)")
            }
            micLevel = 0
            lostMicrophone = true
        }
    }

    // MARK: transcript

    /// Mirrors the desktop's `upsertSegment` (src/lib/store.ts): segments are
    /// upserted by id, so a growing run keeps replacing itself and the `-tail`
    /// row updates in place.
    private func upsert(_ seg: TranscriptSegment) {
        // An empty tail clears the row (same contract as the desktop UI).
        if seg.id.hasSuffix("-tail") && seg.text.isEmpty {
            segments.removeAll { $0.id == seg.id }
            return
        }
        if let i = segments.firstIndex(where: { $0.id == seg.id }) {
            segments[i] = seg
        } else {
            segments.append(seg)
        }
        // Keep the tail rendered last, matching the live feed's reading order.
        segments.sort { a, b in
            if a.id.hasSuffix("-tail") != b.id.hasSuffix("-tail") {
                return b.id.hasSuffix("-tail")
            }
            return a.startMs < b.startMs
        }
    }

    // MARK: upload

    private func upload(app: AppState) async {
        guard let uploader else {
            phase = .idle
            status = nil
            return
        }
        self.uploader = nil
        guard app.signedIn else {
            phase = .idle
            status = String(localized: "Not signed in — the recording was not uploaded")
            return
        }
        phase = .uploading
        status = String(localized: "Uploading…")
        defer { phase = .idle }
        do {
            let outcome = try await uploader.finishAndUpload(
                segments: segments,
                cloud: app.cloud,
                defaultSave: app.defaultSave,
                orgs: app.orgs)
            if let outcome {
                app.pendingUploadCount = MeetingUploader.pendingCount
                status =
                    outcome.sharedToOrgName.map { String(localized: "Synced, and shared to “\($0)”") }
                    ?? String(localized: "Synced to the cloud")
                settled = Settled(
                    id: outcome.recordingId, title: outcome.title,
                    folderId: outcome.folderId, segments: segments)
            } else {
                status = String(localized: "That recording was too short to keep")
            }
        } catch let e as CloudError where e.status == 402 {
            app.pendingUploadCount = MeetingUploader.pendingCount
            status = String(
                localized:
                    "You're out of quota. The recording is safe on this phone and will sync once the quota resets."
            )
        } catch {
            app.pendingUploadCount = MeetingUploader.pendingCount
            status = String(
                localized:
                    "Sync failed for now. The recording is safe on this phone and will retry automatically."
            )
        }
    }

    #if DEBUG
        /// ScreenshotDemo: the beat after a meeting — the transcript complete,
        /// the upload landed, nothing running. `settled` is deliberately left
        /// nil: the filing suggestion is seeded straight into its own model
        /// (`FilingSuggestionModel.seedDemo`) rather than through the pass,
        /// which would need the network the demo exists to avoid.
        func seedDemoSettled(segments: [TranscriptSegment], status: String) {
            self.segments = segments
            self.status = status
            phase = .idle
            transcription = .idle
            startedAt = nil
        }

        /// ScreenshotDemo: put the screen in the state worth capturing — a
        /// meeting already in progress — with no microphone and no network.
        func seedDemo(segments: [TranscriptSegment], status: String) {
            self.segments = segments
            self.status = status
            phase = .recording
            transcription = .live
            // 18:42 on the clock, matching the featured recording's duration, so
            // the captured frame shows a meeting well under way rather than one
            // that started the instant the screenshot was taken.
            startedAt = Date(timeIntervalSinceNow: -1_122)
            // A simulator has no microphone, so the waveform would sit on its
            // silence line. Feed it a fixed speech-shaped level pattern at the
            // real chunk rate instead: bursts and pauses, the same every run, so
            // the captured frame is reproducible and shows what the view is for.
            demoLevelTimer?.invalidate()
            demoLevelTimer = Timer.scheduledTimer(withTimeInterval: 0.085, repeats: true) {
                [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    let pattern = Self.demoLevelPattern
                    self.micLevel = pattern[self.micSample % pattern.count]
                    self.micSample &+= 1
                }
            }
        }

        private static let demoLevelPattern: [Float] = {
            // ~6 s loop: three phrases of varying energy with pauses between.
            func phrase(_ n: Int, _ peak: Float) -> [Float] {
                (0..<n).map { i in
                    let t = Float(i) / Float(n)
                    let syllable = abs(sin(t * 3.14159 * Float(n) / 3.2))
                    return max(0.02, peak * (0.35 + 0.65 * syllable) * (0.6 + 0.4 * sin(t * 3.14159)))
                }
            }
            let pause = [Float](repeating: 0.006, count: 9)
            return pause + phrase(22, 0.22) + pause + phrase(14, 0.16) + pause + phrase(26, 0.2) + pause
        }()
    #endif
}
