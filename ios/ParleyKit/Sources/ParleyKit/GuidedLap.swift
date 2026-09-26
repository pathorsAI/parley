import Foundation

/// The guided lap's bar on the recording screen: which step it shows, and the
/// short ✓ it holds between two steps.
///
/// Onboarding v1 ticked a checklist on the Library and said nothing on the
/// recording itself, so a new user who opened the sample was left to guess what
/// to do there. The lap puts the next step on the screen where it is done —
/// file it, replay it, hand it to an AI — and derives that step from the same
/// checklist state (`GettingStartedState`), so a step still ticks only from the
/// real event (principle 3 of `docs/design/onboarding.md`), wherever it happens.
///
/// When a step is done while the bar is up, the bar does not jump straight to
/// the next one: it says what just happened for `hold` seconds first. That
/// moment is the lesson ("renamed and filed — every recording will do this"),
/// and a bar that swapped instantly would teach nothing. The hold is the only
/// time-dependent rule, so it lives here with an injectable clock and is
/// tested rather than eyeballed.
public struct GuidedLap: Sendable {
    public enum Step: Int, CaseIterable, Sendable, Comparable {
        case file = 1, replay, share, done

        public static func < (a: Step, b: Step) -> Bool { a.rawValue < b.rawValue }

        /// The checklist item that finishes this step. nil for `done`.
        public var item: GettingStartedStep? {
            switch self {
            case .file: return .filed
            case .replay: return .replayed
            case .share: return .sharedToAI
            case .done: return nil
            }
        }
    }

    public enum Display: Equatable, Sendable {
        /// A step to do, or the finished lap.
        case step(Step)
        /// `Step` was just done; its ✓ is being held.
        case confirmed(Step)
    }

    /// How long a ✓ stays up before the next step replaces it.
    public static let hold: TimeInterval = 1.5

    /// The first of filed → replayed → sharedToAI not yet done, else `done`.
    /// `recorded` is not a step of the lap: the bar is only ever on a recording.
    public static func step(for state: GettingStartedState) -> Step {
        for step in Step.allCases where step != .done {
            if let item = step.item, !state[item] { return step }
        }
        return .done
    }

    /// Whether the bar is drawn at all.
    ///
    /// - `isLapRecording`: the recording on screen is the sample, or the user's
    ///   only recording — the lap is about *a* recording, and on the fortieth
    ///   one it would be noise.
    /// - The checklist must still be up (not dismissed, not finished) — except
    ///   for the finish itself: a lap completed on this screen shows its "done"
    ///   step, which is exactly the moment the checklist stops being visible.
    public func isVisible(state: GettingStartedState, isLapRecording: Bool) -> Bool {
        guard isLapRecording, state.dismissedAt == nil, !closed else { return false }
        return state.isVisible || (state.isComplete && startedIncomplete)
    }

    private let now: @Sendable () -> Date
    /// The step the bar is on, as last observed.
    public private(set) var step: Step
    /// Whether this bar has seen the lap unfinished — the condition for showing
    /// its finish.
    public private(set) var startedIncomplete: Bool
    /// The ✓ being held, and until when.
    private var confirming: (step: Step, until: Date)?
    /// "Close" on the done step. Local to this bar: the lap is over anyway.
    public private(set) var closed = false

    public init(state: GettingStartedState, now: @escaping @Sendable () -> Date = { Date() }) {
        self.now = now
        step = Self.step(for: state)
        startedIncomplete = !state.isComplete
    }

    /// Take in a new checklist state. A step that moved forward starts a ✓ for
    /// the step that was up — the one the user just did.
    public mutating func observe(_ state: GettingStartedState) {
        let next = Self.step(for: state)
        if !state.isComplete { startedIncomplete = true }
        guard next != step else { return }
        if next > step {
            confirming = (step, now().addingTimeInterval(Self.hold))
        } else {
            // Backwards is a reset from Settings; nothing to confirm.
            confirming = nil
        }
        step = next
    }

    /// What to draw right now.
    public var display: Display {
        if let confirming, now() < confirming.until { return .confirmed(confirming.step) }
        return .step(step)
    }

    /// When `display` next changes by itself, so a view can schedule one
    /// redraw instead of polling. nil when nothing is being held.
    public var holdEndsAt: Date? {
        guard let confirming, now() < confirming.until else { return nil }
        return confirming.until
    }

    public mutating func close() { closed = true }
}
