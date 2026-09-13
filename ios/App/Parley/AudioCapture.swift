import AVFoundation
import Foundation
import ParleyKit
import UIKit

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
/// ## The row that was hiding inside the first
///
/// The first row has a case in it that the rebuild loop could not answer, and it
/// is the one behind the "the system's own dictation kills the Parley keyboard"
/// report: an interruption that the app cannot recover from *where it stands*.
/// iOS refuses `setActive(true)` to a backgrounded app that another client
/// interrupted, and an interruption raised by a system service does not reliably
/// post its `.ended`. The old loop answered both by burning six attempts in
/// under twelve seconds and then going inert — nothing watched for the
/// foreground, which is the one state where the activation would have been
/// allowed. `CaptureRecovery` (ParleyKit) is where that sequence now lives:
/// probe even while interrupted, a ladder long enough to outlast a dictation
/// rather than a route change, and a give-up that stays armed for the foreground
/// and says so through `onStatus(.lost)` instead of going quiet.
///
/// `@unchecked Sendable` because every mutable field is confined to `queue`:
/// start, stop, the four notification handlers, and the watchdog all run there,
/// and nothing else reads them. The single exception is the flag behind
/// `isCapturing`, which is written on `queue` like everything else but has to
/// be *readable* from off it — see there for why that read cannot simply hop
/// onto the queue and wait.
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
        /// Could not get the microphone back, and the owner has to say so.
        ///
        /// Not the end of this object: the capture stays armed and answers a
        /// foreground trip or a media-services reset with one more rebuild (see
        /// `CaptureRecovery.Phase.lost`). It does report `isCapturing == false`
        /// from here, so nothing borrows it in the meantime — a capture that
        /// might recover is still not a microphone.
        case lost(CaptureRecovery.Loss)
    }

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
    private var wantsCapture = false { didSet { publishCapturing() } }
    /// A tap is installed and the engine is running.
    private var live = false { didSet { publishCapturing() } }
    /// The system holds the microphone. The ladder still probes — that is the
    /// only way to notice an interruption that never posts its `.ended` — but
    /// nothing else (route change, configuration change, watchdog) touches the
    /// engine while this is true.
    private var interrupted = false { didSet { publishCapturing() } }
    /// The recovery ran out of attempts and the owner has been told. Kept
    /// separate from `wantsCapture`, which used to be cleared here: a capture
    /// whose `wantsCapture` is false cannot be revived by anything, cannot even
    /// be `stop()`ped properly (`end()` returns at its own guard, so the audio
    /// session was never handed back and whatever we interrupted never
    /// resumed), and is exactly the corpse this file's `isCapturing` doc warns
    /// about. `lost` says the same thing to every reader while leaving the
    /// object able to come back.
    private var lost = false { didSet { publishCapturing() } }
    /// The hardware format the current tap and converter were built for.
    private var tapFormat: AVAudioFormat?
    /// When to try again, how long to keep trying, and when to say so.
    private var recovery = CaptureRecovery()
    /// A rebuild chain is in flight. The watchdog fires every two seconds and
    /// the notifications arrive in clusters, so without this a slow recovery
    /// would end up with several chains racing each other for the same engine.
    ///
    /// It is also what keeps the ladder monotonic. The watchdog's "the engine is
    /// not running" is *true* for the whole of a recovery, and the event it feeds
    /// the policy resets the attempt count — so a watchdog allowed to speak
    /// during a chain would reset the ladder every two seconds and the recovery
    /// could never reach the end of it. A ladder that never ends is a keyboard
    /// that is never told, which is the bug wearing a different hat.
    private var rebuilding = false
    /// Bumped for every rebuild chain. A chain that has been superseded — a probe
    /// outlived by the `.ended` it was waiting for, a ladder overtaken by the app
    /// coming to the foreground — dies at its next step instead of racing the
    /// chain that replaced it.
    private var rebuildEpoch = 0

    /// What `isCapturing` reports, kept in step with the three flags above by
    /// their `didSet`. Written on `queue` like they are, read from anywhere,
    /// which is why this one field is guarded by a lock instead of by the
    /// queue. `didSet` rather than assignments at the handful of sites that
    /// move those flags, so that a mutation added later cannot forget to keep
    /// this honest — and so that the order of two assignments in the same
    /// function (`end()` clears `wantsCapture` before tearing the engine down)
    /// can never publish a moment of "capturing" that was never true.
    private var capturing = false
    private let capturingLock = NSLock()

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

    /// The standing grant, read without ever prompting. Callers that may be in
    /// the background need this: `requestPermission()` on an undetermined grant
    /// can only show its prompt from a foreground app — from the background it
    /// fails as if the user had said no, without the user ever being asked.
    static var permission: AVAudioApplication.recordPermission {
        AVAudioApplication.shared.recordPermission
    }

    /// Whether the microphone is genuinely open right now: nobody has stopped
    /// this capture, the engine is running with a tap installed, and the system
    /// is not holding the hardware.
    ///
    /// ## Why holding the object is not knowing
    ///
    /// A caller that keeps a capture alive between uses — the dictation
    /// coordinator's microphone window does exactly that — cannot tell a
    /// running capture from a dead one by the fact that it still has a
    /// reference to it. `onStatus` is a push, and a push has to be caught: the
    /// coordinator only reacts to statuses it is awake and in the right shape
    /// to hear, so a capture that gives up its rebuilds at an awkward moment
    /// can end up torn down with its owner none the wiser. What the owner then
    /// hands the next dictation is an object that will never produce another
    /// sample, and the next dictation is usually served from the background,
    /// where iOS will not let it open a microphone to recover. So this state
    /// has to be *askable*, not only announced.
    ///
    /// ## Why a mirrored flag rather than `queue.sync`
    ///
    /// The three flags this reports on are confined to `queue`, so the obvious
    /// read is `queue.sync { wantsCapture && live && !interrupted }`. The
    /// obvious read is also a way to stall the main actor for the better part
    /// of a second: every caller is `@MainActor`, and `queue` is where
    /// `setActive(true)` and every engine rebuild run — which is precisely the
    /// work in flight when a capture is sick, which is precisely when anyone
    /// thinks to ask this. A `Bool` mirrored under a lock held for one
    /// assignment answers immediately, cannot deadlock, and cannot be starved
    /// by a rebuild.
    ///
    /// It is a snapshot, and deliberately strict. A rebuild in flight reads
    /// `false` for the beat between the teardown and the engine coming back,
    /// so a caller can be told "not capturing" about a capture that would have
    /// recovered on its own. That trade is on purpose: the cost of the strict
    /// answer is opening a microphone that did not strictly need opening, and
    /// the cost of a generous one is a dictation spent listening to an engine
    /// that is never coming back.
    var isCapturing: Bool {
        capturingLock.lock()
        defer { capturingLock.unlock() }
        return capturing
    }

    private func publishCapturing() {
        let value = wantsCapture && live && !interrupted && !lost
        capturingLock.lock()
        capturing = value
        capturingLock.unlock()
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
        lost = false
        _ = recovery.apply(.restarted)
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
        // Deliberately not `guard wantsCapture`, which is what it used to be: a
        // capture that had run out of rebuild attempts cleared that flag itself,
        // so `stop()` on the one object that most needed tearing down returned
        // here having done nothing — observers left registered, the watchdog
        // still firing every two seconds, and `setActive(false)` never sent, so
        // the music the interruption paused stayed paused. `lost` is what the
        // give-up sets now, and this is idempotent without the flag.
        guard wantsCapture || lost else { return }
        wantsCapture = false
        interrupted = false
        lost = false
        rebuilding = false
        // Any chain still pending belongs to a capture that is over.
        rebuildEpoch += 1
        _ = recovery.apply(.restarted)
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

    /// Do what the recovery policy decided. The single door between
    /// `CaptureRecovery` and the engine, so every event — the four
    /// notifications, the watchdog, a foreground trip — reaches the ladder the
    /// same way and none of them can invent a retry of its own. Queue only.
    private func perform(_ action: CaptureRecovery.Action) {
        switch action {
        case .wait:
            break
        case .rebuild(let delay):
            rebuild(afterMilliseconds: delay)
        case .giveUp(let loss):
            rebuilding = false
            // Armed, not dead: `lost` stops anything borrowing this capture and
            // stops the watchdog spinning on an engine nobody can open, while
            // `wantsCapture` stays true so a foreground trip, a media-services
            // reset, or a late `.ended` can still start a fresh chain — and so
            // `stop()` can still hand the audio session back.
            lost = true
            teardownEngine()
            onStatus(.lost(loss))
        }
    }

    /// Rebuild the engine after the system took the microphone away. Retries on
    /// the policy's ladder; tells the owner rather than leaving a silent
    /// recording.
    ///
    /// Every call supersedes whatever chain was in flight rather than being
    /// dropped in favour of it, and the dedupe that used to live here now lives
    /// at the three call sites that must not interrupt a chain (see
    /// `rebuilding`). The difference matters for the commonest interruption there
    /// is: a call ending posts `.ended` while the probe scheduled by `.began` is
    /// still pending, and waiting the probe out would turn a 250 ms resume into a
    /// two-and-a-half second one.
    private func rebuild(afterMilliseconds delay: Int) {
        rebuildEpoch += 1
        rebuilding = true
        attemptRebuild(afterMilliseconds: delay, epoch: rebuildEpoch)
    }

    private func attemptRebuild(afterMilliseconds delay: Int, epoch: Int) {
        queue.asyncAfter(deadline: .now() + .milliseconds(delay)) { [self] in
            // Superseded. `rebuilding` belongs to the chain that replaced this
            // one, so it is deliberately left alone.
            guard epoch == rebuildEpoch else { return }
            guard wantsCapture else {
                rebuilding = false
                return
            }
            // No `!interrupted` guard any more, and that is the point: while the
            // system holds the input this is the only thing still asking for it
            // back, and an interruption raised by a system service does not
            // always post the `.ended` the old code waited for. Being refused
            // costs one throw and feeds the ladder; succeeding means the other
            // client let go without saying so.
            do {
                teardownEngine()
                try activateSession()
                try startEngine()
                // "Was broken" as it always meant: this chain had to work for
                // it, or the system had taken the input. A route change that
                // rebuilt first time is not news.
                let wasBroken = recovery.attempts > 0 || interrupted
                // The system evidently let go, whether or not it said so.
                interrupted = false
                lost = false
                _ = recovery.apply(.rebuildSucceeded)
                rebuilding = false
                onStatus(wasBroken ? .resumed : .running)
            } catch {
                let next = recovery.apply(
                    .rebuildFailed(
                        systemHoldsInput: Self.systemHoldsInput(error),
                        description: error.localizedDescription))
                // The chain continues inside `perform` → `rebuild`, which is a
                // no-op while `rebuilding` is set — so it is cleared first.
                rebuilding = false
                perform(next)
            }
        }
    }

    /// Whether a failed activation means "somebody else has the input" rather
    /// than "this device's audio is broken".
    ///
    /// It decides what the user is told, and the two answers are different
    /// pieces of advice: the first is fixed by bringing Parley forward, and the
    /// second is not fixed by anything the user can do from a keyboard. Every
    /// code here is the system saying the input is not ours to take right now —
    /// including the one a backgrounded app gets for being backgrounded
    /// (`insufficientPriority`, `'!pri'`, 561017449) and the one it gets for
    /// trying to interrupt a client with a stronger claim (`cannotInterruptOthers`,
    /// `'!int'`). `inputUnavailable` is ours: a 0 Hz input node is the hardware
    /// not being back yet, which is the same situation seen one layer up.
    private static func systemHoldsInput(_ error: Error) -> Bool {
        if let capture = error as? CaptureError {
            switch capture {
            case .inputUnavailable: return true
            case .noConverter: return false
            }
        }
        let code = (error as NSError).code
        return Self.systemHoldsInputCodes.contains(code)
    }

    private static let systemHoldsInputCodes: Set<Int> = Set(
        [
            AVAudioSession.ErrorCode.insufficientPriority,
            .cannotInterruptOthers,
            .cannotStartRecording,
            .isBusy,
            .siriIsRecording,
            .sessionNotActive,
            .resourceNotAvailable,
            .mediaServicesFailed,
        ].map { Int($0.rawValue) })

    /// True when the tap can no longer be trusted: the engine stopped, or the
    /// hardware format moved out from under the converter. A route change that
    /// leaves both intact (plugging in a charger, say) needs no rebuild, and
    /// rebuilding anyway would punch a hole in the audio for no reason.
    private func needsRebuild() -> Bool {
        guard !lost else { return false }
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

            // The two ways the app can come forward. This is not an audio
            // notification at all, and that is exactly why it was missing: the
            // refusal that burns the recovery ladder is
            // "backgrounded app, another client running", and the only thing
            // that changes it is the app being on screen. Without this, the one
            // moment `setActive(true)` would have succeeded went by unnoticed
            // and a capture that had given up stayed given up.
            center.addObserver(
                forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil
            ) { [weak self] _ in self?.handleAppActive() },
            // Scene activation as well as app activation: a scene coming
            // forward without the application-level note (a second window, a
            // scene restored into an already-active app) is the same fact for
            // our purposes, and the recovery ignores the event unless it is
            // waiting for something.
            center.addObserver(
                forName: UIScene.didActivateNotification, object: nil, queue: nil
            ) { [weak self] _ in self?.handleAppActive() },
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
                // A probe is scheduled from here, not only from `.ended`. Some
                // interruptions — system dictation among them — never post one.
                perform(recovery.apply(.interrupted))
            case .ended:
                interrupted = false
                // `.shouldResume` is advisory and is simply absent for some
                // interruptions (a call the other side ended). A recording the
                // user never stopped always wants the microphone back, so the
                // option is deliberately not consulted.
                perform(recovery.apply(.interruptionEnded))
            @unknown default:
                break
            }
        }
    }

    /// Parley came forward. The one event that turns the refusal a backgrounded
    /// app gets from `setActive(true)` into an activation that can succeed, so a
    /// recovery that had run out of attempts gets one more chain from here.
    private func handleAppActive() {
        queue.async { [self] in
            guard wantsCapture else { return }
            perform(recovery.apply(.appBecameActive))
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
                // Still `!interrupted`, and now `!rebuilding` as well: while a
                // recovery is climbing the ladder it owns the engine, and a route
                // change arriving in the middle of one must neither start a
                // second chain nor reset the first one's attempt count.
                guard wantsCapture, !interrupted, !rebuilding, needsRebuild() else { return }
                perform(recovery.apply(.engineStopped))
            }
        default:
            break
        }
    }

    private func handleConfigurationChange() {
        queue.async { [self] in
            // AVAudioEngine removes taps itself on a configuration change, so
            // there is no "still fine" case to check for here.
            guard wantsCapture, !interrupted, !lost, !rebuilding else { return }
            perform(recovery.apply(.engineStopped))
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
            // Reached even from `lost`, on purpose: a restarted media server
            // took the other client's session down with ours, so this is one of
            // the two events worth trying again after having given up.
            lost = false
            onStatus(.interrupted)
            perform(recovery.apply(.mediaServicesReset))
        }
    }

    /// Notifications are the fast path; this is the one that catches what iOS
    /// does not announce. An engine can also simply stop — and an eight-second
    /// gap the user is told about beats an hour of silence they are not.
    private func startWatchdog() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + Self.watchdogInterval, repeating: Self.watchdogInterval)
        timer.setEventHandler { [weak self] in
            // `!lost` lives in `needsRebuild()`: a capture that has given up
            // must not be probed every two seconds forever — the ladder had its
            // turn, and what revives it now is the foreground or a media-services
            // reset, both of which announce themselves. `!rebuilding` is the
            // other half: this fires every two seconds and "the engine is not
            // running" is true for the whole of a recovery, so a watchdog allowed
            // to speak during one would reset the ladder forever.
            guard let self, wantsCapture, !interrupted, !rebuilding, needsRebuild()
            else { return }
            perform(recovery.apply(.engineStopped))
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
