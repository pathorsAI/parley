import Foundation

/// When to redial the relay, how long to wait, and when to stop trying.
///
/// A relay session is not resumable — every reconnect is a fresh Soniox leg —
/// so redialling costs a handshake and a new billing session, and hammering a
/// relay that is down helps nobody. The ladder doubles from one second and
/// caps, which is long enough to stop hammering and short enough that walking
/// back into Wi-Fi picks the transcript up within a breath.
///
/// Extracted from the recorders so the arithmetic is testable without a socket:
/// the failure this guards against (a session that gives up on the first blip,
/// or one that never gives up at all) is invisible in a UI test and obvious in
/// a unit test.
public struct ReconnectPolicy: Sendable, Equatable {
    /// Attempts allowed per session. Eight covers a genuinely flaky hour;
    /// past it the relay is not coming back for this recording, and the audio
    /// file is transcribed after the upload anyway.
    public var maxAttempts: Int
    public var base: Duration
    public var cap: Duration

    public init(
        maxAttempts: Int = 8, base: Duration = .seconds(1), cap: Duration = .seconds(15)
    ) {
        self.maxAttempts = maxAttempts
        self.base = base
        self.cap = cap
    }

    /// Dictation is a two-minute session someone is standing there waiting on,
    /// so it redials faster and gives up sooner than a meeting: past a few
    /// seconds the user has already stopped and tried again.
    public static let dictation = ReconnectPolicy(
        maxAttempts: 4, base: .milliseconds(500), cap: .seconds(4))

    /// What to do after the `attempt`-th consecutive failure (1-based).
    public func decide(attempt: Int) -> Decision {
        guard attempt >= 1, attempt <= maxAttempts else { return .giveUp }
        return .retry(after: delay(forAttempt: attempt))
    }

    /// 1×, 2×, 4×, 8× `base`, capped. Deterministic on purpose: one phone
    /// dialling one relay has no thundering herd to jitter away from, and a
    /// fixed ladder is a ladder that can be tested.
    public func delay(forAttempt attempt: Int) -> Duration {
        guard attempt >= 1 else { return base }
        // Shift rather than `pow`: exact, and it cannot drift past the cap
        // through floating point. 62 keeps the shift defined for any attempt
        // count someone might set.
        let steps = min(attempt - 1, 62)
        let scaled = base * (1 << steps)
        return scaled > cap ? cap : scaled
    }

    public enum Decision: Sendable, Equatable {
        case retry(after: Duration)
        /// Out of attempts: the live transcript is over for this session.
        case giveUp
    }
}
