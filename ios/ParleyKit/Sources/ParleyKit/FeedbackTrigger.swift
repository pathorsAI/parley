import Foundation

/// Why a report exists. The raw values are the wire contract shared with the
/// server and the Android app — the server refuses anything outside this list
/// with a 400, so a typo here is a report that can never be delivered.
///
/// ## The shape of the whole feature
///
/// Parley's users are individuals, they are passive, and they do not write in.
/// Android 1.13 broke transcription for nearly every new user and ten days went
/// by without one report. So instead of waiting to be told, the app speaks up
/// at the moments it can see for itself that something went wrong — an empty
/// transcript, a transcript that stops half way, a recording that will not
/// sync, a microphone that kept dropping — and asks for one tap. Everything
/// that makes the report useful (version, device, route, queue, recent error
/// codes, a scrubbed log) is attached by the app, not typed by the user.
///
/// Nothing is sent that the user did not tap for, with one exception decided
/// on purpose: crash reports go automatically by default and can be turned off
/// in Settings. Recordings, transcript text and keyboard input are never sent.
public enum FeedbackTrigger: String, Codable, CaseIterable, Sendable {
    /// A recording of 20 s or more came back with no transcript at all.
    case emptyTranscript = "empty_transcript"
    /// A recording of 3 min or more whose last transcribed words end before the
    /// half-way mark.
    case truncatedTranscript = "truncated_transcript"
    /// One recording failed to sync three times running, or has waited more
    /// than a day.
    case syncFailed = "sync_failed"
    /// The microphone had to be rebuilt five or more times in one meeting.
    case micRecovery = "mic_recovery"
    /// A re-transcription finished; the chips ask what was wrong with the last
    /// one.
    case retranscribe = "retranscribe"
    /// The user deleted a recording that met the empty or truncated condition —
    /// the "tried it, was disappointed, cleaned up" pattern.
    case deleteFailed = "delete_failed"
    /// MetricKit delivered a crash or hang diagnostic from an earlier run.
    case crash = "crash"
    /// The user took a screenshot, and then tapped "Report".
    case screenshot = "screenshot"
    /// Settings › Report a problem.
    case manual = "manual"

    /// Whether the client-side frequency limits apply. A crash report is not a
    /// prompt the user can grow tired of (it is sent, or asked about once per
    /// crash), and a manual report is the user asking — neither is ever
    /// suppressed.
    public var isFrequencyLimited: Bool {
        switch self {
        case .crash, .manual: return false
        default: return true
        }
    }
}

/// The four chips shown after a re-transcription. Tag ids are wire values.
public enum RetranscribeTag: String, CaseIterable, Sendable, Identifiable {
    case misheard, missing, speakers, other
    public var id: String { rawValue }
}

/// The conditions under which the app knows something went wrong, as pure
/// functions of what the screens already hold — so the numbers the spec names
/// are stated once and tested, not re-derived inline in four views.
public enum FeedbackConditions {
    /// `empty_transcript`: 20 s is long enough that silence is not the
    /// explanation, and short enough to catch the "many 2–6 s tries" pattern's
    /// longer attempts.
    public static let emptyMinimumMs: Double = 20_000
    /// `truncated_transcript` only looks at recordings this long — shorter ones
    /// end in a natural pause often enough to make "half" meaningless.
    public static let truncatedMinimumMs: Double = 180_000
    /// …and flags one whose words stop before this share of the audio.
    public static let truncatedFraction: Double = 0.5
    /// `sync_failed`: consecutive failures of one recording.
    public static let syncFailureThreshold = 3
    /// `sync_failed`: or waiting at least this long.
    public static let syncStaleAfter: TimeInterval = 24 * 60 * 60
    /// `mic_recovery`: rebuilds in one meeting.
    public static let micRecoveryThreshold = 5

    /// The segments that count as transcript: committed, not the live tail, and
    /// not blank. The same filter the upload and the coverage check apply, so
    /// all three agree about what "the transcript" is.
    static func committed(_ segments: [TranscriptSegment]) -> [TranscriptSegment] {
        segments.filter {
            $0.isFinal && !$0.id.hasSuffix("-tail")
                && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    public static func isEmptyTranscript(durationMs: Double, segments: [TranscriptSegment]) -> Bool
    {
        durationMs >= emptyMinimumMs && committed(segments).isEmpty
    }

    /// Where the transcript stops, when it stops short enough to be the
    /// `truncated_transcript` case; nil otherwise.
    ///
    /// A recording with no transcript at all is not "truncated" here even
    /// though its last end time (none) is trivially under half — that is the
    /// empty case, and one recording is offered one of the two, not both.
    public static func truncatedAt(durationMs: Double, segments: [TranscriptSegment]) -> UInt64? {
        guard durationMs >= truncatedMinimumMs else { return nil }
        guard let lastEnd = committed(segments).map(\.endMs).max() else { return nil }
        return Double(lastEnd) < durationMs * truncatedFraction ? lastEnd : nil
    }

    public static func lastSegmentEndMs(_ segments: [TranscriptSegment]) -> UInt64 {
        committed(segments).map(\.endMs).max() ?? 0
    }

    public static func transcriptSegmentCount(_ segments: [TranscriptSegment]) -> Int {
        committed(segments).count
    }

    public static func isSyncStuck(consecutiveFailures: Int, queuedAt: Date, now: Date) -> Bool {
        consecutiveFailures >= syncFailureThreshold
            || now.timeIntervalSince(queuedAt) >= syncStaleAfter
    }

    public static func isMicRecoveryWorthAsking(_ recoveries: Int) -> Bool {
        recoveries >= micRecoveryThreshold
    }

    /// `12:05` or `1:02:05`, the transcript's own clock format, for the
    /// truncated banner's "only goes to {mm:ss}".
    public static func clock(_ ms: UInt64) -> String {
        let s = Int(ms / 1000)
        if s >= 3600 { return String(format: "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60) }
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}

/// A short, content-free name for an error, for `syncLastError` and
/// `recentErrors[].code`: `http_503`, `urlerror_-1009`, `cancelled`.
///
/// A code rather than `localizedDescription`, because a description is prose in
/// the user's language and sometimes quotes the server's response body back —
/// and a code is what someone reading the admin inbox can group by.
public enum FeedbackErrorCode {
    public static func of(_ error: Error) -> String {
        if let cloud = error as? CloudError {
            return cloud.status == 0 ? "cloud_client" : "http_\(cloud.status)"
        }
        if error is CancellationError { return "cancelled" }
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain { return "urlerror_\(ns.code)" }
        if ns.domain == NSCocoaErrorDomain { return "cocoa_\(ns.code)" }
        return "error_\(ns.code)"
    }
}
