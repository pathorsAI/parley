import Foundation

// Meeting drafts, read-only on the phone (#772). A draft is everything the
// desktop prepared for one upcoming meeting — title, time, the context, the
// agenda — saved to Parley Cloud by the desktop's draft sync
// (`src/lib/cloud/draftSync.ts`) or by an AI over the cloud MCP. The phone
// only reads them (`GET /v1/drafts`); creating, editing and deleting stay on
// the desktop, so nothing here ever writes one back.
//
// The ordering and the "starting soon" split are the desktop's own
// (`sortDrafts`, `isOver`, `isStartingSoon` in `src/lib/store/prep.ts`, and
// `untilStart` in `src/lib/meeting/timeSlots.ts`), ported as pure functions so
// `swift test` holds them to the desktop's cases.

/// One agenda item of a draft, as the cloud stores it.
public struct CloudDraftTodo: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let text: String
    public let done: Bool

    public init(id: String, text: String, done: Bool = false) {
        self.id = id
        self.text = text
        self.done = done
    }

    private enum CodingKeys: String, CodingKey { case id, text, done }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
        done = (try? c.decodeIfPresent(Bool.self, forKey: .done)) ?? false
    }
}

/// A draft as `GET /v1/drafts` returns it — only the fields the phone shows.
/// The negotiation fields, the playbook and the org share ride along in the
/// response and are ignored here.
///
/// Read defensively, as the desktop's `fromCloudDraft` does: a malformed
/// field falls back to empty instead of failing the row.
public struct CloudMeetingDraft: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    /// Epoch ms the meeting starts; nil = no time set yet.
    public let meetingAt: Double?
    /// Epoch ms it ends; nil = an hour after it starts.
    public let meetingEndAt: Double?
    public let meetingContext: String
    public let todos: [CloudDraftTodo]
    /// The personal folder the recording will be filed into.
    public let meetingFolderId: String?
    /// Epoch ms of the last change.
    public let updatedAt: Double
    /// Epoch ms of the deletion; nil = live.
    public let deletedAt: Double?

    public init(
        id: String, title: String, meetingAt: Double? = nil, meetingEndAt: Double? = nil,
        meetingContext: String = "", todos: [CloudDraftTodo] = [],
        meetingFolderId: String? = nil, updatedAt: Double = 0, deletedAt: Double? = nil
    ) {
        self.id = id
        self.title = title
        self.meetingAt = meetingAt
        self.meetingEndAt = meetingEndAt
        self.meetingContext = meetingContext
        self.todos = todos
        self.meetingFolderId = meetingFolderId
        self.updatedAt = updatedAt
        self.deletedAt = deletedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, meetingAt, meetingEndAt, meetingContext, todos, meetingFolderId,
            updatedAt, deletedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        meetingAt = Self.finite(try? c.decodeIfPresent(Double.self, forKey: .meetingAt))
        meetingEndAt = Self.finite(try? c.decodeIfPresent(Double.self, forKey: .meetingEndAt))
        meetingContext = (try? c.decodeIfPresent(String.self, forKey: .meetingContext)) ?? ""
        // `Lossy` (LexiconStore): one bad agenda item costs that item.
        let rawTodos: [Lossy<CloudDraftTodo>] =
            ((try? c.decodeIfPresent([Lossy<CloudDraftTodo>].self, forKey: .todos)) ?? nil) ?? []
        todos = rawTodos.compactMap { $0.value }
        meetingFolderId = try? c.decodeIfPresent(String.self, forKey: .meetingFolderId)
        updatedAt = Self.finite(try? c.decodeIfPresent(Double.self, forKey: .updatedAt)) ?? 0
        deletedAt = Self.finite(try? c.decodeIfPresent(Double.self, forKey: .deletedAt))
    }

    private static func finite(_ v: Double??) -> Double? {
        guard let v = v ?? nil, v.isFinite else { return nil }
        return v
    }
}

/// `GET /v1/drafts`'s body: the drafts and the server's clock.
public struct DraftListResponse: Decodable, Sendable {
    public let drafts: [CloudMeetingDraft]

    private enum CodingKeys: String, CodingKey { case drafts }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let rows = try c.decode([Lossy<CloudMeetingDraft>].self, forKey: .drafts)
        drafts = rows.compactMap { $0.value }
    }
}

/// The desktop's draft lists, as pure functions of the drafts and the clock.
public enum MeetingDraftSchedule {
    /// How far ahead 即將開始的會議 looks: a meeting moves up there an hour
    /// before it starts. Also how long a meeting without an end time runs.
    public static let startingSoonMs: Double = 60 * 60_000

    /// The live drafts of a pull: the tombstones (`deletedAt`) left out.
    public static func live(_ drafts: [CloudMeetingDraft]) -> [CloudMeetingDraft] {
        drafts.filter { $0.deletedAt == nil }
    }

    /// The end of a timed draft's meeting: its end time, or an hour after it
    /// starts.
    private static func end(_ d: CloudMeetingDraft, start: Double) -> Double {
        d.meetingEndAt ?? start + startingSoonMs
    }

    /// Has this draft's meeting come and gone? Untimed drafts never have.
    public static func isOver(_ d: CloudMeetingDraft, now: Double) -> Bool {
        guard let start = d.meetingAt else { return false }
        return end(d, start: start) <= now
    }

    /// Is this draft's meeting about to start (within an hour) or under way?
    /// A meeting without an end time counts as running for an hour.
    public static func isStartingSoon(_ d: CloudMeetingDraft, now: Double) -> Bool {
        guard let start = d.meetingAt else { return false }
        return start <= now + startingSoonMs && !isOver(d, now: now)
    }

    /// The order the draft lists show: timed drafts soonest first, then the
    /// untimed ones, newest first. Given `now`, a meeting already over drops
    /// below both, the latest first, so the next meeting is always on top.
    public static func sorted(_ drafts: [CloudMeetingDraft], now: Double? = nil)
        -> [CloudMeetingDraft]
    {
        func rank(_ d: CloudMeetingDraft) -> Int {
            guard d.meetingAt != nil else { return 1 }
            if let now, isOver(d, now: now) { return 2 }
            return 0
        }
        // Stable, like the desktop's `Array.prototype.sort`: ties keep their
        // input order.
        return drafts.enumerated().sorted { lhs, rhs in
            let (a, b) = (lhs.element, rhs.element)
            let (ra, rb) = (rank(a), rank(b))
            if ra != rb { return ra < rb }
            if let ta = a.meetingAt, let tb = b.meetingAt, ta != tb {
                return ra == 2 ? ta > tb : ta < tb
            }
            if a.meetingAt == nil, b.meetingAt == nil, a.updatedAt != b.updatedAt {
                return a.updatedAt > b.updatedAt
            }
            return lhs.offset < rhs.offset
        }.map(\.element)
    }

    /// 總覽's split: the meetings starting within the hour (or under way), and
    /// every other draft. Both in `sorted` order.
    public static func split(_ drafts: [CloudMeetingDraft], now: Double)
        -> (startingSoon: [CloudMeetingDraft], later: [CloudMeetingDraft])
    {
        let ordered = sorted(live(drafts), now: now)
        return (
            ordered.filter { isStartingSoon($0, now: now) },
            ordered.filter { !isStartingSoon($0, now: now) }
        )
    }

    /// How long until a meeting starts, as the row says it: minutes, then
    /// hours, then days — or that it has started.
    public enum Until: Equatable, Sendable {
        case started
        case minutes(Int)
        case hours(Int)
        case days(Int)
    }

    public static func untilStart(_ startMs: Double, now: Double) -> Until {
        let minutes = Int(((startMs - now) / 60_000).rounded(.up))
        if minutes <= 0 { return .started }
        if minutes < 60 { return .minutes(minutes) }
        if minutes < 24 * 60 { return .hours(jsRound(Double(minutes) / 60)) }
        return .days(jsRound(Double(minutes) / (24 * 60)))
    }

    /// JavaScript's `Math.round`: halves go up (towards +∞).
    private static func jsRound(_ x: Double) -> Int {
        Int((x + 0.5).rounded(.down))
    }
}
