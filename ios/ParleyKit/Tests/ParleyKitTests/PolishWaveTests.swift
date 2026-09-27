import XCTest

@testable import ParleyKit

/// The arithmetic behind the keyboard's polish wave. Two views draw from it —
/// the transcript and the record button's dots — so this is where "they agree"
/// is actually checked.
final class PolishWaveTests: XCTestCase {
    /// `Date` keeps its value relative to 2001 as a `Double`, so sums of a
    /// few tenths of a second land within a microsecond, not exactly —
    /// hence the tolerances on the clock tests below.
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    // MARK: pass length

    func testPassReadsAtAConstantPaceWithinTheClamp() {
        // Short phrases get the floor, a full slot gets the ceiling, and in
        // between the length follows the character count.
        XCTAssertEqual(PolishWave.passDuration(graphemes: 0), 1.1)
        XCTAssertEqual(PolishWave.passDuration(graphemes: 5), 1.1)
        XCTAssertEqual(PolishWave.passDuration(graphemes: 49), 49 / PolishWave.readingSpeed, accuracy: 1e-9)
        XCTAssertEqual(PolishWave.passDuration(graphemes: PolishWave.visibleGraphemes), 1.8, accuracy: 1e-9)
        XCTAssertEqual(PolishWave.passDuration(graphemes: 500), 1.8)
        XCTAssertEqual(PolishWave.passDuration(graphemes: -3), 1.1)
    }

    // MARK: the clock

    func testProgressRunsThroughAPassThenRests() {
        let wave = PolishWave(startedAt: t0, pass: 1.5)
        XCTAssertEqual(wave.progress(at: t0), 0)
        XCTAssertEqual(wave.progress(at: t0.addingTimeInterval(0.75))!, 0.5, accuracy: 1e-6)
        // The rest between passes: nothing is lit.
        XCTAssertNil(wave.progress(at: t0.addingTimeInterval(1.6)))
        // The second pass starts from the top again.
        XCTAssertEqual(wave.progress(at: t0.addingTimeInterval(1.75))!, 0, accuracy: 1e-6)
        XCTAssertEqual(wave.progress(at: t0.addingTimeInterval(1.75 + 0.3))!, 0.2, accuracy: 1e-6)
        // Before it starts there is no wave.
        XCTAssertNil(wave.progress(at: t0.addingTimeInterval(-0.1)))
    }

    func testStrengthEasesInAndOutWithoutACut() {
        var wave = PolishWave(startedAt: t0, pass: 1.5)
        XCTAssertEqual(wave.strength(at: t0), 0)
        XCTAssertEqual(wave.strength(at: t0.addingTimeInterval(0.1)), 0.5, accuracy: 1e-6)
        XCTAssertEqual(wave.strength(at: t0.addingTimeInterval(1)), 1)
        XCTAssertFalse(wave.isOver(at: t0.addingTimeInterval(60)))

        let end = t0.addingTimeInterval(2)
        wave.endedAt = end
        XCTAssertEqual(wave.strength(at: end), 1)
        XCTAssertEqual(wave.strength(at: end.addingTimeInterval(0.1)), 0.5, accuracy: 1e-6)
        XCTAssertEqual(wave.strength(at: end.addingTimeInterval(0.2)), 0)
        XCTAssertTrue(wave.isOver(at: end.addingTimeInterval(0.2)))
    }

    // MARK: the band

    func testTheBandEntersAtTheFirstCharacterAndLeavesPastTheLast() {
        let count = 30
        // At the start of a pass the band's leading edge is on the first
        // character, and nothing past it is lit yet.
        XCTAssertEqual(PolishWave.intensity(index: 0, count: count, progress: 0), 0, accuracy: 1e-9)
        XCTAssertGreaterThan(PolishWave.intensity(index: 0, count: count, progress: 0.02), 0)
        XCTAssertEqual(PolishWave.intensity(index: 10, count: count, progress: 0.02), 0)
        // At the end of it everything has been passed.
        for index in 0..<count {
            XCTAssertEqual(PolishWave.intensity(index: index, count: count, progress: 1), 0, accuracy: 1e-9)
        }
    }

    func testTheCrestIsFullyLitAndTheBandIsSmooth() {
        let count = 40
        // Find a progress that puts the crest exactly on character 20.
        let span = Double(count - 1) + PolishWave.bandWidth
        let progress = (20 + PolishWave.bandWidth / 2) / span
        XCTAssertEqual(PolishWave.crest(progress: progress, count: count), 20, accuracy: 1e-9)
        XCTAssertEqual(PolishWave.intensity(index: 20, count: count, progress: progress), 1, accuracy: 1e-9)
        // Symmetric, falling off either side, and gone outside the band.
        let left = PolishWave.intensity(index: 18, count: count, progress: progress)
        let right = PolishWave.intensity(index: 22, count: count, progress: progress)
        XCTAssertEqual(left, right, accuracy: 1e-9)
        XCTAssertLessThan(left, 1)
        XCTAssertGreaterThan(left, 0)
        XCTAssertEqual(PolishWave.intensity(index: 24, count: count, progress: progress), 0)
        XCTAssertEqual(PolishWave.intensity(index: 16, count: count, progress: progress), 0)
        // Between six and eight characters are lit at any moment.
        let lit = (0..<count).filter {
            PolishWave.intensity(index: $0, count: count, progress: progress) > 0
        }
        XCTAssertTrue((6...8).contains(lit.count), "\(lit.count) lit")
    }

    func testNothingIsLitDuringTheRestOrOutOfRange() {
        XCTAssertEqual(PolishWave.intensity(index: 3, count: 10, progress: nil), 0)
        XCTAssertEqual(PolishWave.intensity(index: -1, count: 10, progress: 0.2), 0)
        XCTAssertEqual(PolishWave.intensity(index: 10, count: 10, progress: 0.9), 0)
        XCTAssertEqual(PolishWave.intensity(index: 0, count: 0, progress: 0.5), 0)
    }

    // MARK: where the waving lines begin

    func testTheWaveStartsAtTheLastThreeLaidOutLines() {
        let text = String(repeating: "嗨你好我們見面再討論", count: 12)  // 120 graphemes
        let start = PolishWaveLines.lastLinesStart(
            of: text, graphemes: text.count, lines: 3, width: 150, fontSize: 15)
        // Many lines at this width: the wave covers only the end, and the tail
        // it covers is about three lines — well short of the whole text.
        XCTAssertGreaterThan(start, 0)
        XCTAssertLessThan(text.count - start, text.count / 2)
        // Text that fits in three lines waves from the first character.
        XCTAssertEqual(
            PolishWaveLines.lastLinesStart(
                of: "short", graphemes: 5, lines: 3, width: 300, fontSize: 15), 0)
        // Before the first layout there is no width: about three lines' worth.
        XCTAssertEqual(
            PolishWaveLines.lastLinesStart(
                of: text, graphemes: text.count, lines: 3, width: 0, fontSize: 15),
            text.count - PolishWave.visibleGraphemes)
    }

    func testLineMeasurementCountsAnEmojiAsOneCharacter() {
        let text = String(repeating: "👍🏽 ok ", count: 40)
        let start = PolishWaveLines.lastLinesStart(
            of: text, graphemes: text.count, lines: 3, width: 120, fontSize: 15)
        XCTAssertTrue((0...text.count).contains(start))
        XCTAssertGreaterThan(start, 0)
    }

    // MARK: the dots

    func testEachDotPeaksInItsThirdOfThePass() {
        for dot in 0..<3 {
            let centre = (Double(dot) + 0.5) / 3
            XCTAssertEqual(PolishWave.dotLevel(dot: dot, progress: centre), 1, accuracy: 1e-9)
            // The other two are down at that moment.
            for other in (0..<3) where other != dot {
                XCTAssertEqual(PolishWave.dotLevel(dot: other, progress: centre), 0, accuracy: 1e-9)
            }
        }
        // Between two centres the dots hand over rather than blink: both are
        // half lit at the boundary of their thirds.
        XCTAssertEqual(PolishWave.dotLevel(dot: 0, progress: 1.0 / 3), 0.5, accuracy: 1e-9)
        XCTAssertEqual(PolishWave.dotLevel(dot: 1, progress: 1.0 / 3), 0.5, accuracy: 1e-9)
        XCTAssertEqual(PolishWave.dotLevel(dot: 2, progress: nil), 0)
        XCTAssertEqual(PolishWave.dotLevel(dot: 3, progress: 0.5), 0)
    }

    func testDotsAndTextReadTheSameClock() {
        // The two views never talk to each other: each computes its phase
        // from the shared start date and the time its own timeline hands it.
        // For the same instant they must land on the same point of the pass.
        let wave = PolishWave(startedAt: t0, pass: PolishWave.passDuration(graphemes: 45))
        let now = t0.addingTimeInterval(0.9)
        let fromText = wave.progress(at: now)
        let fromDots = PolishWave(startedAt: wave.startedAt, pass: wave.pass).progress(at: now)
        XCTAssertEqual(fromText, fromDots)
        // And the middle dot is the lit one when the crest is mid-text.
        let mid = 0.5
        XCTAssertEqual(PolishWave.dotLevel(dot: 1, progress: mid), 1, accuracy: 1e-9)
        XCTAssertEqual(
            PolishWave.crest(progress: mid, count: 45), Double(45 - 1) / 2, accuracy: 1e-9)
    }
}
