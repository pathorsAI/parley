import ParleyKit
import XCTest

final class SpaceCursorTests: XCTestCase {
    /// A press that has become a trackpad, landed at time 0.
    private func steering() -> SpaceCursor {
        var cursor = SpaceCursor()
        cursor.touchDown(at: 0)
        XCTAssertTrue(cursor.holdElapsed(allowed: true))
        return cursor
    }

    /// Slide from 0 to `distance` in `samples` even steps over `duration`
    /// seconds, starting at `start`; the total steps the caret moved.
    private func slide(
        _ cursor: inout SpaceCursor, from origin: Double = 0, by distance: Double,
        samples: Int, over duration: TimeInterval, start: TimeInterval = 1
    ) -> Int {
        var total = 0
        for i in 1...samples {
            let f = Double(i) / Double(samples)
            total += cursor.moved(dx: origin + distance * f, dy: 0, at: start + duration * f)
        }
        return total
    }

    // MARK: phases

    func testAQuickTapTypesASpace() {
        var cursor = SpaceCursor()
        cursor.touchDown(at: 0)
        XCTAssertEqual(cursor.phase, .holding)
        XCTAssertEqual(cursor.moved(dx: 2, dy: 1, at: 0.05), 0)
        XCTAssertEqual(cursor.release(), .space)
        XCTAssertEqual(cursor.phase, .idle)
    }

    func testAHoldThatNeverMovesTypesNothing() {
        var cursor = steering()
        XCTAssertEqual(cursor.phase, .steering)
        XCTAssertEqual(cursor.release(), .nothing)
    }

    func testDriftWithinTheSlopIsStillAHold() {
        var cursor = SpaceCursor()
        cursor.touchDown(at: 0)
        XCTAssertEqual(cursor.moved(dx: 6, dy: -7, at: 0.2), 0)
        XCTAssertEqual(cursor.phase, .holding)
        XCTAssertTrue(cursor.holdElapsed(allowed: true))
    }

    func testMovingPastTheSlopFirstMakesItAnOrdinaryPress() {
        var cursor = SpaceCursor()
        cursor.touchDown(at: 0)
        _ = cursor.moved(dx: 0, dy: SpaceCursor.slop + 1, at: 0.1)
        XCTAssertEqual(cursor.phase, .typing)
        XCTAssertFalse(cursor.holdElapsed(allowed: true), "a late timer is not a hold")
        XCTAssertEqual(cursor.moved(dx: 80, dy: 0, at: 0.5), 0, "an ordinary press never steers")
        XCTAssertEqual(cursor.release(), .space)
    }

    func testARefusedHoldKeepsSpacesMeaning() {
        // 注音 with a reading pending: space is the tone or the confirm.
        var cursor = SpaceCursor()
        cursor.touchDown(at: 0)
        XCTAssertFalse(cursor.holdElapsed(allowed: false))
        XCTAssertEqual(cursor.phase, .typing)
        XCTAssertEqual(slide(&cursor, by: 90, samples: 10, over: 1), 0)
        XCTAssertEqual(cursor.release(), .space)
    }

    func testAPressLiftedOffTheKeyTypesNothing() {
        var cursor = SpaceCursor()
        cursor.touchDown(at: 0)
        XCTAssertEqual(cursor.release(inside: false), .nothing)
    }

    func testACancelledPressTypesNothingAndSaysWhetherItWasSteering() {
        var cursor = SpaceCursor()
        cursor.touchDown(at: 0)
        XCTAssertFalse(cursor.cancel())
        XCTAssertEqual(cursor.phase, .idle)

        cursor = steering()
        XCTAssertTrue(cursor.cancel())
        XCTAssertEqual(cursor.phase, .idle)
    }

    func testANewPressStartsFromNothing() {
        var cursor = steering()
        _ = slide(&cursor, by: 40, samples: 4, over: 0.4)
        _ = cursor.release()
        cursor.touchDown(at: 10)
        XCTAssertEqual(cursor.phase, .holding)
        XCTAssertTrue(cursor.holdElapsed(allowed: true))
        // Measured from the new touch-down, not from where the last drag ended.
        XCTAssertEqual(cursor.moved(dx: 9, dy: 0, at: 10.5), 1)
    }

    // MARK: steps

    func testASlowDragMovesOneCharacterPerNinePoints() {
        var cursor = steering()
        // 90pt in a second: 90 pt/s, well under the onset.
        XCTAssertEqual(slide(&cursor, by: 90, samples: 30, over: 1), 10)
        XCTAssertEqual(slide(&cursor, from: 90, by: -45, samples: 15, over: 0.5, start: 2), -5)
    }

    func testVerticalTravelMovesNothing() {
        var cursor = steering()
        var total = 0
        for i in 1...20 {
            total += cursor.moved(dx: 0, dy: Double(i) * 10, at: 1 + Double(i) * 0.02)
        }
        XCTAssertEqual(total, 0)
        // A diagonal counts only its horizontal half.
        XCTAssertEqual(cursor.moved(dx: 18, dy: 400, at: 2), 2)
    }

    func testTravelBeforeTheHoldDoesNotCount() {
        var cursor = SpaceCursor()
        cursor.touchDown(at: 0)
        _ = cursor.moved(dx: 8, dy: 0, at: 0.2)
        XCTAssertTrue(cursor.holdElapsed(allowed: true))
        // 8pt were spent before it became a trackpad; 9 more make one step.
        XCTAssertEqual(cursor.moved(dx: 16, dy: 0, at: 0.6), 0)
        XCTAssertEqual(cursor.moved(dx: 17, dy: 0, at: 0.7), 1)
    }

    func testAWobbleAfterAStepDoesNotStepBack() {
        var cursor = steering()
        XCTAssertEqual(cursor.moved(dx: 9, dy: 0, at: 1), 1)
        XCTAssertEqual(cursor.moved(dx: 7, dy: 0, at: 1.1), 0)
        XCTAssertEqual(cursor.moved(dx: 9, dy: 0, at: 1.2), 0)
        XCTAssertEqual(cursor.moved(dx: 0, dy: 0, at: 1.4), -1)
    }

    func testTurningRoundNeedsAWholeStepInTheNewDirection() {
        var cursor = steering()
        // 8pt pending to the right, then back: the 8 are dropped, not repaid.
        XCTAssertEqual(cursor.moved(dx: 8, dy: 0, at: 1), 0)
        XCTAssertEqual(cursor.moved(dx: 0, dy: 0, at: 1.2), 0)
        XCTAssertEqual(cursor.moved(dx: -1, dy: 0, at: 1.3), -1)
    }

    func testAFastDragCoversMoreThanASlowOneButNotWithoutLimit() {
        var slow = steering()
        let slowSteps = slide(&slow, by: 180, samples: 60, over: 1)
        XCTAssertEqual(slowSteps, 20)

        var fast = steering()
        let fastSteps = slide(&fast, by: 180, samples: 12, over: 0.1)
        XCTAssertGreaterThan(fastSteps, slowSteps)
        XCTAssertLessThanOrEqual(Double(fastSteps), Double(slowSteps) * SpaceCursor.maxGain)
    }

    func testGainIsFlatWhenSlowAndCappedWhenFast() {
        XCTAssertEqual(SpaceCursor.gain(atSpeed: 0), 1)
        XCTAssertEqual(SpaceCursor.gain(atSpeed: SpaceCursor.accelerationOnset), 1)
        XCTAssertEqual(SpaceCursor.gain(atSpeed: SpaceCursor.accelerationFull), SpaceCursor.maxGain)
        XCTAssertEqual(SpaceCursor.gain(atSpeed: 10_000), SpaceCursor.maxGain)
        let mid = (SpaceCursor.accelerationOnset + SpaceCursor.accelerationFull) / 2
        XCTAssertEqual(
            SpaceCursor.gain(atSpeed: mid), (1 + SpaceCursor.maxGain) / 2, accuracy: 1e-9)
    }

    func testSamplesWithNoTimeBetweenThemStillMove() {
        var cursor = steering()
        XCTAssertEqual(cursor.moved(dx: 9, dy: 0, at: 1), 1)
        XCTAssertEqual(cursor.moved(dx: 18, dy: 0, at: 1), 1)
    }

    func testNothingStepsOnceReleased() {
        var cursor = steering()
        _ = cursor.release()
        XCTAssertEqual(cursor.moved(dx: 90, dy: 0, at: 2), 0)
    }
}

final class CaretWalkTests: XCTestCase {
    func testPlainTextIsOneUnitPerStep() {
        var walk = CaretWalk(before: "hello", after: " world")
        XCTAssertEqual(walk.offset(steps: -2), -2)
        XCTAssertEqual(walk.offset(steps: 3), 3)
    }

    func testChineseIsOneUnitPerCharacter() {
        var walk = CaretWalk(before: "你好", after: "世界")
        XCTAssertEqual(walk.offset(steps: -1), -1)
        XCTAssertEqual(walk.offset(steps: 2), 2)
    }

    func testAnEmojiIsCrossedWhole() {
        var walk = CaretWalk(before: "a😀", after: "👨‍👩‍👧b")
        XCTAssertEqual(walk.offset(steps: -1), -2, "😀 is a surrogate pair")
        XCTAssertEqual(walk.offset(steps: 1), 2)
        XCTAssertEqual(walk.offset(steps: 1), "👨‍👩‍👧".utf16.count)
        XCTAssertEqual(walk.offset(steps: 1), 1)
    }

    func testCombiningMarksAndRareHanAreOneStepEach() {
        var walk = CaretWalk(before: "e\u{301}𠀀", after: nil)
        XCTAssertEqual(walk.offset(steps: -1), -2, "U+20000 is outside the BMP")
        XCTAssertEqual(walk.offset(steps: -1), -2, "e + combining acute")
    }

    func testABatchOfStepsIsTheSumOfItsParts() {
        var walk = CaretWalk(before: "ab😀", after: nil)
        XCTAssertEqual(walk.offset(steps: -3), -4)
    }

    func testPastTheSnapshotEachStepIsOneUnitAndIsRepaidOnTheWayBack() {
        var walk = CaretWalk(before: "😀", after: "x")
        XCTAssertEqual(walk.offset(steps: -1), -2)
        // Beyond what the host shared.
        XCTAssertEqual(walk.offset(steps: -3), -3)
        // Back over the same three units, then the emoji whole.
        XCTAssertEqual(walk.offset(steps: 3), 3)
        XCTAssertEqual(walk.offset(steps: 1), 2)
        XCTAssertEqual(walk.offset(steps: 1), 1)
        XCTAssertEqual(walk.offset(steps: 2), 2)
        XCTAssertEqual(walk.offset(steps: -2), -2)
        XCTAssertEqual(walk.offset(steps: -1), -1)
    }

    func testNoContextAtAllStillMoves() {
        var walk = CaretWalk(before: nil, after: nil)
        XCTAssertEqual(walk.offset(steps: -2), -2)
        XCTAssertEqual(walk.offset(steps: 5), 5)
    }

    func testZeroStepsIsNoOffset() {
        var walk = CaretWalk(before: "abc", after: "def")
        XCTAssertEqual(walk.offset(steps: 0), 0)
    }
}
