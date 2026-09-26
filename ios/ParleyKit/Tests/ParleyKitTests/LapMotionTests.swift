import Foundation
import XCTest

@testable import ParleyKit

final class LapMotionTests: XCTestCase {

    func testThreeClippedLinesPlayInAboutSevenSeconds() {
        let schedule = LapMotion.introBeats(lineLengths: [34, 30, 34])
        XCTAssertEqual(schedule.end, 7, accuracy: 0.6)
    }

    func testBeatsAreInOrderAndLinesDoNotOverlap() {
        let s = LapMotion.introBeats(lineLengths: [20, 25, 10])
        XCTAssertLessThan(s.recording, s.lines[0].start)
        for (a, b) in zip(s.lines, s.lines.dropFirst()) {
            XCTAssertLessThan(a.name, b.start, "a name appears before the next line starts")
        }
        XCTAssertLessThan(s.lines[2].typed, s.folder)
        XCTAssertLessThan(s.folder, s.cardFly)
        XCTAssertLessThan(s.cardFly, s.share)
        XCTAssertLessThan(s.share, s.end)
    }

    func testTypingIsTwentyTwoMillisecondsACharacter() {
        let s = LapMotion.introBeats(lineLengths: [10])
        let start = s.lines[0].start
        XCTAssertEqual(s.typedCount(line: 0, at: start - 0.01), 0)
        XCTAssertEqual(s.typedCount(line: 0, at: start), 1)
        XCTAssertEqual(s.typedCount(line: 0, at: start + 0.022 * 4 + 0.001), 5)
        XCTAssertEqual(s.typedCount(line: 0, at: start + 10), 10, "never past the line")
        XCTAssertEqual(s.lines[0].typed, start + 0.022 * 9, accuracy: 1e-9)
        XCTAssertEqual(s.typedCount(line: 3, at: 100), 0)
    }

    func testTheCaptionFollowsTheBeat() {
        let s = LapMotion.introBeats(lineLengths: [10, 10, 10])
        XCTAssertNil(s.beat(at: 0))
        XCTAssertEqual(s.beat(at: s.recording), .recording)
        XCTAssertEqual(s.beat(at: s.lines[1].start), .transcript)
        XCTAssertEqual(s.beat(at: s.cardFly), .folder)
        XCTAssertEqual(s.beat(at: s.end + 5), .share, "it rests on the last beat")
    }

    func testClipping() {
        XCTAssertEqual(LapMotion.clip("林經理午安，謝謝您今天抽時間。我想先了解一下"), "林經理午安，謝謝您今天抽時間。")
        XCTAssertEqual(LapMotion.clip("short"), "short")
        let long = String(repeating: "a", count: 50)
        XCTAssertEqual(LapMotion.clip(long, limit: 10), "aaaaaaaaaa…")
        XCTAssertEqual(LapMotion.typed("abcdef", count: 3), "abc")
        XCTAssertEqual(LapMotion.typed("abc", count: -1), "")
    }
}
