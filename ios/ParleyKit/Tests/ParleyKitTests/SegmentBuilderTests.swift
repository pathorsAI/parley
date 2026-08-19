import XCTest

@testable import ParleyKit

/// Semantics ported from `src-tauri/src/transcription/common.rs::SegmentBuilder`.
/// These tests are the contract: if they diverge from the desktop's behavior,
/// the two transcripts drift.
final class SegmentBuilderTests: XCTestCase {
    private var emitted: [TranscriptSegment] = []
    private var builder: SegmentBuilder!

    override func setUp() {
        super.setUp()
        emitted = []
        builder = SegmentBuilder(source: "mix") { self.emitted.append($0) }
    }

    func testGrowingRunReemitsUnderSameId() {
        builder.pushFinal("Hello", speaker: 1, startMs: 0, endMs: 400)
        builder.emitCommitted()
        builder.pushFinal(" world", speaker: 1, startMs: 400, endMs: 800)
        builder.emitCommitted()

        XCTAssertEqual(emitted.count, 2)
        XCTAssertEqual(emitted[0].id, "mix-0")
        XCTAssertEqual(emitted[1].id, "mix-0", "growing run keeps the same id")
        XCTAssertEqual(emitted[1].text, "Hello world")
        XCTAssertTrue(emitted[1].isFinal)
        XCTAssertEqual(emitted[1].startMs, 0)
        XCTAssertEqual(emitted[1].endMs, 800)
    }

    func testSpeakerChangeCommitsAndStartsNewRun() {
        builder.pushFinal("Hi there.", speaker: 1, startMs: 0, endMs: 500)
        builder.pushFinal("Hello!", speaker: 2, startMs: 600, endMs: 900)
        builder.emitCommitted()

        // Speaker change commits run 0 solid, then the open run re-emits as mix-1.
        XCTAssertEqual(emitted.count, 2)
        XCTAssertEqual(emitted[0].id, "mix-0")
        XCTAssertEqual(emitted[0].speaker, 1)
        XCTAssertEqual(emitted[0].text, "Hi there.")
        XCTAssertEqual(emitted[1].id, "mix-1")
        XCTAssertEqual(emitted[1].speaker, 2)
        XCTAssertEqual(emitted[1].text, "Hello!")
    }

    func testSpeakerZeroNeverSplits() {
        // Non-diarizing input always reports 0 — one run forever.
        builder.pushFinal("a", speaker: 0, startMs: 0, endMs: 100)
        builder.pushFinal("b", speaker: 0, startMs: 100, endMs: 200)
        builder.emitCommitted()
        XCTAssertEqual(emitted.count, 1)
        XCTAssertEqual(emitted[0].id, "mix-0")
        XCTAssertEqual(emitted[0].text, "ab")
    }

    func testEndpointCommitsResetsAndAdvancesIndex() {
        builder.pushFinal("First utterance.", speaker: 1, startMs: 0, endMs: 1000)
        builder.endpoint()
        builder.pushFinal("Second.", speaker: 1, startMs: 1200, endMs: 1500)
        builder.emitCommitted()

        XCTAssertEqual(emitted.count, 2)
        XCTAssertEqual(emitted[0].id, "mix-0")
        XCTAssertEqual(emitted[1].id, "mix-1", "endpoint advances the index")
        XCTAssertEqual(emitted[1].startMs, 1200, "new run gets a fresh start")
    }

    func testEndpointOnEmptyRunIsNoop() {
        builder.endpoint()
        XCTAssertTrue(emitted.isEmpty)
        builder.pushFinal("x", speaker: 1, startMs: 0, endMs: 10)
        builder.emitCommitted()
        XCTAssertEqual(emitted[0].id, "mix-0", "index did not advance on empty endpoint")
    }

    func testWhitespaceOnlyRunNeverCommits() {
        builder.pushFinal("  ", speaker: 1, startMs: 0, endMs: 100)
        builder.emitCommitted()
        builder.endpoint()
        XCTAssertTrue(emitted.isEmpty)
    }

    func testTailUsesStableIdAndEmptyClears() {
        builder.emitTail("typing…", speaker: 2, startMs: 300)
        builder.emitTail("", speaker: 2, startMs: 300)

        XCTAssertEqual(emitted.count, 2)
        XCTAssertEqual(emitted[0].id, "mix-tail")
        XCTAssertFalse(emitted[0].isFinal)
        XCTAssertEqual(emitted[1].id, "mix-tail")
        XCTAssertEqual(emitted[1].text, "", "empty tail clears the UI row")
    }

    func testCurrentSpeakerAndEndTrackOpenRun() {
        XCTAssertEqual(builder.currentSpeaker, 0)
        builder.pushFinal("hey", speaker: 3, startMs: 50, endMs: 250)
        XCTAssertEqual(builder.currentSpeaker, 3)
        XCTAssertEqual(builder.currentEnd, 250)
        builder.endpoint()
        XCTAssertEqual(builder.currentSpeaker, 0, "reset after endpoint")
    }

    // MARK: reconnected legs

    /// A relay that has to be reopened mid-meeting restarts its own numbering
    /// and its own clock at zero. Both are rebased so the second leg lands
    /// after the first instead of on top of it.
    func testReconnectedLegKeepsItsOwnIdsAndRebasedTimestamps() {
        var second: [TranscriptSegment] = []
        let leg = SegmentBuilder(source: "mix", idPrefix: "mix@1", timeOffsetMs: 60_000) {
            second.append($0)
        }
        leg.pushFinal("Back again", speaker: 1, startMs: 0, endMs: 900)
        leg.emitCommitted()
        leg.emitTail("and still", speaker: 1, startMs: 900)

        XCTAssertEqual(second[0].id, "mix@1-0", "must not collide with the first leg's mix-0")
        XCTAssertEqual(second[0].source, "mix", "speaker labels still key off the source")
        XCTAssertEqual(second[0].startMs, 60_000)
        XCTAssertEqual(second[0].endMs, 60_900)
        // The tail id is the one thing that stays put: every `-tail` check in
        // the app and the cloud depends on this exact shape, and only one tail
        // is ever on screen.
        XCTAssertEqual(second[1].id, "mix-tail")
        XCTAssertEqual(second[1].startMs, 60_900)
    }
}
