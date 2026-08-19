import AVFoundation
import Foundation
import ParleyKit

/// Microphone capture → 16 kHz mono Int16 chunks, the pipeline's universal
/// format (desktop `TARGET_SAMPLE_RATE`; the relay meters 32 000 bytes/s).
///
/// The iOS counterpart of the desktop's `audio/microphone.rs`: capture at the
/// hardware format, then convert to 16 kHz mono s16le. Conversion uses
/// AVAudioConverter (proper resampling — the desktop's linear interpolator is
/// a fallback it only keeps because cpal has no converter).
///
/// ## Surviving the app going away
///
/// `UIBackgroundModes: audio` keeps the process alive while the session is
/// recording, but it does nothing about the four ways iOS takes the microphone
/// back, every one of which is routine while the user is in another app:
///
/// | What happens | Notification | Without handling |
/// |---|---|---|
/// | Call, Siri, alarm, another app opening a recording session | `interruptionNotification` | engine stops; nothing restarts it |
/// | Headphones/Bluetooth in or out, speaker override | `routeChangeNotification` | tap built for the old format keeps feeding a dead node |
/// | The engine's IO format changed under it | `.AVAudioEngineConfigurationChange` | AVAudioEngine tears the tap down itself |
/// | `mediaserverd` restarted | `mediaServicesWereResetNotification` | every audio object in the process is dead |
///
/// In all four the app stays up, `isRecording` stays true, and the level meter
/// sits at zero for the rest of the meeting — the "recording died after I
/// switched apps" report. So this class treats capture as a thing to be *held*
/// rather than started: it rebuilds the engine on every one of those events,
/// retries with backoff, polls as a backstop for whatever posts no
/// notification at all, and reports each transition through `onStatus` so the
/// UI can say what is going on instead of going quietly silent.
///
/// `@unchecked Sendable` because every mutable field is confined to `queue`:
/// start, stop, the four notification handlers, and the watchdog all run there,
/// and nothing else reads them.
final class AudioCapture: @unchecked Sendable {

    /// Where the microphone stands. Anything other than `.running` is worth
    /// putting on screen — a silent recording is the failure people notice an
    /// hour too late.
    enum Status: Sendable, Equatable {
        /// Capturing.
        case running
        /// The system holds the microphone (call, Siri, another app). The
        /// capture is armed and waiting to take it back.
        case interrupted
        /// Rebuilt and capturing again after an interruption, a route change,
        /// or a media-server reset.
        case resumed
        /// Could not get the microphone back. Audio is over for this session.
        case failed(String)
    }

    /// Attempts before giving up on a rebuild. With the backoff below that is
    /// roughly eight seconds of trying, which covers a route settling down
    /// without leaving a dead recording running for minutes.
    private static let maxRecoveryAttempts = 6
    /// How often to check that the engine is still actually running. Route
    /// changes the system cannot restore, and interruptions that never post
    /// their `.ended`, both show up here and nowhere else.
    private static let watchdogInterval: DispatchTimeInterval = .seconds(2)

    private let onChunk: ([Int16], Float) -> Void
    private let onStatus: (Status) -> Void

    /// Every mutation below runs here, so the notification handlers, the
    /// watchdog, and start/stop cannot rebuild the engine at the same time.
    private let queue = DispatchQueue(label: "com.pathors.parley.audio-capture")

    /// A `var` because `mediaServicesWereReset` invalidates the engine itself —
    /// recovery is a new engine, not a restart of this one.
    private var engine = AVAudioEngine()
    private var observers: [NSObjectProtocol] = []
    private var watchdog: DispatchSourceTimer?

    /// The user wants to be recording. Stays true across interruptions: it is
    /// what tells a route change to rebuild rather than stay silent.
    private var wantsCapture = false
    /// A tap is installed and the engine is running.
    private var live = false
    /// The system holds the microphone; do not fight it for the hardware.
    private var interrupted = false
    /// The hardware format the current tap and converter were built for.
    private var tapFormat: AVAudioFormat?
    private var recoveryAttempts = 0
    /// A rebuild chain is in flight. The watchdog fires every two seconds and
    /// the notifications arrive in clusters, so without this a slow recovery
    /// would end up with several chains racing each other for the same engine.
    private var rebuilding = false

    /// `onChunk(samples, rmsLevel)` fires on an audio thread. `onStatus` fires
    /// on this object's private queue.
    init(
        onChunk: @escaping ([Int16], Float) -> Void,
        onStatus: @escaping (Status) -> Void = { _ in }
    ) {
        self.onChunk = onChunk
        self.onStatus = onStatus
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
        watchdog?.cancel()
    }

    static func requestPermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    /// Configure the session and open the microphone.
    ///
    /// `async` rather than `throws` alone because the work underneath is
    /// genuinely slow — `setActive(true)` alone negotiates the route and can
    /// take the better part of a second when a Bluetooth headset is in the
    /// picture — and every caller is on the main actor. Running it there is
    /// what made the record button feel like it did nothing.
    func start() async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            queue.async { [self] in
                do {
                    try begin()
                    cont.resume()
                } catch {
                    cont.resume(throwing: error)
                }
            }
        }
    }

    /// Close the microphone and release the session. Idempotent.
    func stop() async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            queue.async { [self] in
                end()
                cont.resume()
            }
        }
    }

    // MARK: engine lifecycle (private queue only)

    private func begin() throws {
        guard !wantsCapture else { return }
        wantsCapture = true
        do {
            try activateSession()
            try startEngine()
        } catch {
            wantsCapture = false
            teardownEngine()
            throw error
        }
        installObservers()
        startWatchdog()
    }

    private func end() {
        guard wantsCapture else { return }
        wantsCapture = false
        interrupted = false
        rebuilding = false
        recoveryAttempts = 0
        watchdog?.cancel()
        watchdog = nil
        removeObservers()
        teardownEngine()
        // `.notifyOthersOnDeactivation` so whatever we interrupted (music, a
        // podcast) resumes instead of staying paused after the meeting.
        try? AVAudioSession.sharedInstance()
            .setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func activateSession() throws {
        let session = AVAudioSession.sharedInstance()
        // .playAndRecord + .voiceChat keeps echo cancellation available for the
        // future "phone as the room mic for a desktop session" mode; .default
        // would also work for pure capture.
        try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetooth])
        try session.setActive(true)
    }

    private func startEngine() throws {
        let input = engine.inputNode
        let hwFormat = input.outputFormat(forBus: 0)
        // Right after an interruption or a route change the input node can
        // report a 0 Hz format for a beat. Building a converter against it
        // throws something unhelpful; the retry loop wants a clear signal that
        // the hardware simply is not back yet.
        guard hwFormat.sampleRate > 0, hwFormat.channelCount > 0 else {
            throw CaptureError.inputUnavailable
        }
        guard
            let target = AVAudioFormat(
                commonFormat: .pcmFormatInt16, sampleRate: Double(SonioxProtocol.sampleRate),
                channels: 1, interleaved: true),
            let converter = AVAudioConverter(from: hwFormat, to: target)
        else {
            throw CaptureError.noConverter
        }

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: hwFormat) { [weak self] buffer, _ in
            self?.convert(buffer, with: converter, target: target)
        }
        engine.prepare()
        try engine.start()
        tapFormat = hwFormat
        live = true
    }

    private func teardownEngine() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        tapFormat = nil
        live = false
    }

    /// Rebuild the engine after the system took the microphone away. Retries
    /// with backoff; gives up loudly rather than leaving a silent recording.
    private func rebuild(afterMilliseconds delay: Int) {
        guard !rebuilding else { return }
        rebuilding = true
        attemptRebuild(afterMilliseconds: delay)
    }

    private func attemptRebuild(afterMilliseconds delay: Int) {
        queue.asyncAfter(deadline: .now() + .milliseconds(delay)) { [self] in
            guard wantsCapture, !interrupted else {
                rebuilding = false
                return
            }
            do {
                teardownEngine()
                try activateSession()
                try startEngine()
                let wasBroken = recoveryAttempts > 0
                recoveryAttempts = 0
                rebuilding = false
                onStatus(wasBroken ? .resumed : .running)
            } catch {
                recoveryAttempts += 1
                guard recoveryAttempts <= Self.maxRecoveryAttempts else {
                    rebuilding = false
                    wantsCapture = false
                    teardownEngine()
                    onStatus(.failed(error.localizedDescription))
                    return
                }
                attemptRebuild(afterMilliseconds: min(4_000, 250 << recoveryAttempts))
            }
        }
    }

    /// True when the tap can no longer be trusted: the engine stopped, or the
    /// hardware format moved out from under the converter. A route change that
    /// leaves both intact (plugging in a charger, say) needs no rebuild, and
    /// rebuilding anyway would punch a hole in the audio for no reason.
    private func needsRebuild() -> Bool {
        guard live, engine.isRunning, let tapFormat else { return true }
        // Sample rate and channel count on purpose, rather than `!=` on the
        // whole format: those are what the converter was built against, and a
        // full-format comparison would also trip on a channel layout the node
        // reports differently between calls — which, on a two-second watchdog,
        // would mean rebuilding a perfectly healthy engine forever.
        let current = engine.inputNode.outputFormat(forBus: 0)
        return current.sampleRate != tapFormat.sampleRate
            || current.channelCount != tapFormat.channelCount
    }

    // MARK: system notifications

    private func installObservers() {
        let center = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()
        observers = [
            center.addObserver(
                forName: AVAudioSession.interruptionNotification, object: session, queue: nil
            ) { [weak self] note in self?.handleInterruption(note) },

            center.addObserver(
                forName: AVAudioSession.routeChangeNotification, object: session, queue: nil
            ) { [weak self] note in self?.handleRouteChange(note) },

            center.addObserver(
                forName: AVAudioSession.mediaServicesWereResetNotification, object: session,
                queue: nil
            ) { [weak self] _ in self?.handleMediaServicesReset() },

            // `object: nil` on purpose — a media-services reset replaces
            // `engine`, and an observer pinned to the old one would go deaf
            // exactly when the new engine needs watching.
            center.addObserver(
                forName: .AVAudioEngineConfigurationChange, object: nil, queue: nil
            ) { [weak self] _ in self?.handleConfigurationChange() },
        ]
    }

    private func removeObservers() {
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
    }

    private func handleInterruption(_ note: Notification) {
        guard
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }
        queue.async { [self] in
            guard wantsCapture else { return }
            switch type {
            case .began:
                interrupted = true
                // The system already stopped our IO; drop the tap so the
                // rebuild starts from whatever format we get back.
                teardownEngine()
                onStatus(.interrupted)
            case .ended:
                interrupted = false
                // `.shouldResume` is advisory and is simply absent for some
                // interruptions (a call the other side ended). A recording the
                // user never stopped always wants the microphone back, so the
                // option is deliberately not consulted.
                recoveryAttempts = 0
                rebuild(afterMilliseconds: 250)
            @unknown default:
                break
            }
        }
    }

    private func handleRouteChange(_ note: Notification) {
        guard
            let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
            let reason = AVAudioSession.RouteChangeReason(rawValue: raw)
        else { return }
        switch reason {
        case .oldDeviceUnavailable, .newDeviceAvailable, .override, .categoryChange,
            .routeConfigurationChange, .wakeFromSleep:
            queue.async { [self] in
                guard wantsCapture, !interrupted, needsRebuild() else { return }
                recoveryAttempts = 0
                rebuild(afterMilliseconds: 0)
            }
        default:
            break
        }
    }

    private func handleConfigurationChange() {
        queue.async { [self] in
            // AVAudioEngine removes taps itself on a configuration change, so
            // there is no "still fine" case to check for here.
            guard wantsCapture, !interrupted else { return }
            recoveryAttempts = 0
            rebuild(afterMilliseconds: 0)
        }
    }

    private func handleMediaServicesReset() {
        queue.async { [self] in
            guard wantsCapture else { return }
            // `mediaserverd` restarted: every audio object built against the
            // old one is a corpse, the engine included.
            teardownEngine()
            engine = AVAudioEngine()
            interrupted = false
            recoveryAttempts = 0
            onStatus(.interrupted)
            rebuild(afterMilliseconds: 250)
        }
    }

    /// Notifications are the fast path; this is the one that catches what iOS
    /// does not announce. An engine can also simply stop — and an eight-second
    /// gap the user is told about beats an hour of silence they are not.
    private func startWatchdog() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + Self.watchdogInterval, repeating: Self.watchdogInterval)
        timer.setEventHandler { [weak self] in
            guard let self, wantsCapture, !interrupted, needsRebuild() else { return }
            rebuild(afterMilliseconds: 0)
        }
        watchdog?.cancel()
        watchdog = timer
        timer.resume()
    }

    // MARK: conversion

    private func convert(
        _ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, target: AVAudioFormat
    ) {
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
        var fed = false
        converter.convert(to: out, error: nil) { _, status in
            if fed {
                status.pointee = .noDataNow
                return nil
            }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        guard out.frameLength > 0, let ch = out.int16ChannelData?[0] else { return }
        let samples = Array(UnsafeBufferPointer(start: ch, count: Int(out.frameLength)))
        var sum: Float = 0
        for s in samples {
            let f = Float(s) / 32768
            sum += f * f
        }
        let rms = (sum / Float(samples.count)).squareRoot()
        onChunk(samples, rms)
    }
}

/// Failures the capture can name. Both are recoverable in principle — the
/// microphone comes back when the route settles — so they carry copy the
/// retry loop can show if it never does.
enum CaptureError: LocalizedError {
    case inputUnavailable
    case noConverter

    var errorDescription: String? {
        switch self {
        case .inputUnavailable:
            return String(localized: "The microphone isn't available right now.")
        case .noConverter:
            return String(localized: "This device's microphone format isn't supported.")
        }
    }
}
