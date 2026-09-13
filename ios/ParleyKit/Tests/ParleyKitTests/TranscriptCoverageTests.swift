import XCTest

@testable import ParleyKit

final class TranscriptCoverageTests: XCTestCase {

    /// Committed segment covering `[start, end)` seconds.
    private func seg(_ start: UInt64, _ end: UInt64, id: String = UUID().uuidString)
        -> TranscriptSegment
    {
        TranscriptSegment(
            id: id, source: "mix", speaker: 0, text: "x", isFinal: true,
            startMs: start * 1000, endMs: end * 1000)
    }

    // MARK: the shape of the bug this exists for

    func testARelayThatDiesPartWayLeavesTheRestAsOneGap() {
        // The reported failure: 49 minutes of audio, a handful of sentences.
        let report = TranscriptCoverage.report(
            segments: [seg(0, 60), seg(60, 180), seg(180, 300)], totalMs: 2953 * 1000)

        XCTAssertEqual(report.gaps.count, 1)
        XCTAssertEqual(report.gaps.first?.startMs, 300 * 1000)
        XCTAssertEqual(report.gaps.first?.endMs, 2953 * 1000)
        XCTAssertTrue(report.needsBackfill())
        XCTAssertLessThan(report.coveredFraction, 0.11)
    }

    func testAFullyTranscribedMeetingIsLeftAlone() {
        let report = TranscriptCoverage.report(
            segments: (0..<60).map { seg($0 * 60, ($0 + 1) * 60) }, totalMs: 3600 * 1000)

        XCTAssertEqual(report.gaps, [])
        XCTAssertEqual(report.coveredFraction, 1)
        XCTAssertFalse(report.needsBackfill())
    }

    // MARK: the two triggers are independent

    func testOneLongHoleTriggersEvenWhenItIsATinyShareOfTheWhole() {
        // 90 seconds lost out of three hours: 0.8% of the recording, and a
        // whole lost conversation. The fraction trigger cannot see this.
        let report = TranscriptCoverage.report(
            segments: [seg(0, 3600), seg(3690, 10800)], totalMs: 10800 * 1000)

        XCTAssertEqual(report.longestGapMs, 90 * 1000)
        XCTAssertLessThan(Double(report.gapMs), Double(report.totalMs) * 0.10)
        XCTAssertTrue(report.needsBackfill())
    }

    func testManySmallHolesTriggerOnTheirTotalWhenNoneIsLongEnoughAlone() {
        // Twelve 10-second holes in a 10-minute meeting: 20% missing, and the
        // longest-gap trigger never fires.
        var segments: [TranscriptSegment] = []
        for i in UInt64(0)..<12 {
            segments.append(seg(i * 50, i * 50 + 40))
        }
        let report = TranscriptCoverage.report(segments: segments, totalMs: 600 * 1000)

        XCTAssertLessThan(report.longestGapMs, 30 * 1000)
        XCTAssertTrue(report.needsBackfill())
    }

    func testAShortReconnectIsNotWorthReTranscribingAnHourOver() {
        // The bridge holds audio across the backoff ladder and flushes it into
        // the next leg, so a reconnect that works leaves no hole at all. Even
        // when a few seconds do slip, they must not trigger a re-run.
        let report = TranscriptCoverage.report(
            segments: [seg(0, 1800), seg(1806, 3600)], totalMs: 3600 * 1000)

        XCTAssertEqual(report.longestGapMs, 6 * 1000)
        XCTAssertFalse(report.needsBackfill())
    }

    // MARK: segment bookkeeping

    func testTheTentativeTailDoesNotVouchForAudioNobodyTranscribed() {
        // An unfinished utterance must not cover the 40 minutes it is guessing
        // at — it is excluded from the upload for the same reason.
        let tail = TranscriptSegment(
            id: "mix-tail", source: "mix", speaker: 0, text: "guess", isFinal: true,
            startMs: 300 * 1000, endMs: 2953 * 1000)
        let report = TranscriptCoverage.report(
            segments: [seg(0, 300), tail], totalMs: 2953 * 1000)

        XCTAssertTrue(report.needsBackfill())
        XCTAssertEqual(report.longestGapMs, (2953 - 300) * 1000)
    }

    func testNonFinalSegmentsAreNotCoverage() {
        let partial = TranscriptSegment(
            id: "p", source: "mix", speaker: 0, text: "…", isFinal: false,
            startMs: 0, endMs: 600 * 1000)
        let report = TranscriptCoverage.report(segments: [partial], totalMs: 600 * 1000)

        XCTAssertEqual(report.coveredMs, 0)
        XCTAssertTrue(report.needsBackfill())
    }

    func testOverlappingLegsMergeRatherThanDoubleCount() {
        // A reconnected leg is offset to the front of the hold buffer, so its
        // first segment can start before the last segment of the leg that died.
        let report = TranscriptCoverage.report(
            segments: [seg(0, 100), seg(80, 200), seg(150, 300)], totalMs: 300 * 1000)

        XCTAssertEqual(report.covered.count, 1)
        XCTAssertEqual(report.coveredMs, 300 * 1000)
        XCTAssertEqual(report.gaps, [])
    }

    func testSegmentsArrivingOutOfOrderStillMerge() {
        let report = TranscriptCoverage.report(
            segments: [seg(150, 300), seg(0, 100), seg(80, 200)], totalMs: 300 * 1000)

        XCTAssertEqual(report.covered.count, 1)
        XCTAssertEqual(report.gaps, [])
    }

    func testATimestampPastTheEndOfTheFileCannotPushCoverageOverOneHundredPercent() {
        let report = TranscriptCoverage.report(
            segments: [seg(0, 700)], totalMs: 600 * 1000)

        XCTAssertEqual(report.coveredMs, 600 * 1000)
        XCTAssertEqual(report.coveredFraction, 1)
        XCTAssertFalse(report.needsBackfill())
    }

    func testAZeroLengthSegmentCoversNothing() {
        let report = TranscriptCoverage.report(segments: [seg(60, 60)], totalMs: 600 * 1000)

        XCTAssertEqual(report.coveredMs, 0)
    }

    // MARK: degenerate inputs

    func testARecordingWithNoTranscriptAtAllIsOneGap() {
        let report = TranscriptCoverage.report(segments: [], totalMs: 600 * 1000)

        XCTAssertEqual(report.gaps, [TranscriptCoverage.Span(startMs: 0, endMs: 600 * 1000)])
        XCTAssertEqual(report.coveredFraction, 0)
        XCTAssertTrue(report.needsBackfill())
    }

    func testARecordingWithNoDurationIsNeverWorthReRunning() {
        // Nothing is there to be missing, and dividing by it would not end well.
        let report = TranscriptCoverage.report(segments: [], totalMs: 0)

        XCTAssertEqual(report.coveredFraction, 1)
        XCTAssertFalse(report.needsBackfill())
    }

    func testASpanThatRunsBackwardsCollapsesRatherThanUnderflowing() {
        let span = TranscriptCoverage.Span(startMs: 500, endMs: 100)

        XCTAssertEqual(span.durationMs, 0)
        XCTAssertEqual(span.endMs, 500)
    }

    // MARK: policy

    func testThresholdsAreTunableWithoutTouchingTheMeasurement() {
        let report = TranscriptCoverage.report(
            segments: [seg(0, 1800), seg(1806, 3600)], totalMs: 3600 * 1000)
        let strict = TranscriptCoverage.BackfillPolicy(
            longestGap: .seconds(5), totalGapFraction: 0.10)

        XCTAssertFalse(report.needsBackfill())
        XCTAssertTrue(report.needsBackfill(policy: strict))
    }

    func testTheManualRetryBudgetIsThree() {
        XCTAssertEqual(TranscriptCoverage.BackfillPolicy.standard.maxManualRetries, 3)
    }
}
