import Foundation

/// The marked text a keyboard has sent to its host, for checking the host's
/// reports against. `setMarkedText` reaches the host asynchronously and
/// `textDidChange` reports the host's text as it was when it answered, so with
/// fast typing a report can be two or three keystrokes old.
///
/// It also decides, per field, whether the host shows marked text at all, and
/// remembers the last reading a host kept as plain text so the keyboard can put
/// the best guess in its place when it comes back.
public struct MarkedTextLog: Equatable, Sendable {
    /// Marked states sent to the host and not yet confirmed by it, oldest first.
    /// The last is what the host will show once it catches up. `""` is a state:
    /// a commit or a clear leaves the host with no marked text.
    public private(set) var pending: [String] = []

    /// The host has shown one of this field's readings back at least once:
    /// its context held the reading, or its only text was the reading. After
    /// that, a report without the reading means the user or the host moved
    /// away from it, not that the host ignores marked text.
    public private(set) var confirmed = false

    /// False once this field's host has shown that it ignores `setMarkedText`.
    /// The keyboard then shows the reading in its strip and commits with plain
    /// `insertText`, and never sets marked text in this field again.
    public private(set) var usesMarkedText = true

    /// A host that never reports back cannot grow the log past this.
    static let capacity = 32

    public init() {}

    /// What the keyboard last set; `""` when none.
    public var current: String { pending.last ?? "" }

    /// What a host report says about the composition.
    public enum Verdict: Equatable, Sendable {
        /// Consistent with a state the keyboard sent, or too little to tell.
        case consistent
        /// The host has confirmed marked text in this field before and no
        /// longer holds the reading around the caret: the caret moved, or the
        /// host rewrote its text. The composition is over.
        case left
        /// The host never showed this field's reading: it ignores marked text.
        case ignoresMarkedText
    }

    /// Record a state just sent.
    public mutating func sent(_ marked: String) {
        pending.append(marked)
        if pending.count > Self.capacity { pending.removeFirst(pending.count - Self.capacity) }
    }

    /// The host reported its text around the caret (`textDidChange`,
    /// `selectionDidChange`). Drops the states older than the newest one the
    /// report is consistent with.
    ///
    /// `nil` on both sides says nothing. Context on both sides empty says
    /// nothing either unless the host has confirmed before: it is also what a
    /// report from just before the first mark looks like. Any other report
    /// that matches no state sent means the composition is over — including
    /// before any confirmation, because hosts on iOS 26.5 leave marked text out
    /// of the context they report, so an unconfirmed field is the normal case
    /// and a report without the reading is how a caret move looks there.
    public mutating func hostReported(before: String?, after: String?) -> Verdict {
        guard pending.contains(where: { !$0.isEmpty }) else { return .consistent }
        if before == nil, after == nil { return .consistent }
        let b = before ?? "", a = after ?? ""
        if let newest = newestConsistent(before: b, after: a) {
            if !pending[newest].isEmpty, !(b.isEmpty && a.isEmpty) { confirmed = true }
            pending.removeFirst(newest)
            return .consistent
        }
        if b.isEmpty, a.isEmpty, !confirmed { return .consistent }
        return .left
    }

    /// The host has had time to answer the last `setMarkedText` and no
    /// callback has confirmed it. Only an empty field is evidence either way:
    /// the reading as the field's only text (`hasText`) confirms the mark,
    /// and a field still reporting no text at all means the host dropped it.
    /// With text around the caret nothing can be told, because hosts on
    /// iOS 26.5 leave marked text out of the context they report, and the
    /// keyboard keeps marking (fail open).
    public mutating func hostSettled(before: String?, after: String?, hasText: Bool) -> Verdict {
        guard usesMarkedText, !confirmed, !current.isEmpty else { return .consistent }
        let b = before ?? "", a = after ?? ""
        if b.isEmpty, a.isEmpty {
            if hasText {
                confirmed = true
                return .consistent
            }
            usesMarkedText = false
            pending = []
            return .ignoresMarkedText
        }
        if let newest = newestConsistent(before: b, after: a), !pending[newest].isEmpty {
            confirmed = true
            pending.removeFirst(newest)
        }
        return .consistent
    }

    /// Nothing is marked any more: a commit, a drop, the keyboard leaving.
    /// The per-field verdicts survive; see `fieldChanged()`.
    public mutating func reset() {
        pending = []
    }

    /// A different field, or the keyboard coming back: every per-field
    /// verdict starts over, and marked text is tried again.
    public mutating func fieldChanged() {
        pending = []
        confirmed = false
        usesMarkedText = true
    }

    private func newestConsistent(before: String, after: String) -> Int? {
        pending.lastIndex(where: { Self.caretIsInside($0, before: before, after: after) })
    }

    /// Whether the host shows `marked` with the caret inside it or at either end.
    /// `""` is always true. The host clips the context it reports, so a
    /// non-empty `before` shorter than the part of `marked` ahead of the caret
    /// counts when it ends that part (and `after` likewise); only an empty side
    /// is evidence that nothing is there.
    public static func caretIsInside(_ marked: String, before: String, after: String) -> Bool {
        (marked.indices + [marked.endIndex]).contains {
            let head = marked[..<$0], tail = marked[$0...]
            let headFits = before.hasSuffix(head)
                || (!before.isEmpty && before.count < head.count && head.hasSuffix(before))
            let tailFits = after.hasPrefix(tail)
                || (!after.isEmpty && after.count < tail.count && tail.hasPrefix(after))
            return headFits && tailFits
        }
    }
}

/// A reading the host kept as plain text when the keyboard went away with a
/// composition pending, and the best guess that should have replaced it.
///
/// Reminders on iOS 26.5 finalizes the marked reading as typed when its field
/// resigns, and by then no proxy edit lands — not in `textWillChange`, not in
/// `viewWillDisappear`. The keyboard can only repair it the next time it is
/// in front of that text. The keyboard keeps it in memory for the life of its
/// process only, never on disk: typed content does not outlive the process.
public struct StrandedReading: Equatable, Sendable {
    public var reading: String
    public var best: String
    public var at: Date

    /// How long a stranded reading is worth repairing. Past this the user has
    /// seen it, and may have meant it.
    public static let lifetime: TimeInterval = 30 * 60

    public init(reading: String, best: String, at: Date) {
        self.reading = reading
        self.best = best
        self.at = at
    }

    /// How many characters to delete before the caret, and what to type in
    /// their place, when the text before the caret ends with exactly this
    /// reading — spaces and tone marks included, which is what makes the
    /// match unambiguous. `nil` otherwise, or once it is too old.
    public func repair(before: String?, now: Date) -> (delete: Int, insert: String)? {
        guard !reading.isEmpty, !best.isEmpty, now.timeIntervalSince(at) < Self.lifetime,
            let before, before.hasSuffix(reading)
        else { return nil }
        return (reading.count, best)
    }
}
