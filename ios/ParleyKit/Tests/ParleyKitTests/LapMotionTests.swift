import Foundation
import XCTest

@testable import ParleyKit

final class LapMotionTests: XCTestCase {

    private typealias Schedule = LapMotion.WelcomeSchedule

    func testBeatsMatchTheDesktopAndRestAtEleven() {
        let s = Schedule(lineLengths: [15, 18])
        XCTAssertEqual(s.beat(at: 0), .overview)
        XCTAssertEqual(s.beat(at: 1.79), .overview)
        XCTAssertEqual(s.beat(at: 1.8), .record)
        XCTAssertEqual(s.beat(at: 3.4), .transcript)
        XCTAssertEqual(s.beat(at: 6.4), .folder)
        XCTAssertEqual(s.beat(at: 8.3), .mcp)
        XCTAssertEqual(s.beat(at: 11), .ready)
        XCTAssertEqual(s.beat(at: 60), .ready, "it rests on the final frame")
        XCTAssertEqual(s.end, 11)
    }

    func testAStepsBarFillsOverItsOwnLength() {
        let s = Schedule(lineLengths: [10])
        XCTAssertEqual(s.fill(.record, at: 1.0), 0)
        XCTAssertEqual(s.fill(.record, at: 2.6), 0.5, accuracy: 1e-9)
        XCTAssertEqual(s.fill(.record, at: 3.4), 1)
        XCTAssertEqual(s.fill(.mcp, at: 9.65), 0.5, accuracy: 1e-9)
        XCTAssertEqual(s.fill(.mcp, at: 30), 1)
    }

    func testShortLinesTypeAtTwentyTwoMillisecondsACharacter() {
        let s = Schedule(lineLengths: [10, 10])
        XCTAssertEqual(s.secondsPerCharacter, 0.022, accuracy: 1e-9)
        XCTAssertEqual(s.lineStarts[0], 3.4, accuracy: 1e-9)
        XCTAssertEqual(s.lineStarts[1], 3.4 + 10 * 0.022 + 0.24, accuracy: 1e-9)
        XCTAssertEqual(s.typedCount(line: 0, at: 3.4), 0)
        XCTAssertEqual(s.typedCount(line: 0, at: 3.4 + 0.022 * 5 + 0.001), 5)
        XCTAssertEqual(s.typedCount(line: 0, at: 100), 10, "never past the line")
        XCTAssertFalse(s.lineDone(1, at: s.lineStarts[1] + 0.1))
        XCTAssertTrue(s.lineDone(1, at: 6))
        XCTAssertEqual(s.typedCount(line: 2, at: 100), 0)
    }

    func testLongLinesTypeFasterToFitTheBudget() {
        let s = Schedule(lineLengths: [120, 120])
        XCTAssertLessThan(s.secondsPerCharacter, 0.022)
        let lastDone = s.lineStarts[1] + 120 * s.secondsPerCharacter
        XCTAssertEqual(lastDone, 3.4 + Schedule.transcriptBudget, accuracy: 1e-9)
        XCTAssertLessThan(lastDone, Schedule.start(of: .folder))
    }

    func testTheCardShowsFliesAndIsFiledInsideTheFolderBeat() {
        let s = Schedule(lineLengths: [10])
        XCTAssertEqual(s.card(at: 6.5), .hidden)
        XCTAssertEqual(s.card(at: 6.4 + 0.3), .shown)
        XCTAssertEqual(s.card(at: 6.4 + 0.8), .flying)
        XCTAssertEqual(s.card(at: 6.4 + 1.7), .filed)
        XCTAssertLessThan(6.4 + 0.75 + 0.9, Schedule.start(of: .mcp), "filed before the MCP beat")
        XCTAssertTrue(s.folderFlashing(at: 6.4 + 1.7))
        XCTAssertFalse(s.folderFlashing(at: 6.4 + 2.2))
    }

    func testThePlugLightsAndTheReportFillsInDuringTheMcpBeat() {
        let s = Schedule(lineLengths: [10])
        XCTAssertFalse(s.plugLit(at: 8.5))
        XCTAssertTrue(s.plugLit(at: 8.61))
        XCTAssertEqual(s.reportLines(4, at: 8.6), 0)
        XCTAssertEqual(s.reportLines(4, at: 8.66), 1)
        XCTAssertEqual(s.reportLines(4, at: 8.96), 2)
        XCTAssertEqual(s.reportLines(4, at: 11), 4, "all in by the rest frame")
        XCTAssertEqual(s.reportLineStart(1), 8.95, accuracy: 1e-9)
    }

    func testTyping() {
        XCTAssertEqual(LapMotion.typed("abcdef", count: 3), "abc")
        XCTAssertEqual(LapMotion.typed("abc", count: -1), "")
    }
}
