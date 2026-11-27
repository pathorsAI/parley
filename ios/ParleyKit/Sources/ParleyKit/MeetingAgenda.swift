import Foundation

/// One item of a meeting's agenda — the desktop's `TodoItem`
/// (`src/lib/types.ts`). A meeting started from a draft takes the draft's
/// todos as its agenda (`prep.ts`), ticks them while it runs, and the
/// recording keeps them as `agenda` (`history.ts` `agendaField`). The draft
/// itself is never written: the ticks belong to the meeting.
public struct AgendaItem: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let text: String
    public var done: Bool
    /// Who ticked it: "user" or "ai". Absent while unticked.
    public var doneBy: String?
    /// Where the AI heard it covered (meeting ms). Only on AI ticks.
    public var doneAtMs: Double?
    /// The user unticked an item the AI had ticked.
    public var aiDismissed: Bool?

    public init(
        id: String, text: String, done: Bool = false, doneBy: String? = nil,
        doneAtMs: Double? = nil, aiDismissed: Bool? = nil
    ) {
        self.id = id
        self.text = text
        self.done = done
        self.doneBy = doneBy
        self.doneAtMs = doneAtMs
        self.aiDismissed = aiDismissed
    }

    /// A draft's todo as the meeting's agenda item, its tick kept.
    public init(_ todo: CloudDraftTodo) {
        self.init(id: todo.id, text: todo.text, done: todo.done, doneBy: todo.done ? "user" : nil)
    }

    /// The user's tap — the desktop's `toggleAgendaItem`: ticking is the
    /// user's (no time point); unticking one the AI ticked marks it dismissed,
    /// so the next AI pass leaves it alone.
    public func toggled() -> AgendaItem {
        var next = self
        next.doneBy = nil
        next.doneAtMs = nil
        if !done {
            next.done = true
            next.doneBy = "user"
        } else {
            next.done = false
            if doneBy == "ai" { next.aiDismissed = true }
        }
        return next
    }

    /// The recording meta's shape: only the fields that are set.
    public var metaValue: [String: Any] {
        var out: [String: Any] = ["id": id, "text": text, "done": done]
        if let doneBy { out["doneBy"] = doneBy }
        if let doneAtMs { out["doneAtMs"] = doneAtMs }
        if let aiDismissed { out["aiDismissed"] = aiDismissed }
        return out
    }
}
