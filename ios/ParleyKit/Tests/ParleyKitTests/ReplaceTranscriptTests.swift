import XCTest

@testable import ParleyKit

/// What a re-transcription is allowed to change about a recording, and — much
/// more importantly — what it is not.
final class ReplaceTranscriptTests: XCTestCase {

    private func seg(_ id: String, _ text: String, speaker: Int = 0, start: UInt64 = 0,
        end: UInt64 = 1000
    ) -> TranscriptSegment {
        TranscriptSegment(
            id: id, source: "mix", speaker: speaker, text: text, isFinal: true,
            startMs: start, endMs: end)
    }

    /// A recording somebody has lived with: names typed in, a desktop analysis
    /// on it, meeting context filled out, filed in a folder.
    private func lovedRecording() -> RecordingMeta {
        RecordingMeta(
            raw: [
                "id": "rec-1",
                "title": "Pricing call",
                "source": "live",
                "createdAt": 1_700_000_000_000.0,
                "durationMs": 600_000.0,
                "segments": RecordingMeta.encode([seg("mix-0", "thin")]),
                "speakerNames": ["mix-0": "Jack", "mix-1": "Ada"],
                "findings": [["id": "f1", "atMs": 1000.0, "title": "Asked for 20% off", "detail": "x"]],
                "actionItems": [["id": "a1", "text": "Send the revised quote"]],
                "meetingContext": "renewal",
                "meetingBatna": "walk",
                "folderId": "folder-9",
                "analyzed": true,
                "filingSuggested": true,
                // A field only the desktop writes. The phone must round-trip it
                // untouched — that is the whole point of keeping `raw`.
                "brief": ["headline": "They will sign"],
            ])
    }

    // MARK: meta

    func testTheTranscriptIsReplacedAndNothingElseIs() {
        var meta = lovedRecording()
        meta.replaceTranscript(
            segments: [seg("mix-0", "the whole call"), seg("mix-1", "every word of it", speaker: 1)],
            durationMs: 612_000)

        XCTAssertEqual(meta.segments.map(\.text), ["the whole call", "every word of it"])
        XCTAssertEqual(meta.durationMs, 612_000)

        XCTAssertEqual(meta.title, "Pricing call")
        XCTAssertEqual(meta.speakerNames, ["mix-0": "Jack", "mix-1": "Ada"])
        XCTAssertEqual(meta.findings.map(\.title), ["Asked for 20% off"])
        XCTAssertEqual(meta.folderId, "folder-9")
        XCTAssertTrue(meta.filingSuggested)
        XCTAssertEqual((meta.raw["actionItems"] as? [[String: Any]])?.count, 1)
        XCTAssertEqual(meta.raw["meetingContext"] as? String, "renewal")
        XCTAssertEqual(
            (meta.raw["brief"] as? [String: Any])?["headline"] as? String, "They will sign")
    }

    /// A batch job's reported length can undershoot what the recording already
    /// knew about itself, and a recording that suddenly got shorter would break
    /// the player and the coverage arithmetic both.
    func testAShorterReportedDurationDoesNotShrinkTheRecording() {
        var meta = lovedRecording()
        meta.replaceTranscript(segments: [seg("mix-0", "x")], durationMs: 1_000)

        XCTAssertEqual(meta.durationMs, 600_000)
    }

    func testTheEncodedSegmentsSurviveAReadBack() {
        let segments = [
            seg("mix-0", "first", speaker: 1, start: 0, end: 2_000),
            seg("mix-1", "second", speaker: 2, start: 2_000, end: 5_500),
        ]
        var meta = RecordingMeta(raw: [:])
        meta.replaceTranscript(segments: segments, durationMs: 5_500)

        XCTAssertEqual(meta.segments, segments)
    }

    /// The tentative tail is never persisted, so everything written back reads
    /// as committed — including a segment that arrived claiming otherwise.
    func testEncodingAlwaysMarksSegmentsFinal() {
        let tentative = TranscriptSegment(
            id: "mix-tail", source: "mix", speaker: 0, text: "half a th",
            isFinal: false, startMs: 0, endMs: 500)
        let encoded = RecordingMeta.encode([tentative])

        XCTAssertEqual(encoded.first?["isFinal"] as? Bool, true)
    }

    // MARK: summary

    func testOnlyTheFactsTheTranscriptSpeaksForMove() {
        let before = CloudRecordingSummary(
            id: "rec-1", title: "Pricing call", source: "live", createdAt: 1_700_000_000_000,
            durationMs: 600_000, speakerCount: 1, findingsCount: 4, actionItemsCount: 2,
            hasAudio: true, snippet: "thin", folderId: "folder-9", updatedAt: 1_700_000_100_000)

        let after = before.replacingTranscript(
            segments: [
                seg("mix-0", "Hello."), seg("mix-1", "Hi there.", speaker: 1),
                seg("mix-2", "Shall we start?", speaker: 2),
            ],
            durationMs: 612_000)

        XCTAssertEqual(after.speakerCount, 3)
        XCTAssertEqual(after.snippet, "Hello. Hi there. Shall we start?")
        XCTAssertEqual(after.durationMs, 612_000)

        XCTAssertEqual(after.id, before.id)
        XCTAssertEqual(after.title, before.title)
        XCTAssertEqual(after.findingsCount, 4)
        XCTAssertEqual(after.actionItemsCount, 2)
        XCTAssertEqual(after.folderId, "folder-9")
        XCTAssertEqual(after.source, "live")
        XCTAssertEqual(after.createdAt, before.createdAt)
        XCTAssertTrue(after.hasAudio)
    }

    func testASnippetIsCappedSoAListRequestDoesNotCarryWholeMeetings() {
        let long = String(repeating: "字", count: 200)
        XCTAssertEqual(
            CloudRecordingSummary.snippet(of: [seg("mix-0", long)]).count, 120)
    }

    func testAnUnattributedTranscriptStillHasASpeaker() {
        XCTAssertEqual(CloudRecordingSummary.speakerCount(of: []), 0)
        XCTAssertEqual(
            CloudRecordingSummary.speakerCount(of: [seg("mix-0", "a"), seg("mix-1", "b")]), 1)
    }
}
