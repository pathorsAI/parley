import Foundation
import ParleyKit

/// The text Parley hands to the user's own AI: an analysis prompt, the
/// meeting's facts, and the whole transcript, as one paste.
///
/// On the phone the hand-off is the share sheet or the clipboard — ChatGPT and
/// Claude are both in the share sheet — so this is a plain string that reads
/// correctly pasted into any chat box. (The Mac additionally has MCP, which
/// reads the library directly; there is nothing to build for that here.)
///
/// The shape, in the user's language:
///
///     You are my meeting analyst. Below is the full transcript …
///     1. <question>
///     2. <question>
///     3. <question>
///     Quote the transcript's own words and give the timestamp when you answer.
///
///     Meeting: <title> (<date>)
///     Context: <context, or "not provided">
///     Speakers: <names>
///
///     --- Transcript ---
///     [m:ss] Speaker: text
enum HandoffPrompt {
    /// The three questions any meeting can answer. The sample recording asks
    /// its own instead — see `questions(for:)`.
    static var genericQuestions: [String] {
        [
            String(
                localized:
                    "What was this meeting about and what was concluded? Five sentences or fewer."),
            String(localized: "What did each side commit to? Include owner and timing."),
            String(localized: "What did I fail to ask, or should follow up on next time?"),
        ]
    }

    /// The sample's manifest carries questions written for its script — the
    /// price objection, the commitments, the unanswered question — so the
    /// first answer the user sees from their AI is a good one.
    @MainActor
    static func questions(for recordingId: String) -> [String] {
        if SampleManifest.isSample(id: recordingId),
            let manifest = SampleRecordingStore.shared.manifest,
            manifest.id == recordingId, !manifest.questions.isEmpty
        {
            return manifest.questions
        }
        return genericQuestions
    }

    static func build(
        title: String,
        date: Date,
        context: String,
        speakers: [String],
        segments: [TranscriptSegment],
        label: (TranscriptSegment) -> String,
        questions: [String]
    ) -> String {
        var lines: [String] = []
        lines.append(
            String(
                localized:
                    "You are my meeting analyst. Below is the full transcript of a meeting. Read all of it first, then answer:"
            ))
        for (index, question) in questions.enumerated() {
            lines.append("\(index + 1). \(question)")
        }
        lines.append(
            String(localized: "Quote the transcript's own words and give the timestamp when you answer."))
        lines.append("")

        let when = date.formatted(date: .abbreviated, time: .shortened)
        lines.append(String(format: String(localized: "Meeting: %1$@ (%2$@)"), title, when))
        let trimmed = context.trimmingCharacters(in: .whitespacesAndNewlines)
        lines.append(
            String(
                format: String(localized: "Context: %@"),
                trimmed.isEmpty ? String(localized: "not provided") : trimmed))
        lines.append(
            String(
                format: String(localized: "Speakers: %@"),
                speakers.formatted(.list(type: .and))))
        lines.append("")

        lines.append(String(localized: "--- Transcript ---"))
        for segment in segments {
            let line = String(
                format: String(localized: "%1$@: %2$@", comment: "Speaker name, then what they said"),
                label(segment), segment.text)
            lines.append("[\(TranscriptClipboard.clock(segment.startMs))] \(line)")
        }
        return lines.joined(separator: "\n")
    }

    /// The prompt for a recording as the detail screen holds it: the final
    /// segments, the names the meta assigns, and the meeting context if the
    /// desktop (or the sample) recorded one.
    @MainActor
    static func build(summary: CloudRecordingSummary, meta: RecordingMeta) -> String {
        let segments = meta.segments.filter { $0.isFinal }
        var speakers: [String] = []
        for segment in segments {
            let name = meta.speakerLabel(for: segment)
            if !speakers.contains(name) { speakers.append(name) }
        }
        let title =
            summary.title.isEmpty ? String(localized: "Untitled recording") : summary.title
        let createdAt = meta.createdAt > 0 ? meta.createdAt : summary.createdAt
        return build(
            title: title,
            date: Date(timeIntervalSince1970: createdAt / 1000),
            context: meta.meetingContext,
            speakers: speakers,
            segments: segments,
            label: { meta.speakerLabel(for: $0) },
            questions: questions(for: summary.id))
    }
}
