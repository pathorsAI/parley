import Foundation
import ParleyKit

/// What a recording's transcript looked like the last time this process loaded
/// it, by recording id — so the Library can tell, at the moment of a delete,
/// whether the recording being deleted had come back empty or cut short.
///
/// ## Why the Library needs help
///
/// `delete_failed` is the "tried it, was disappointed, cleaned up" signal, and
/// the Library is where the delete happens — but a library row carries only a
/// duration and a 120-character preview. That is enough to recognise an empty
/// transcript (a long recording with no preview), and not enough to recognise a
/// truncated one, which needs to know where the words stop. The detail screen
/// knows exactly that, and the usual path to deleting a disappointing
/// recording goes through opening it first. So the screen leaves the numbers
/// here, and the Library reads them back.
///
/// In memory only: it describes recordings this process has seen, and it
/// holds numbers about them, never their words.
@MainActor
enum TranscriptHealthCache {
    struct Health: Sendable, Equatable {
        let durationMs: Double
        let transcriptSegments: Int
        let lastSegmentEndMs: UInt64
        let isEmpty: Bool
        let truncatedAt: UInt64?

        init(durationMs: Double, segments: [TranscriptSegment]) {
            self.durationMs = durationMs
            transcriptSegments = FeedbackConditions.transcriptSegmentCount(segments)
            lastSegmentEndMs = FeedbackConditions.lastSegmentEndMs(segments)
            isEmpty = FeedbackConditions.isEmptyTranscript(durationMs: durationMs, segments: segments)
            truncatedAt = FeedbackConditions.truncatedAt(durationMs: durationMs, segments: segments)
        }

        /// The empty case, read off a library row: long enough, and no preview
        /// line at all. The preview is built from the first segments' text, so
        /// an empty one is a transcript with no words.
        init?(row: CloudRecordingSummary) {
            // A row with no preview field at all says nothing either way — an
            // older writer, not an empty transcript — so only a present, blank
            // one counts.
            guard row.durationMs >= FeedbackConditions.emptyMinimumMs,
                let snippet = row.snippet,
                snippet.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { return nil }
            durationMs = row.durationMs
            transcriptSegments = 0
            lastSegmentEndMs = 0
            isEmpty = true
            truncatedAt = nil
        }

        var failed: Bool { isEmpty || truncatedAt != nil }

        func context(recordingId: String) -> FeedbackDiagnostics.Context {
            .init(
                recordingId: recordingId, recordingDurationMs: Int(durationMs),
                transcriptSegments: transcriptSegments, lastSegmentEndMs: Int(lastSegmentEndMs))
        }
    }

    private static var entries: [String: Health] = [:]

    static func note(id: String, durationMs: Double, segments: [TranscriptSegment]) {
        entries[id] = Health(durationMs: durationMs, segments: segments)
    }

    static func health(for id: String) -> Health? { entries[id] }

    static func forget(_ id: String) { entries[id] = nil }
}
