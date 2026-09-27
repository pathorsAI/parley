import Foundation

/// Who gets to end a dictation that is finishing: the AI polish, or the user
/// tapping the button to insert the raw words now.
///
/// A finishing session has two waits in it, one after the other — the relay
/// draining the last utterance, then the polish round trip — and "skip the
/// polish" means something different in each:
///
/// - **While the relay drains**, the last words are still arriving. Cutting
///   the drain would throw away exactly the sentence the user just finished,
///   so a skip here is only *remembered*: when the drain completes, the
///   session settles raw on the spot and no polish is ever started.
/// - **While the polish is in flight**, the raw words are complete and sitting
///   in `committed`. A skip here cancels the request and settles raw now —
///   the same ending as the polish coming back empty.
///
/// And whichever of the two endings arrives first is the only one that runs: a
/// polish that returns after the user skipped it must not settle the session
/// a second time, or overwrite text the keyboard has already inserted.
///
/// A value type with no clock and no I/O, so the race itself is unit-tested
/// here rather than trusted to the coordinator that drives it. One per
/// session; `DictationCoordinator` makes a fresh one at every launch.
public struct FinishingPolish: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        /// The session is live or the relay is still draining its tail.
        case draining
        /// The polish request is out.
        case polishing
        /// Somebody has settled the session. Nothing else may.
        case settled
    }

    /// What the caller has to do about a skip.
    public enum SkipOutcome: Equatable, Sendable {
        /// Nothing now: the drain is still running, and the skip will be
        /// honoured when it finishes (`drained` will say to settle raw).
        case afterDrain
        /// Cancel the in-flight polish and settle the raw words now.
        case settleRawNow
        /// The session has already been settled; the tap came too late to
        /// change anything.
        case tooLate
    }

    public private(set) var phase: Phase = .draining
    /// The user asked to skip while the drain was still running.
    public private(set) var skipRequested = false

    public init() {}

    /// The drain is over. Returns whether to start the polish: `false` means
    /// the caller settles with the raw words now, and this value records that
    /// it has.
    ///
    /// `wantsPolish` is everything else that decides it — the setting, a
    /// token, whether the text is long enough to be worth a round trip.
    public mutating func drained(wantsPolish: Bool) -> Bool {
        guard phase == .draining else { return false }
        if wantsPolish, !skipRequested {
            phase = .polishing
            return true
        }
        phase = .settled
        return false
    }

    /// The user tapped the button during finishing.
    public mutating func skip() -> SkipOutcome {
        switch phase {
        case .draining:
            skipRequested = true
            return .afterDrain
        case .polishing:
            phase = .settled
            return .settleRawNow
        case .settled:
            return .tooLate
        }
    }

    /// The polish came back — with text, or with nothing. Returns whether the
    /// caller may settle with it; `false` means a skip got there first.
    public mutating func polishReturned() -> Bool {
        guard phase == .polishing else { return false }
        phase = .settled
        return true
    }
}
