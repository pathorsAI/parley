import Foundation

/// The marked text a keyboard has sent to its host, for checking the host's
/// reports against. `setMarkedText` reaches the host asynchronously and
/// `textDidChange` reports the host's text as it was when it answered, so with
/// fast typing a report can be two or three keystrokes old.
public struct MarkedTextLog: Equatable, Sendable {
    /// Marked states sent to the host and not yet confirmed by it, oldest first.
    /// The last is what the host will show once it catches up. `""` is a state:
    /// a commit or a clear leaves the host with no marked text.
    public private(set) var pending: [String] = []

    /// A host that never reports back cannot grow the log past this.
    static let capacity = 32

    public init() {}

    /// What the keyboard last set; `""` when none.
    public var current: String { pending.last ?? "" }

    /// Record a state just sent.
    public mutating func sent(_ marked: String) {
        pending.append(marked)
        if pending.count > Self.capacity { pending.removeFirst(pending.count - Self.capacity) }
    }

    /// The host reported its text around the caret. Returns true when that is
    /// consistent with some pending state, and drops the states older than the
    /// newest consistent one. False means the host has left the composition
    /// (another field, a caret moved outside it, the host rewrote its text).
    /// With nothing pending, returns true.
    public mutating func hostReported(before: String, after: String) -> Bool {
        guard !pending.isEmpty else { return true }
        guard let newest = pending.lastIndex(where: {
            Self.caretIsInside($0, before: before, after: after)
        }) else { return false }
        pending.removeFirst(newest)
        return true
    }

    public mutating func reset() {
        pending = []
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
