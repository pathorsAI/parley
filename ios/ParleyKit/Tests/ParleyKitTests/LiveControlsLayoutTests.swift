import XCTest

@testable import ParleyKit

final class LiveControlsLayoutTests: XCTestCase {
    /// Roughly the panel at the default text size with a one-line status.
    private let metrics = LiveControlsLayout.Metrics(
        statusRow: 18, timer: 41, waveform: 28, statusLine: 16)
    private var layout: LiveControlsLayout { LiveControlsLayout(metrics: metrics) }

    func testFullIsTheSumOfEveryPieceAtFullSize() {
        // 20+20 padding, 18+41+28+16+64+44 pieces, five 14pt gaps.
        XCTAssertEqual(layout.full, 40 + 211 + 70, accuracy: 0.001)
    }

    func testNoStatusLineMeansNoRoomReservedForIt() {
        var bare = metrics
        bare.statusLine = 0
        let without = LiveControlsLayout(metrics: bare)
        XCTAssertEqual(layout.full - without.full, 16 + 14, accuracy: 0.001)
        XCTAssertFalse(without.visible(at: without.full).contains(.statusLine))
    }

    func testEverythingShowsOnlyWhenFullyOpen() {
        XCTAssertEqual(layout.visible(at: layout.full), Set(LiveControlsLayout.Element.allCases))
        // A few points short already costs Discard: it is the one
        // irreversible control, so it never shows on a half-collapsed panel.
        XCTAssertFalse(layout.visible(at: layout.full - 3).contains(.discard))
        XCTAssertTrue(layout.visible(at: layout.full - 3).contains(.waveform))
    }

    func testPiecesDropInOrderAndNeverComeBack() {
        let order = LiveControlsLayout.Element.allCases
        var previous = layout.visible(at: layout.full)
        var height = layout.full
        while height >= layout.compact {
            let shown = layout.visible(at: height)
            // Monotonic: shrinking never brings a piece back.
            XCTAssertTrue(shown.isSubset(of: previous), "at \(height)")
            // Whatever is gone is a prefix of the drop order.
            let gone = order.filter { !shown.contains($0) }
            XCTAssertEqual(gone, Array(order.prefix(gone.count)), "at \(height)")
            previous = shown
            height -= 1
        }
        XCTAssertTrue(layout.visible(at: layout.compact).isEmpty)
    }

    func testSizesShrinkContinuouslyAndTheStopTargetStaysHIGSized() {
        XCTAssertEqual(layout.timerScale(at: layout.full), 1, accuracy: 0.0001)
        XCTAssertEqual(layout.timerScale(at: layout.compact), 0.62, accuracy: 0.0001)
        XCTAssertEqual(layout.stopDiameter(at: layout.full), 64, accuracy: 0.0001)
        XCTAssertEqual(layout.stopDiameter(at: layout.compact), 52, accuracy: 0.0001)
        let mid = layout.height(forFraction: 0.5)
        XCTAssertLessThan(layout.timerScale(at: mid), 1)
        XCTAssertGreaterThan(layout.timerScale(at: mid), 0.62)
        XCTAssertGreaterThanOrEqual(layout.stopDiameter(at: layout.compact - 40), 44)
    }

    func testFractionRoundTripsAndClamps() {
        for fraction in [0, 0.25, 0.6, 1] {
            XCTAssertEqual(
                layout.fraction(forHeight: layout.height(forFraction: fraction)), fraction,
                accuracy: 0.0001)
        }
        XCTAssertEqual(layout.height(forFraction: 2), layout.full)
        XCTAssertEqual(layout.height(forFraction: -1), layout.compact)
    }

    func testTheCrossfadeNeverLeavesTheMiddleEmpty() {
        var height = layout.compact
        while height <= layout.full {
            let drawn = layout.columnOpacity(at: height) + layout.rowOpacity(at: height)
            XCTAssertGreaterThanOrEqual(drawn, 0.99, "at \(height)")
            height += 0.5
        }
        XCTAssertEqual(layout.columnOpacity(at: layout.full), 1)
        XCTAssertEqual(layout.rowOpacity(at: layout.full), 0)
        XCTAssertEqual(layout.columnOpacity(at: layout.compact), 0)
        XCTAssertEqual(layout.rowOpacity(at: layout.compact), 1)
    }

    func testDragFollowsTheFingerAndRubberBandsPastTheEnds() {
        let full = layout.full
        XCTAssertEqual(layout.dragged(from: full, translation: 100), full - 100)
        // Pulling up past full gives a little, never more than the overshoot.
        let over = layout.dragged(from: full, translation: -300)
        XCTAssertGreaterThan(over, full)
        XCTAssertLessThan(over, full + LiveControlsLayout.overshoot)
        let under = layout.dragged(from: layout.compact, translation: 300)
        XCTAssertLessThan(under, layout.compact)
        XCTAssertGreaterThan(under, layout.compact - LiveControlsLayout.overshoot)
        // Diminishing: twice the pull is less than twice the give.
        let small = layout.dragged(from: full, translation: -20) - full
        let large = layout.dragged(from: full, translation: -40) - full
        XCTAssertLessThan(large, small * 2)
    }

    func testReleaseStaysPutExceptNearTheEndsAndInsideTheCrossfade() {
        let mid = layout.height(forFraction: 0.6)
        XCTAssertEqual(layout.settled(mid), mid)
        XCTAssertEqual(layout.settled(layout.full - 10), layout.full)
        XCTAssertEqual(layout.settled(layout.full + 30), layout.full)
        XCTAssertEqual(layout.settled(layout.compact + 30), layout.compact)
        XCTAssertEqual(layout.settled(layout.compact - 30), layout.compact)

        let band = LiveControlsLayout.crossfade
        let low = layout.height(forFraction: band.lowerBound)
        let high = layout.height(forFraction: band.upperBound)
        let inside = layout.settled(low + (high - low) * 0.8)
        XCTAssertEqual(inside, high, accuracy: 0.0001)
        // Wherever it rests, exactly one layout is drawn.
        var height = layout.compact - 20
        while height <= layout.full + 20 {
            let rest = layout.settled(height)
            let column = layout.columnOpacity(at: rest)
            let row = layout.rowOpacity(at: rest)
            XCTAssertTrue(
                (column > 0.999 && row < 0.001) || (column < 0.001 && row > 0.999),
                "resting at \(rest) from \(height)")
            height += 1
        }
    }

    func testTapAndAccessibilitySteps() {
        XCTAssertEqual(layout.toggled(fraction: 1), 0)
        XCTAssertEqual(layout.toggled(fraction: 0.4), 1)
        XCTAssertEqual(layout.toggled(fraction: 0), 1)

        XCTAssertEqual(layout.stepped(fraction: 0, taller: true), 0.5)
        XCTAssertEqual(layout.stepped(fraction: 0.5, taller: true), 1)
        XCTAssertEqual(layout.stepped(fraction: 1, taller: true), 1)
        XCTAssertEqual(layout.stepped(fraction: 0.7, taller: false), 0.5)
        XCTAssertEqual(layout.stepped(fraction: 0.3, taller: false), 0)
        XCTAssertEqual(layout.stepped(fraction: 0, taller: false), 0)
    }
}
