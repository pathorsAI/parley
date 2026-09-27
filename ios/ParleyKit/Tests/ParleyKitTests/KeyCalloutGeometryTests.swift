import CoreGraphics
import ParleyKit
import XCTest

final class KeyCalloutGeometryTests: XCTestCase {
    private let phone = CGSize(width: 402, height: 251)

    func testAMiddleRowKeyGetsTheFullBubbleCentredOverIt() {
        let g = CGRect(x: 183.9, y: 99, width: 34.2, height: 42)
        assertLayout(
            KeyCalloutGeometry.layout(key: g, in: phone),
            bubble: CGRect(x: 170.22, y: 25.5, width: 61.56, height: 63),
            glyphCenter: CGPoint(x: 201, y: 57),
            glyphSize: 34.65)
    }

    func testATopRowKeyGetsAShorterBubbleThatStopsAtTheKeyboardsTop() {
        let w = CGRect(x: 43.2, y: 46, width: 34.2, height: 42)
        assertLayout(
            KeyCalloutGeometry.layout(key: w, in: phone),
            bubble: CGRect(x: 29.52, y: 0, width: 61.56, height: 35.5),
            glyphCenter: CGPoint(x: 60.3, y: 17.75),
            glyphSize: 31.95)
    }

    func testTheLeftmostKeysBubbleLinesUpWithItsLeftEdge() {
        let q = CGRect(x: 3, y: 46, width: 34.2, height: 42)
        assertLayout(
            KeyCalloutGeometry.layout(key: q, in: phone),
            bubble: CGRect(x: 3, y: 0, width: 61.56, height: 35.5),
            glyphCenter: CGPoint(x: 33.78, y: 17.75),
            glyphSize: 31.95)
    }

    func testTheRightmostKeysBubbleLinesUpWithItsRightEdge() {
        let p = CGRect(x: 364.8, y: 46, width: 34.2, height: 42)
        assertLayout(
            KeyCalloutGeometry.layout(key: p, in: phone),
            bubble: CGRect(x: 337.44, y: 0, width: 61.56, height: 35.5),
            glyphCenter: CGPoint(x: 368.22, y: 17.75),
            glyphSize: 31.95)
    }

    func testZhuyinsElevenColumnTopRowEndsAtTheRightEdge() {
        let er = CGRect(x: 368.4545, y: 46, width: 30.5455, height: 34.6)
        assertLayout(
            KeyCalloutGeometry.layout(key: er, in: phone),
            bubble: CGRect(x: 344.0182, y: 0, width: 54.9818, height: 37.35),
            glyphCenter: CGPoint(x: 371.5091, y: 18.675),
            glyphSize: 28.545)
    }

    func testZhuyinsBottomSymbolRowHasRoomForTheFullBubble() {
        let f = CGRect(x: 3, y: 170.8, width: 30.5455, height: 34.6)
        assertLayout(
            KeyCalloutGeometry.layout(key: f, in: phone),
            bubble: CGRect(x: 3, y: 110.25, width: 54.9818, height: 51.9),
            glyphCenter: CGPoint(x: 30.4909, y: 136.2),
            glyphSize: 28.545)
    }

    func testAKeyWithNoHeadroomGetsAnEmptyBubbleAtTheTop() {
        let key = CGRect(x: 100, y: 0, width: 34.2, height: 42)
        assertLayout(
            KeyCalloutGeometry.layout(key: key, in: phone),
            bubble: CGRect(x: 86.32, y: 0, width: 61.56, height: 0),
            glyphCenter: CGPoint(x: 117.1, y: 0),
            glyphSize: 0)
    }

    private func assertLayout(
        _ layout: KeyCalloutLayout, bubble: CGRect, glyphCenter: CGPoint, glyphSize: CGFloat,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        let accuracy: CGFloat = 0.01
        for (actual, expected, name) in [
            (layout.bubble.minX, bubble.minX, "bubble.minX"),
            (layout.bubble.minY, bubble.minY, "bubble.minY"),
            (layout.bubble.width, bubble.width, "bubble.width"),
            (layout.bubble.height, bubble.height, "bubble.height"),
            (layout.glyphCenter.x, glyphCenter.x, "glyphCenter.x"),
            (layout.glyphCenter.y, glyphCenter.y, "glyphCenter.y"),
            (layout.glyphSize, glyphSize, "glyphSize"),
        ] {
            XCTAssertEqual(actual, expected, accuracy: accuracy, name, file: file, line: line)
        }
    }
}
