import Foundation

/// The four items of the Library's getting-started checklist, in display order.
///
/// The phone's counterpart of the desktop's `GettingStartedStep`
/// (`src/lib/types.ts`). The desktop calls the last item `handedOff` because it
/// also ticks from an MCP client's first call; on the phone the hand-off is the
/// share sheet or the clipboard, so it is named for that.
public enum GettingStartedStep: String, CaseIterable, Codable, Sendable {
    case recorded
    case filed
    case replayed
    case sharedToAI
}

/// What the checklist knows, as a value.
///
/// Kept apart from the store that persists it so the rules — idempotent marks,
/// when the list is visible, who counts as an existing user — can be tested
/// with `swift test` on a Mac, which the app target has no test target for.
///
/// Philosophy, same as the desktop: each flag flips only from a real product
/// event (a recording saved, a recording filed, a seek in replay, a transcript
/// handed to an AI) and never from a tap on the checklist itself.
public struct GettingStartedState: Codable, Equatable, Sendable {
    public var recorded = false
    public var filed = false
    public var replayed = false
    public var sharedToAI = false
    /// When the user closed the list. Set, the list stays closed.
    public var dismissedAt: Date?

    public init(
        recorded: Bool = false, filed: Bool = false, replayed: Bool = false,
        sharedToAI: Bool = false, dismissedAt: Date? = nil
    ) {
        self.recorded = recorded
        self.filed = filed
        self.replayed = replayed
        self.sharedToAI = sharedToAI
        self.dismissedAt = dismissedAt
    }

    public static let total = GettingStartedStep.allCases.count

    public subscript(step: GettingStartedStep) -> Bool {
        get {
            switch step {
            case .recorded: return recorded
            case .filed: return filed
            case .replayed: return replayed
            case .sharedToAI: return sharedToAI
            }
        }
        set {
            switch step {
            case .recorded: recorded = newValue
            case .filed: filed = newValue
            case .replayed: replayed = newValue
            case .sharedToAI: sharedToAI = newValue
            }
        }
    }

    /// Tick an item. Idempotent: returns false, and changes nothing, when the
    /// item was already done — so the store can skip the write and the publish.
    @discardableResult
    public mutating func mark(_ step: GettingStartedStep) -> Bool {
        guard !self[step] else { return false }
        self[step] = true
        return true
    }

    public mutating func dismiss(at date: Date = Date()) {
        dismissedAt = date
    }

    /// How many of the four are done.
    public var done: Int {
        GettingStartedStep.allCases.filter { self[$0] }.count
    }

    public var isComplete: Bool { done == Self.total }

    /// `done / total`, for a progress bar or an accessibility value.
    public var progress: Double { Double(done) / Double(Self.total) }

    /// Shown until the user closes it or finishes all four.
    public var isVisible: Bool {
        dismissedAt == nil && !isComplete
    }

    /// Whether the Library draws the list, given what it knows so far.
    ///
    /// - `libraryLoaded`: the personal library has come back from the cloud
    ///   at least once since the screen was built.
    /// - `existingUserChecked`: the once-per-install existing-user check
    ///   (`shouldDismissForExistingLibrary`) has already run on this phone, or
    ///   the user asked for the list back from Settings — either way nothing
    ///   the load brings back can dismiss it any more.
    /// - `libraryIsEmpty`: no recordings, the sample included.
    ///
    /// A visible list waits for the load only while that check is still
    /// pending, so it cannot flash up and then vanish under an existing user.
    /// Once the check is behind it, the list is local state and is drawn at
    /// once, with the recordings filling in underneath — which is what makes
    /// "Show the getting-started list again" land on a list rather than on a
    /// spinner.
    ///
    /// One more rule, and it does need the load: an empty library shows the
    /// list even with all four done, because an empty library is exactly where
    /// someone needs the way in. "Not now" still wins.
    public func showsInLibrary(
        libraryLoaded: Bool, existingUserChecked: Bool, libraryIsEmpty: Bool
    ) -> Bool {
        if isVisible { return libraryLoaded || existingUserChecked }
        return libraryLoaded && libraryIsEmpty && dismissedAt == nil
    }

    // MARK: existing users

    /// The state a phone starts with the first time a build that has the
    /// checklist runs.
    ///
    /// `hadStoredSession` is whether the Keychain already held a session token
    /// before anything in this launch could have written one — that is, the
    /// user signed in under an earlier build. They have used Parley and do not
    /// need to be walked through it, so the list starts dismissed.
    public static func initial(hadStoredSession: Bool, now: Date = Date()) -> GettingStartedState {
        GettingStartedState(dismissedAt: hadStoredSession ? now : nil)
    }

    /// The second, later check: the first time the personal library loads.
    ///
    /// Catches the case the Keychain cannot — someone who has used Parley on a
    /// Mac and signs in on a new phone. A library that already holds recordings
    /// (the sample does not count) with nothing on the list done yet means the
    /// recordings were made elsewhere, by an existing user. Anything already
    /// ticked means the recordings are this user's first steps, and the list
    /// stays.
    public func shouldDismissForExistingLibrary(recordingCount: Int) -> Bool {
        dismissedAt == nil && done == 0 && recordingCount > 0
    }
}
