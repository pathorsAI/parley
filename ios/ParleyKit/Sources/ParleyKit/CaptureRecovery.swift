import Foundation

/// When to try to take the microphone back, how long to keep trying, and when to
/// stop pretending — as a state machine rather than as retries scattered through
/// the capture.
///
/// ## The failure this exists for
///
/// The app holds the microphone in the background (a `MicWindowState` window, or
/// a dictation the user swiped away from). Something with a higher claim on the
/// input starts: the system keyboard's dictation, Siri, a call. iOS posts
/// `AVAudioSession.interruptionNotification` `.began`, stops our IO, and the
/// recovery that used to follow made two assumptions that are both wrong in
/// exactly that situation:
///
/// 1. **That `.ended` arrives.** System services do not always post it. An
///    interruption with no end left the capture parked on `interrupted`
///    forever — and `interrupted` was also what disabled the watchdog, so the
///    one backstop for "iOS announced nothing" could not see the one case it
///    was built for.
/// 2. **That trying six times is trying.** The ladder ran out in under twelve
///    seconds. Every one of those attempts was `AVAudioSession.setActive(true)`
///    from a backgrounded app that another client had just interrupted, which
///    iOS refuses (`!pri`, `!int`, `!rec`) until the app is in the foreground
///    again. Twelve seconds of being refused, and then a capture that was
///    inert for good: nothing in the process watched for the foreground, or for
///    `mediaServicesWereReset`, so the two moments where reactivation would
///    have worked went by unnoticed.
///
/// So: probe even while interrupted (the only way to notice a missing
/// `.ended`), climb a ladder long enough to outlast a dictation rather than a
/// route change, and treat *giving up as a state that is still armed* —
/// `.lost` answers `appBecameActive` and `mediaServicesReset` with one more
/// rebuild, because those are the two events that change the answer.
///
/// Giving up is not silence. `.giveUp` is the cue to tell the keyboard that the
/// microphone is gone, which is the difference between a pane that has stopped
/// listening and a pane that only looks like it is listening.
///
/// Pure logic, no AVFoundation: the sequence that produces the bug takes a
/// minute of real time on a real phone and is three lines in a test.
public struct CaptureRecovery: Sendable, Equatable {

    /// Everything that can change the answer.
    public enum Event: Sendable, Equatable {
        /// `AVAudioSession` interruption `.began` — the system has our input.
        case interrupted
        /// `AVAudioSession` interruption `.ended`. Advisory `.shouldResume` is
        /// deliberately not part of this: a recording the user never stopped
        /// always wants the microphone back.
        case interruptionEnded
        /// A rebuild attempt opened the engine.
        case rebuildSucceeded
        /// A rebuild attempt threw. `systemHoldsInput` separates "somebody else
        /// has the input, or we are backgrounded and not allowed to take it"
        /// from "this device's audio is broken", which is the difference between
        /// a loss worth offering a restart for and one worth naming.
        case rebuildFailed(systemHoldsInput: Bool, description: String)
        /// The app came to the foreground. The one state change that reliably
        /// turns a refused `setActive(true)` into an allowed one.
        case appBecameActive
        /// `mediaserverd` restarted: every audio object in the process is a
        /// corpse, and the session the other client was holding died with it.
        case mediaServicesReset
        /// The engine can no longer be trusted for a reason that is ours rather
        /// than the system's — a route change, a configuration change, the
        /// watchdog noticing it stopped. Nobody is holding the input, so there
        /// is nothing to wait for.
        case engineStopped
        /// A fresh `start()` — the user tapped. Everything this policy was
        /// remembering belongs to the capture that is being replaced.
        case restarted
    }

    /// What the capture should do about it.
    public enum Action: Sendable, Equatable {
        /// Nothing, and in particular not a rebuild: either the engine is fine
        /// or a chain is already climbing the ladder.
        case wait
        /// Rebuild the engine after this delay. Zero means now.
        case rebuild(afterMilliseconds: Int)
        /// The ladder ran out. Tell the keyboard, and stay armed.
        case giveUp(Loss)
    }

    /// Why the microphone is gone, in the only terms a user can act on.
    public enum Loss: Sendable, Equatable {
        /// Something else has the input, or iOS will not let a backgrounded app
        /// take it back. A trip through the foreground fixes it, which is what
        /// the keyboard's copy offers.
        case takenBySystem
        /// The audio stack itself refused, with a reason worth repeating.
        case broken(String)
    }

    public enum Phase: Sendable, Equatable {
        /// The microphone is ours.
        case running
        /// `.began` arrived and `.ended` has not. Probes run anyway.
        case interrupted
        /// A rebuild chain is climbing the ladder.
        case recovering
        /// The ladder ran out and the keyboard has been told. Still armed: a
        /// foreground trip or a media-services reset starts a fresh chain.
        case lost
    }

    /// How long to wait before probing an interruption that has not announced
    /// its end. Long enough not to snatch the input back from whatever is
    /// mid-sentence in it, short enough that a dictation the user cancelled
    /// after a second is not paid for in ten.
    public var probeAfterMilliseconds: Int
    /// How long to wait after `.ended`. The route is still settling; the input
    /// node reports 0 Hz for a beat if asked immediately.
    public var resumeAfterMilliseconds: Int
    public var firstBackoffMilliseconds: Int
    public var backoffCapMilliseconds: Int
    /// Attempts before the keyboard is told. Twelve at this ladder is roughly
    /// half a minute of trying — long enough to outlast a system dictation,
    /// where six attempts (under twelve seconds) could only ever outlast a
    /// route change.
    public var maxAttempts: Int

    public private(set) var phase: Phase = .running
    /// Consecutive failed rebuilds in the current chain.
    public private(set) var attempts = 0
    /// The chain started with the system taking the input. Kept because the
    /// *last* error need not be the one that explains the situation — a probe
    /// refused while Siri holds the mic can surface as a 0 Hz input node — and
    /// what the user is told has to describe what happened, not the last thing
    /// that went wrong.
    private var beganWithInterruption = false

    public init(
        probeAfterMilliseconds: Int = 2_500,
        resumeAfterMilliseconds: Int = 250,
        firstBackoffMilliseconds: Int = 250,
        backoffCapMilliseconds: Int = 4_000,
        maxAttempts: Int = 12
    ) {
        self.probeAfterMilliseconds = probeAfterMilliseconds
        self.resumeAfterMilliseconds = resumeAfterMilliseconds
        self.firstBackoffMilliseconds = firstBackoffMilliseconds
        self.backoffCapMilliseconds = backoffCapMilliseconds
        self.maxAttempts = maxAttempts
    }

    /// The microphone is not ours right now, whether or not anyone has been
    /// told yet. `AudioCapture` reports this as "not capturing", which is what
    /// stops the next dictation from borrowing a capture that cannot hear.
    public var holdsMicrophone: Bool { phase == .running }

    /// The keyboard has been told. Still armed — see `Phase.lost`.
    public var hasGivenUp: Bool { phase == .lost }

    /// `1×, 2×, 4×, …` the first backoff, capped. Shift rather than `pow` for
    /// the same reason `ReconnectPolicy` uses one: exact, and it cannot drift
    /// past the cap through floating point.
    public func backoff(forAttempt attempt: Int) -> Int {
        guard attempt >= 1 else { return firstBackoffMilliseconds }
        let steps = min(attempt - 1, 30)
        let scaled = firstBackoffMilliseconds << steps
        return min(scaled, backoffCapMilliseconds)
    }

    /// Total time the ladder spends trying before the keyboard is told,
    /// counting from the first failure. Exists for the test that keeps this
    /// honest about outlasting a system dictation.
    public var ladderMilliseconds: Int {
        guard maxAttempts > 1 else { return 0 }
        return (1..<maxAttempts).reduce(0) { $0 + backoff(forAttempt: $1) }
    }

    public mutating func apply(_ event: Event) -> Action {
        switch event {
        case .restarted:
            phase = .running
            attempts = 0
            beganWithInterruption = false
            return .wait

        case .rebuildSucceeded:
            phase = .running
            attempts = 0
            beganWithInterruption = false
            return .wait

        case .interrupted:
            beganWithInterruption = true
            // A second `.began` for an interruption already being handled says
            // nothing new, and answering it with another probe would only put a
            // second chain on the same engine.
            guard phase == .running else { return .wait }
            phase = .interrupted
            attempts = 0
            // A probe rather than a wait. This is the *only* thing that can
            // notice an interruption whose `.ended` never comes — and being
            // refused while the other client still holds the input costs one
            // throw, which is what the ladder is for.
            return .rebuild(afterMilliseconds: probeAfterMilliseconds)

        case .interruptionEnded:
            // From `.lost` too: the system announcing that it is done with the
            // microphone is the best reason there has ever been to try again,
            // whatever this policy had concluded before it.
            phase = .recovering
            attempts = 0
            return .rebuild(afterMilliseconds: resumeAfterMilliseconds)

        case .appBecameActive:
            // The refusal that burned the ladder was "you are in the background
            // and somebody else is running". Being in the foreground is the
            // other half of that answer.
            guard phase != .running else { return .wait }
            phase = .recovering
            attempts = 0
            return .rebuild(afterMilliseconds: 0)

        case .mediaServicesReset:
            phase = .recovering
            attempts = 0
            return .rebuild(afterMilliseconds: resumeAfterMilliseconds)

        case .engineStopped:
            phase = .recovering
            attempts = 0
            return .rebuild(afterMilliseconds: 0)

        case .rebuildFailed(let systemHoldsInput, let description):
            // Already given up: a straggler from the chain that gave up is not
            // a reason to tell the keyboard twice.
            guard phase != .lost else { return .wait }
            attempts += 1
            if systemHoldsInput { beganWithInterruption = true }
            guard attempts < maxAttempts else {
                phase = .lost
                return .giveUp(
                    beganWithInterruption || systemHoldsInput
                        ? .takenBySystem : .broken(description))
            }
            phase = .recovering
            return .rebuild(afterMilliseconds: backoff(forAttempt: attempts))
        }
    }
}
