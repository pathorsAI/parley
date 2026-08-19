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
/// the end, where the cloud transcribes it in batch. So a relay failure is a
/// line of status text and a reconnect, never the end of a recording.
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

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var segments: [TranscriptSegment] = []
    @Published private(set) var micLevel: Float = 0
    /// One line under the transcript. `nil` when there is nothing to say.
    @Published private(set) var status: String?
    /// The microphone could not be recovered. The view watches this and ends
    /// the meeting, which is what gets the audio captured so far onto disk and
    /// into the cloud instead of leaving a dead recording on screen.
    @Published private(set) var lostMicrophone = false

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
    /// directly would keep feeding a socket nobody reads.
    private let sink = RelaySink()

    /// Bumped for every relay connection this recording makes. Events carry the
    /// leg they came from so a socket that dies slowly cannot write into a
    /// transcript its replacement has already moved on from.
    private var leg = 0
    private var reconnectTask: Task<Void, Never>?
    private var reconnectAttempts = 0
    /// The user asked to stop, so a socket close is the expected end of the
    /// stream rather than something to reconnect from.
    private var finishRequested = false
    /// Monotonic start of capture, for the offset a reconnected leg needs to
    /// place its timestamps after the audio that came before it.
    private var captureStartedAt: TimeInterval = 0

    private static let maxReconnectAttempts = 8

    // MARK: control

    /// Begin recording. A second call while a meeting is live is a no-op — the
    /// guard that makes the double-tap harmless.
    func start(token: String?) async {
        guard phase == .idle else { return }
        phase = .starting
        status = String(localized: "Starting…")
        segments = []
        finishRequested = false
        lostMicrophone = false
        leg = 0
        reconnectAttempts = 0

        guard await AudioCapture.requestPermission() else {
            phase = .idle
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

        sink.swap(client)
        let cap = AudioCapture(
            onChunk: { [weak self, sink] samples, level in
                recorder?.append(samples)
                sink.send(samples)
                Task { @MainActor in self?.micLevel = level }
            },
            onStatus: { [weak self] captureStatus in
                Task { @MainActor in self?.handle(captureStatus) }
            })

        do {
            try await cap.start()
        } catch {
            uploader = nil
            relay = nil
            sink.swap(nil)
            client?.cancel()
            phase = .idle
            status = String(localized: "Audio error: \(error.localizedDescription)")
            return
        }
        guard phase == .starting else {
            // Stopped during the mic open; unwind rather than leave it running.
            await cap.stop()
            return
        }

        capture = cap
        captureStartedAt = ProcessInfo.processInfo.systemUptime
        phase = .recording

        guard let client else {
            status = String(localized: "Not signed in — microphone test only")
            return
        }
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
        reconnectTask?.cancel()
        reconnectTask = nil

        let cap = capture
        capture = nil
        await cap?.stop()
        sink.swap(nil)
        micLevel = 0

        if let relay {
            status = String(localized: "Wrapping up…")
            await relay.finish()  // drain: the relay flushes the last utterance
        }
        relay = nil

        await upload(app: app)
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
            status = String(localized: "Transcribing live")
        } catch {
            guard self.leg == leg else { return }
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
            scheduleReconnect()
        }
    }

    /// Reopen the relay while the microphone keeps running. The audio file is
    /// untouched by any of this — the only thing at stake is how much of the
    /// transcript appears live rather than after the upload.
    private func scheduleReconnect() {
        guard reconnectTask == nil, isRecording, !finishRequested else { return }
        guard let token = KeychainStore.get(AppState.tokenKey) else {
            status = String(localized: "Live transcription stopped — the recording is still running")
            return
        }
        guard reconnectAttempts < Self.maxReconnectAttempts else {
            status = String(
                localized:
                    "Live transcription stopped, but the recording is still running and will be transcribed after it syncs."
            )
            return
        }

        let previous = relay
        relay = nil
        sink.swap(nil)
        previous?.cancel()

        reconnectAttempts += 1
        leg += 1
        let attempt = reconnectAttempts
        let nextLeg = leg
        // 1, 2, 4, 8 … capped at 15 s. Long enough not to hammer a relay that
        // is down, short enough that walking back into Wi-Fi picks up quickly.
        let backoff = min(15.0, pow(2.0, Double(attempt - 1)))
        status = String(localized: "Transcription dropped — reconnecting…")

        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(backoff))
            guard !Task.isCancelled, let self else { return }
            await self.performReconnect(token: token, leg: nextLeg)
        }
    }

    private func performReconnect(token: String, leg targetLeg: Int) async {
        reconnectTask = nil
        guard leg == targetLeg, isRecording, !finishRequested else { return }
        let offset = UInt64(max(0, (ProcessInfo.processInfo.systemUptime - captureStartedAt) * 1000))
        let client = makeRelay(token: token, leg: targetLeg, timeOffsetMs: offset)
        relay = client
        sink.swap(client)
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
        case .failed(let message):
            // The mic is genuinely gone. Everything captured so far is still
            // good, so hand the view the cue to end the meeting properly
            // rather than leave a recording that records nothing.
            status = String(localized: "Lost the microphone: \(message)")
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
        /// ScreenshotDemo: put the screen in the state worth capturing — a
        /// meeting already in progress — with no microphone and no network.
        func seedDemo(segments: [TranscriptSegment], status: String) {
            self.segments = segments
            self.status = status
            phase = .recording
            micLevel = 0.11
        }
    #endif
}

/// Hands microphone chunks to whichever relay leg is current.
///
/// Lives outside the actor on purpose: `send` runs on the audio render thread,
/// where hopping to the main actor to look up a property is not an option. The
/// lock is held only long enough to read a reference.
private final class RelaySink: @unchecked Sendable {
    private let lock = NSLock()
    private var client: SttRelayClient?

    func swap(_ next: SttRelayClient?) {
        lock.lock()
        client = next
        lock.unlock()
    }

    func send(_ samples: [Int16]) {
        lock.lock()
        let current = client
        lock.unlock()
        current?.enqueue(pcm: samples)
    }
}
