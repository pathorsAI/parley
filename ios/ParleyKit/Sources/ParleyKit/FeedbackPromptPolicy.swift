import Foundation

/// When the app may ask for a report, so that asking never turns into nagging.
///
/// Two rules from the spec (§4), both per trigger and both on this device:
///
/// - **Two dismissals, then thirty days of quiet.** A prompt the user closed,
///   or let time out, or walked away from, counts as dismissed. The second
///   dismissal of the same kind of prompt silences that kind for 30 days; the
///   count starts again from zero once the quiet ends. A *sent* report does not
///   count and does not reset the count — sending is neither a dismissal nor
///   evidence that the next prompt of the kind will be welcome.
/// - **One prompt per recording per trigger.** Once a recording has been asked
///   about for a reason, it is never asked about for that reason again, sent or
///   not. Re-opening an empty recording five times is five visits, not five
///   reasons to report it.
///
/// `crash` and `manual` are exempt from both (see
/// `FeedbackTrigger.isFrequencyLimited`): one is asked about once per crash by
/// construction, the other is the user asking.
///
/// A value type with the clock passed in, so every rule is a plain test.
public struct FeedbackPromptPolicy: Codable, Equatable, Sendable {
    public static let dismissalsBeforeQuiet = 2
    public static let quietPeriod: TimeInterval = 30 * 24 * 60 * 60
    /// Enough to cover every recording a person could plausibly still be
    /// looking at; the oldest keys fall off first. Unbounded, this would grow
    /// by one key per recording opened for the life of the install.
    static let maxRememberedPrompts = 500

    /// Dismissals since the last quiet period ended, by trigger raw value.
    var dismissals: [String: Int] = [:]
    /// Trigger raw value → when its quiet period ends.
    var quietUntil: [String: Date] = [:]
    /// `"<trigger>|<recordingId>"`, oldest first.
    var prompted: [String] = []

    public init() {}

    private static func key(_ trigger: FeedbackTrigger, _ recordingId: String) -> String {
        "\(trigger.rawValue)|\(recordingId)"
    }

    /// Whether this prompt may be shown now.
    public func mayOffer(_ trigger: FeedbackTrigger, recordingId: String?, now: Date = Date())
        -> Bool
    {
        guard trigger.isFrequencyLimited else { return true }
        if let until = quietUntil[trigger.rawValue], now < until { return false }
        if let recordingId, prompted.contains(Self.key(trigger, recordingId)) { return false }
        return true
    }

    /// The prompt went on screen. From here on this recording will not be asked
    /// about for this reason again.
    public mutating func noteOffered(_ trigger: FeedbackTrigger, recordingId: String?) {
        guard trigger.isFrequencyLimited, let recordingId else { return }
        let key = Self.key(trigger, recordingId)
        guard !prompted.contains(key) else { return }
        prompted.append(key)
        if prompted.count > Self.maxRememberedPrompts {
            prompted.removeFirst(prompted.count - Self.maxRememberedPrompts)
        }
    }

    /// The prompt was closed, timed out, or left behind without being used.
    public mutating func noteDismissed(_ trigger: FeedbackTrigger, now: Date = Date()) {
        guard trigger.isFrequencyLimited else { return }
        let raw = trigger.rawValue
        // A quiet period that has run out starts the count again.
        if let until = quietUntil[raw], now >= until {
            quietUntil[raw] = nil
            dismissals[raw] = 0
        }
        let count = (dismissals[raw] ?? 0) + 1
        if count >= Self.dismissalsBeforeQuiet {
            quietUntil[raw] = now.addingTimeInterval(Self.quietPeriod)
            dismissals[raw] = 0
        } else {
            dismissals[raw] = count
        }
    }
}

/// `FeedbackPromptPolicy` persisted in `UserDefaults`. The defaults are passed
/// in so a test can use a throwaway suite.
public final class FeedbackPromptStore: @unchecked Sendable {
    public static let shared = FeedbackPromptStore(defaults: .standard)
    static let key = "feedback.promptPolicy"

    private let defaults: UserDefaults
    private let lock = NSLock()

    public init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    public var policy: FeedbackPromptPolicy {
        lock.lock()
        defer { lock.unlock() }
        return read()
    }

    public func mayOffer(_ trigger: FeedbackTrigger, recordingId: String?, now: Date = Date())
        -> Bool
    {
        policy.mayOffer(trigger, recordingId: recordingId, now: now)
    }

    public func noteOffered(_ trigger: FeedbackTrigger, recordingId: String?) {
        update { $0.noteOffered(trigger, recordingId: recordingId) }
    }

    public func noteDismissed(_ trigger: FeedbackTrigger, now: Date = Date()) {
        update { $0.noteDismissed(trigger, now: now) }
    }

    private func read() -> FeedbackPromptPolicy {
        guard let data = defaults.data(forKey: Self.key),
            let policy = try? JSONDecoder().decode(FeedbackPromptPolicy.self, from: data)
        else { return FeedbackPromptPolicy() }
        return policy
    }

    private func update(_ change: (inout FeedbackPromptPolicy) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        var policy = read()
        change(&policy)
        if let data = try? JSONEncoder().encode(policy) { defaults.set(data, forKey: Self.key) }
    }
}
