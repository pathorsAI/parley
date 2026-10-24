import Foundation

/// What one failed upload attempt means for the recording waiting on it.
///
/// The queue that holds finished meetings is the only copy of their audio, so
/// no answer the server can give is a reason to delete it. What a failure does
/// decide is whether the rest of the queue may go on:
///
/// - Transport failures, 5xx, and the 4xx somebody's later action clears —
///   signing in again (401), being granted access (403), waiting (408, 425,
///   429) — would fail the next item identically, so they stop the pass and
///   keep the queue in order.
/// - Every other 4xx is the server objecting to *this* request: out of quota
///   (402), a body cut off mid-transfer (400), too large (413). The entry is
///   set aside (`UploadParking`) so it stops guarding the head of the queue,
///   and it is tried again later on a long ladder rather than every pass.
public enum UploadFailureDisposition: Equatable, Sendable {
    case stopPass
    case park

    /// Statuses in the 4xx range that are cleared by something other than the
    /// request changing, and so stop the pass rather than park the entry.
    static let transient4xx: Set<Int> = [401, 403, 408, 425, 429]

    public static func of(httpStatus status: Int) -> UploadFailureDisposition {
        guard (400..<500).contains(status), !transient4xx.contains(status) else { return .stopPass }
        return .park
    }
}

/// A queued recording the server refused, kept on the phone with its audio
/// until a later attempt succeeds or the user deletes it.
///
/// Persisted inside the queue manifest, so it survives relaunches and app
/// updates. Cleared by nothing but a successful upload, which removes the
/// manifest altogether.
public struct UploadParking: Codable, Equatable, Sendable {
    public enum Reason: String, Sendable {
        /// 402: the account is out of quota. Retried on every launch (the
        /// quota may have reset in between) as well as on the ladder.
        case quota
        /// Any other refusal. Retried on the ladder only.
        case refused
    }

    /// What caused a pass to run, which decides which parked entries it may
    /// try.
    public enum Trigger: Sendable, Equatable {
        /// A foregrounding, the network coming back, the end of a meeting.
        case automatic
        /// The first pass of this process.
        case launch
        /// The user asked — a tap on the "not uploaded" row or "Retry sync
        /// now". Every parked entry is tried.
        case manual
    }

    /// The status of the most recent refusal.
    public var httpStatus: Int
    public var firstRefusedAt: Date
    public var lastRefusedAt: Date
    /// Refusals in a row, including the first.
    public var refusals: Int

    public init(httpStatus: Int, at date: Date) {
        self.httpStatus = httpStatus
        self.firstRefusedAt = date
        self.lastRefusedAt = date
        self.refusals = 1
    }

    /// The same entry, refused once more.
    public func refusedAgain(httpStatus: Int, at date: Date) -> UploadParking {
        var next = self
        next.httpStatus = httpStatus
        next.lastRefusedAt = date
        next.refusals += 1
        return next
    }

    public var reason: Reason { httpStatus == 402 ? .quota : .refused }

    /// Waits after the 1st, 2nd and 3rd refusal. Past the last rung the entry
    /// waits for the user (or, for quota, the next launch): an hour of audio
    /// is not something to keep re-sending at a server that keeps saying no.
    public static let ladder: [TimeInterval] = [3_600, 6 * 3_600, 24 * 3_600]

    /// When the ladder next allows an automatic attempt; nil once it has run
    /// out.
    public var nextAutomaticRetry: Date? {
        guard refusals >= 1, refusals <= Self.ladder.count else { return nil }
        return lastRefusedAt.addingTimeInterval(Self.ladder[refusals - 1])
    }

    /// Whether a pass started by `trigger` at `now` should try this entry.
    public func isDue(now: Date, trigger: Trigger) -> Bool {
        if trigger == .manual { return true }
        if trigger == .launch, reason == .quota { return true }
        guard let next = nextAutomaticRetry else { return false }
        return now >= next
    }
}

/// How long an audio upload may take before the request gives up.
///
/// `URLSession`'s 60 s default was written for API calls. An hour of Opus is
/// around ten megabytes, and on a weak uplink that is minutes of transfer, so
/// the allowance grows with the body: a floor for the round trip, plus the
/// time the body takes at a deliberately pessimistic 64 kbit/s, capped so a
/// request that has truly stalled is still noticed.
public enum AudioUploadTimeout {
    public static let floor: TimeInterval = 120
    public static let ceiling: TimeInterval = 1_800
    /// 64 kbit/s, in bytes per second.
    static let pessimisticBytesPerSecond: Double = 8_000

    public static func forBody(bytes: Int) -> TimeInterval {
        let transfer = Double(max(0, bytes)) / pessimisticBytesPerSecond
        return min(ceiling, floor + transfer)
    }
}
