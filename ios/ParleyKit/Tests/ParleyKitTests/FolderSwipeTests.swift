import CoreGraphics
import ParleyKit
import XCTest

final class FolderSwipeTests: XCTestCase {
    /// A list under a chip strip, with two recording rows and a 28pt gap
    /// between them — the way the Library lays them out, in window points.
    private let list = CGRect(x: 0, y: 310, width: 402, height: 480)
    private let strip = CGRect(x: 20, y: 277, width: 362, height: 30)
    private let rows = [
        CGRect(x: 20, y: 324, width: 362, height: 80),
        CGRect(x: 20, y: 432, width: 362, height: 80),
    ]
    private let blank = CGPoint(x: 200, y: 700)
    private let onRow = CGPoint(x: 200, y: 360)
    private let left = CGSize(width: -120, height: 4)
    private let right = CGSize(width: 120, height: -4)

    private func step(
        _ start: CGPoint, _ translation: CGSize, rows: [CGRect]? = nil,
        scrollingStrip: CGRect? = nil
    ) -> Int? {
        FolderSwipe.step(
            start: start, translation: translation, rows: rows ?? self.rows, list: list,
            scrollingStrip: scrollingStrip)
    }

    func testALeftSwipeOnTheBlankAreaGoesToTheNextFolder() {
        XCTAssertEqual(step(blank, left), 1)
    }

    func testARightSwipeOnTheBlankAreaGoesToThePreviousFolder() {
        XCTAssertEqual(step(blank, right), -1)
    }

    func testASwipeThatStartsOnARowBelongsToTheRow() {
        XCTAssertNil(step(onRow, left))
        XCTAssertNil(step(onRow, right))
    }

    func testTheRowsSideMarginsAreStillTheRow() {
        // The cell runs the list's width; its swipe answers there too.
        XCTAssertNil(step(CGPoint(x: 8, y: 360), left))
        XCTAssertNil(step(CGPoint(x: 396, y: 360), right))
    }

    func testARowThatHasSlidAsideWithItsOwnSwipeIsStillTheRow() {
        // At the drag's end the trailing actions have pushed the row 175pt
        // left, clear of where the finger went down.
        let slid = [CGRect(x: -155, y: 324, width: 362, height: 80), rows[1]]
        XCTAssertNil(step(CGPoint(x: 320, y: 360), CGSize(width: -200, height: 2), rows: slid))
    }

    func testTheGapBetweenTwoRowsIsBlank() {
        XCTAssertEqual(step(CGPoint(x: 200, y: 418), left), 1)
    }

    func testTheChipsAreBlankWhileTheyFit() {
        XCTAssertEqual(step(CGPoint(x: 200, y: 290), left), 1)
    }

    func testARowScrolledUpUnderTheChipsDoesNotClaimThem() {
        let scrolledUp = [CGRect(x: 20, y: 250, width: 362, height: 80)]
        XCTAssertEqual(step(CGPoint(x: 200, y: 290), right, rows: scrolledUp), -1)
        XCTAssertNil(step(CGPoint(x: 200, y: 320), right, rows: scrolledUp))
    }

    func testAnOverflowingChipStripKeepsItsOwnScroll() {
        XCTAssertNil(step(CGPoint(x: 200, y: 290), left, scrollingStrip: strip))
        // The padding round the strip is still page.
        XCTAssertEqual(step(CGPoint(x: 200, y: 272), left, scrollingStrip: strip), 1)
    }

    func testASwipeThatEndsOnARowButStartedOffItStillSwitches() {
        XCTAssertEqual(step(CGPoint(x: 380, y: 418), CGSize(width: -300, height: -40)), 1)
    }

    func testAShortDragDoesNothing() {
        XCTAssertNil(step(blank, CGSize(width: -59, height: 0)))
        XCTAssertEqual(step(blank, CGSize(width: -60, height: 0)), 1)
    }

    func testADiagonalOrVerticalDragIsAScrollNotASwitch() {
        // More horizontal than vertical, but not by enough.
        XCTAssertNil(step(blank, CGSize(width: -90, height: 70)))
        XCTAssertNil(step(blank, CGSize(width: 10, height: 300)))
    }

    func testAnEmptyFolderSwitchesFromAnywhere() {
        XCTAssertEqual(step(onRow, right, rows: []), -1)
    }
}
