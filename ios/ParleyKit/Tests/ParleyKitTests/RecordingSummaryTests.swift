import Foundation
import XCTest

@testable import ParleyKit

final class BriefMarkupTests: XCTestCase {

    func testBoldAndTimestampsBecomeRuns() {
        let paragraphs = BriefMarkup.paragraphs("**Progress:** accepted at 22k [1:34], demo next week [1:48].")
        XCTAssertEqual(paragraphs.count, 1)
        XCTAssertEqual(
            paragraphs[0],
            [
                .text("Progress:", bold: true),
                .text(" accepted at 22k ", bold: false),
                .timestamp(ms: 94_000, label: "1:34"),
                .text(", demo next week ", bold: false),
                .timestamp(ms: 108_000, label: "1:48"),
                .text(".", bold: false),
            ])
    }

    func testBlankLinesSeparateParagraphsAndSingleNewlinesStay() {
        let paragraphs = BriefMarkup.paragraphs("one\ntwo\n\n\nthree")
        XCTAssertEqual(paragraphs, [[.text("one\ntwo", bold: false)], [.text("three", bold: false)]])
    }

    func testBracketsThatAreNotClocksStayText() {
        XCTAssertEqual(
            BriefMarkup.paragraphs("see [note] and [1:5] and [61:00]"),
            [[.text("see [note] and [1:5] and ", bold: false), .timestamp(ms: 3_660_000, label: "61:00")]])
    }

    func testAnUnclosedBoldMarkerIsLiteral() {
        XCTAssertEqual(BriefMarkup.paragraphs("2 ** 3"), [[.text("2 ** 3", bold: false)]])
    }

    func testHeadingsAndBullets() {
        XCTAssertEqual(
            BriefMarkup.paragraphs("## Risks\n- price [0:43]"),
            [[
                .text("Risks", bold: true),
                .text("\n• price ", bold: false),
                .timestamp(ms: 43_000, label: "0:43"),
            ]])
    }

    func testClockParsing() {
        XCTAssertEqual(BriefMarkup.milliseconds("0:08"), 8_000)
        XCTAssertEqual(BriefMarkup.milliseconds("1:02:03"), 3_723_000)
        XCTAssertNil(BriefMarkup.milliseconds("1:60"))
        XCTAssertNil(BriefMarkup.milliseconds("abc"))
        XCTAssertNil(BriefMarkup.milliseconds("12"))
    }
}

final class RecordingMetaAnalysisTests: XCTestCase {

    private func meta(_ extra: [String: Any]) -> RecordingMeta {
        var raw: [String: Any] = ["id": "rec-1", "title": "T"]
        raw.merge(extra) { $1 }
        return RecordingMeta(raw: raw)
    }

    func testNoAnalysisMeansNothingToSummarise() {
        let empty = meta(["findings": [Any](), "actionItems": [Any](), "brief": "  "])
        XCTAssertFalse(empty.hasAnalysis)
        XCTAssertEqual(empty.brief, "")
        XCTAssertTrue(empty.actionItems.isEmpty)
    }

    func testAnyOfTheThreeCountsAsAnalysis() {
        XCTAssertTrue(meta(["brief": "Short."]).hasAnalysis)
        XCTAssertTrue(meta(["findings": [["title": "A", "atMs": 1.0]]]).hasAnalysis)
        XCTAssertTrue(meta(["actionItems": [["id": "a", "text": "Do it", "done": false]]]).hasAnalysis)
    }

    func testActionItemsReadAndTick() {
        var m = meta([
            "actionItems": [
                ["id": "a", "text": "Send the quote", "done": false, "atMs": 12_500.0, "severity": "warn"],
                ["id": "b", "text": "Book the demo", "done": true, "atMs": NSNull()],
                ["id": "c", "text": "   "],
            ]
        ])
        XCTAssertEqual(
            m.actionItems,
            [
                .init(id: "a", text: "Send the quote", done: false, atMs: 12_500),
                .init(id: "b", text: "Book the demo", done: true, atMs: nil),
            ])
        m.setActionItem("a", done: true)
        XCTAssertEqual(m.actionItems.map(\.done), [true, true])
        // Fields the phone does not model survive the tick.
        let first = (m.raw["actionItems"] as? [[String: Any]])?.first
        XCTAssertEqual(first?["severity"] as? String, "warn")
    }

    func testFilingSuggestionRoundTripsAndClearsToNull() {
        var m = meta([:])
        XCTAssertNil(m.filingSuggestion)
        let suggestion = FilingSuggestion(
            title: "Hongsheng · discovery",
            folders: [
                FilingFolderSuggestion(folderId: nil, name: "Hongsheng", reason: "the customer"),
                FilingFolderSuggestion(folderId: "f-1", name: "Leads", reason: ""),
            ])
        m.filingSuggestion = suggestion
        XCTAssertEqual(m.filingSuggestion, suggestion)
        m.filingSuggestion = nil
        XCTAssertNil(m.filingSuggestion)
        XCTAssertTrue(m.raw["filingSuggestion"] is NSNull, "cleared the way the desktop clears it")
    }

    func testFindingsCarrySeverity() {
        let m = meta(["findings": [["title": "B", "atMs": 5.0, "severity": "critical"], ["title": "A", "atMs": 1.0]]])
        XCTAssertEqual(m.findings.map(\.title), ["A", "B"])
        XCTAssertEqual(m.findings.map(\.severity), ["info", "critical"])
    }
}

final class SampleManifestAnalysisTests: XCTestCase {

    private let json = """
        {
          "id": "sample-hongsheng-en-v1", "lang": "en", "title": "Sample: first call",
          "audio": "sample-en.ogg", "durationMs": 20000,
          "speakers": { "me": "You", "them": "Mr. Lin" },
          "segments": [
            { "speaker": "me", "startMs": 300, "endMs": 7015, "text": "Good afternoon." },
            { "speaker": "them", "startMs": 7665, "endMs": 18608, "text": "Afternoon." }
          ],
          "questions": ["Q1"],
          "suggestion": { "title": "Hongsheng · discovery call",
                          "folders": [{ "name": "Hongsheng Technology", "reason": "The customer" }] },
          "brief": "**Call.** Pain at night [0:07].",
          "findings": [{ "atMs": 7665, "side": "them", "severity": "warn", "title": "Night calls",
                         "detail": "Nobody answers.", "quotes": ["after 8 pm"] }],
          "actionItems": [{ "text": "Send the quote", "atMs": 15000 }, { "text": "Book the demo" }]
        }
        """

    private func folder(_ id: String, _ name: String, updated: Double?, org: String? = nil) -> CloudFolder {
        CloudFolder(id: id, name: name, orgId: org, createdAt: 0, updatedAt: updated)
    }

    func testAnalysisDecodesAndReachesTheMeta() throws {
        let manifest = try SampleManifest.decode(Data(json.utf8))
        XCTAssertEqual(manifest.findings.count, 1)
        XCTAssertEqual(manifest.actionItems.count, 2)

        let meta = manifest.meta(
            createdAt: 1, folderId: nil, title: "Renamed",
            doneActionItems: [SampleManifest.actionItemID(1)], suggestionPending: true)
        XCTAssertEqual(meta.title, "Renamed")
        XCTAssertTrue(meta.hasAnalysis)
        XCTAssertEqual(meta.brief, "**Call.** Pain at night [0:07].")
        XCTAssertEqual(meta.findings.first?.severity, "warn")
        XCTAssertEqual(meta.findings.first?.atMs, 7665)
        XCTAssertEqual(meta.actionItems.map(\.done), [false, true])
        XCTAssertEqual(meta.actionItems.map(\.atMs), [15_000, nil])
        XCTAssertEqual(meta.filingSuggestion?.title, "Hongsheng · discovery call")
        XCTAssertEqual(meta.filingSuggestion?.folders.map(\.folderId), [nil])
    }

    func testAnAnsweredSuggestionIsNotInTheMeta() throws {
        let manifest = try SampleManifest.decode(Data(json.utf8))
        XCTAssertNil(manifest.meta(createdAt: 1, folderId: nil).filingSuggestion)
    }

    func testAnOlderManifestWithoutAnalysisStillDecodes() throws {
        let old = """
            { "id": "sample-x", "lang": "en", "title": "T", "audio": "a.ogg", "durationMs": 1,
              "speakers": { "me": "A", "them": "B" }, "segments": [], "questions": [] }
            """
        let manifest = try SampleManifest.decode(Data(old.utf8))
        XCTAssertNil(manifest.suggestion)
        XCTAssertFalse(manifest.meta(createdAt: 1, folderId: nil).hasAnalysis)
        XCTAssertNil(manifest.filingSuggestion(existingFolders: []))
    }

    func testChipsAreTheNewFolderPlusTwoRecentExistingOnes() throws {
        let manifest = try SampleManifest.decode(Data(json.utf8))
        let chips = manifest.filingSuggestion(existingFolders: [
            folder("old", "Old", updated: 10),
            folder("recent", "Recent", updated: 300),
            folder("mid", "Mid", updated: 200),
            folder("team", "Team", updated: 999, org: "org-1"),
        ])?.folders
        XCTAssertEqual(chips?.map(\.name), ["Hongsheng Technology", "Recent", "Mid"])
        XCTAssertEqual(chips?.map(\.folderId), [nil, "recent", "mid"])
    }

    func testAProposedFolderTheUserAlreadyHasPointsAtIt() throws {
        let manifest = try SampleManifest.decode(Data(json.utf8))
        let chips = manifest.filingSuggestion(existingFolders: [
            folder("hs", "hongsheng technology", updated: 1)
        ])?.folders
        XCTAssertEqual(chips?.map(\.folderId), ["hs"], "no duplicate chip for the same folder")
    }

    func testCodableRoundTrip() throws {
        let manifest = try SampleManifest.decode(Data(json.utf8))
        let again = try SampleManifest.decode(JSONEncoder().encode(manifest))
        XCTAssertEqual(again, manifest)
    }

    /// The manifests the app actually ships, from `public/sample/`. A render
    /// that drops or renames a field fails here rather than on a phone.
    func testTheShippedManifestsCarryTheirAnalysis() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("public/sample")
        for lang in ["en", "zh-TW"] {
            let url = root.appendingPathComponent("sample.\(lang).json")
            guard let data = try? Data(contentsOf: url) else {
                throw XCTSkip("public/sample is not next to this checkout")
            }
            let manifest = try SampleManifest.decode(data)
            XCTAssertNotNil(manifest.suggestion, lang)
            XCTAssertFalse(manifest.findings.isEmpty, lang)
            XCTAssertFalse(manifest.actionItems.isEmpty, lang)
            let brief = BriefMarkup.paragraphs(manifest.brief ?? "")
            let stamps = brief.flatMap { $0 }.filter {
                if case .timestamp = $0 { return true } else { return false }
            }
            XCTAssertFalse(stamps.isEmpty, "\(lang) brief links into the recording")
            for finding in manifest.findings {
                XCTAssertLessThanOrEqual(finding.atMs, manifest.durationMs, lang)
            }
        }
    }
}

final class TranscriptAnchorTests: XCTestCase {

    private func seg(_ id: String, _ start: UInt64) -> TranscriptSegment {
        TranscriptSegment(
            id: id, source: "mix", speaker: 1, text: id, isFinal: true, startMs: start,
            endMs: start + 1_000)
    }

    func testAFlooredClockLandsOnTheTurnItNames() {
        let segments = [seg("a", 300), seg("b", 8_900), seg("c", 18_076)]
        // The brief says [0:08] for the turn that starts at 8.9 s.
        XCTAssertEqual(TranscriptAnchor.turn(at: 8_000, in: segments)?.id, "b")
        XCTAssertEqual(TranscriptAnchor.seekMs(for: 8_000, in: segments), 8_900)
    }

    func testAMomentInsideATurnStaysThere() {
        let segments = [seg("a", 300), seg("b", 8_900), seg("c", 18_076)]
        XCTAssertEqual(TranscriptAnchor.turn(at: 12_000, in: segments)?.id, "b")
        XCTAssertEqual(TranscriptAnchor.seekMs(for: 12_000, in: segments), 12_000)
    }

    func testBeforeEverythingIsTheFirstTurnAndNothingIsNil() {
        XCTAssertEqual(TranscriptAnchor.turn(at: 0, in: [seg("a", 5_000)])?.id, "a")
        XCTAssertNil(TranscriptAnchor.turn(at: 0, in: []))
    }
}
