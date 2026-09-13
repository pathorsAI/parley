import XCTest

@testable import ParleyKit

/// The sequence these cover takes a real phone, a real system dictation, and a
/// minute of waiting to produce once. It is six lines here.
final class CaptureRecoveryTests: XCTestCase {

    // MARK: the reported bug, end to end

    /// The founder's report: Parley holds the microphone in the background, the
    /// user taps iOS's own dictation, and the Parley keyboard is dead afterwards.
    ///
    /// Every reactivation is refused because the app is backgrounded and another
    /// client is running, so the ladder runs out — and the only honest thing left
    /// is to tell the keyboard. The old capture went quiet instead.
    func testSystemDictationInTheBackgroundEndsWithTheKeyboardBeingTold() {
        var recovery = CaptureRecovery()

        XCTAssertEqual(
            recovery.apply(.interrupted),
            .rebuild(afterMilliseconds: recovery.probeAfterMilliseconds))
        XCTAssertEqual(
            recovery.apply(.interruptionEnded),
            .rebuild(afterMilliseconds: recovery.resumeAfterMilliseconds))

        var actions: [CaptureRecovery.Action] = []
        while actions.last == nil || !isGiveUp(actions.last!) {
            actions.append(recovery.apply(.refusedInBackground))
            XCTAssertLessThan(actions.count, 50, "the ladder has to end")
        }

        XCTAssertEqual(actions.last, .giveUp(.takenBySystem))
        XCTAssertEqual(actions.count, recovery.maxAttempts)
        XCTAssertTrue(recovery.hasGivenUp)
        XCTAssertFalse(recovery.holdsMicrophone)
    }

    /// …and the microphone is not gone for good. The give-up is a state that
    /// still answers the two events that change the answer, which is exactly
    /// what the old code had no way to do: it cleared the flag every retry path
    /// keyed off, so the foreground trip that would have worked reached nothing.
    func testGivingUpStaysArmedForTheForeground() {
        var recovery = givenUp()

        XCTAssertEqual(recovery.apply(.appBecameActive), .rebuild(afterMilliseconds: 0))
        XCTAssertFalse(recovery.hasGivenUp)
        XCTAssertEqual(recovery.apply(.rebuildSucceeded), .wait)
        XCTAssertTrue(recovery.holdsMicrophone)
    }

    func testGivingUpStaysArmedForAMediaServicesReset() {
        var recovery = givenUp()

        XCTAssertEqual(
            recovery.apply(.mediaServicesReset),
            .rebuild(afterMilliseconds: recovery.resumeAfterMilliseconds))
        XCTAssertFalse(recovery.hasGivenUp)
    }

    /// A late `.ended` is the best reason there has ever been to try again, even
    /// after the ladder has been spent.
    func testGivingUpStaysArmedForALateInterruptionEnd() {
        var recovery = givenUp()

        XCTAssertEqual(
            recovery.apply(.interruptionEnded),
            .rebuild(afterMilliseconds: recovery.resumeAfterMilliseconds))
        XCTAssertEqual(recovery.attempts, 0)
    }

    // MARK: the interruption that never announces its end

    /// System services do not reliably post `.ended`. The probe scheduled by
    /// `.began` is the only thing that can notice — the old capture waited for an
    /// `.ended` that never came, and the watchdog that was supposed to be the
    /// backstop was disabled by the very flag the interruption set.
    func testAnInterruptionWithNoEndIsStillProbed() {
        var recovery = CaptureRecovery()

        XCTAssertEqual(
            recovery.apply(.interrupted),
            .rebuild(afterMilliseconds: recovery.probeAfterMilliseconds))
        XCTAssertEqual(recovery.phase, .interrupted)

        // The other client let go without saying so: a probe simply works.
        XCTAssertEqual(recovery.apply(.rebuildSucceeded), .wait)
        XCTAssertTrue(recovery.holdsMicrophone)
    }

    /// A second `.began` for an interruption already being probed says nothing
    /// new, and answering it would put a second chain on the same engine.
    func testRepeatedInterruptionBeginningsDoNotStackChains() {
        var recovery = CaptureRecovery()

        XCTAssertEqual(
            recovery.apply(.interrupted),
            .rebuild(afterMilliseconds: recovery.probeAfterMilliseconds))
        XCTAssertEqual(recovery.apply(.interrupted), .wait)
        XCTAssertEqual(recovery.apply(.interrupted), .wait)
    }

    // MARK: the ladder

    func testBackoffDoublesFromTheFirstStepAndCaps() {
        let recovery = CaptureRecovery(
            firstBackoffMilliseconds: 250, backoffCapMilliseconds: 4_000)
        let ladder = (1...7).map(recovery.backoff(forAttempt:))

        XCTAssertEqual(ladder, [250, 500, 1_000, 2_000, 4_000, 4_000, 4_000])
        // Never asked to wait negatively, whatever it is handed.
        XCTAssertEqual(recovery.backoff(forAttempt: 0), 250)
        XCTAssertEqual(recovery.backoff(forAttempt: -3), 250)
    }

    /// The ladder that shipped ran out in about eleven seconds, which is a route
    /// change settling down — not a person dictating a sentence into iOS. The
    /// point of this one is that it outlasts the interruption it exists for.
    func testTheLadderOutlastsASystemDictationRatherThanARouteChange() {
        let recovery = CaptureRecovery()

        XCTAssertGreaterThan(recovery.ladderMilliseconds, 25_000)
        // …and is still bounded. A capture that keeps claiming to be recovering
        // for minutes is the silent failure this whole file exists to avoid.
        XCTAssertLessThan(recovery.ladderMilliseconds, 60_000)
    }

    func testEachFailureClimbsOneRungAndASuccessResetsTheClimb() {
        var recovery = CaptureRecovery()
        _ = recovery.apply(.interruptionEnded)

        XCTAssertEqual(recovery.apply(.refusedInBackground), .rebuild(afterMilliseconds: 250))
        XCTAssertEqual(recovery.apply(.refusedInBackground), .rebuild(afterMilliseconds: 500))
        XCTAssertEqual(recovery.apply(.refusedInBackground), .rebuild(afterMilliseconds: 1_000))
        XCTAssertEqual(recovery.attempts, 3)

        XCTAssertEqual(recovery.apply(.rebuildSucceeded), .wait)
        XCTAssertEqual(recovery.attempts, 0)

        // A fresh interruption starts from the bottom of the ladder, not from
        // wherever the last one got to.
        _ = recovery.apply(.interruptionEnded)
        XCTAssertEqual(recovery.apply(.refusedInBackground), .rebuild(afterMilliseconds: 250))
    }

    /// The engine stopping for a reason of ours — a route change, a
    /// configuration change, the watchdog noticing — is not something to wait
    /// for. Nobody is holding the input.
    func testAnEngineThatSimplyStoppedIsRebuiltAtOnce() {
        var recovery = CaptureRecovery()

        XCTAssertEqual(recovery.apply(.engineStopped), .rebuild(afterMilliseconds: 0))
    }

    // MARK: what the user is told

    /// The two losses are different pieces of advice. "Somebody else has the
    /// input" is fixed by bringing Parley forward, which is what the keyboard's
    /// copy offers; a broken audio stack is not fixed by tapping anything, so it
    /// gets named instead.
    func testABrokenAudioStackIsNamedRatherThanOfferedARestart() {
        var recovery = CaptureRecovery(maxAttempts: 2)
        _ = recovery.apply(.engineStopped)

        XCTAssertEqual(
            recovery.apply(.rebuildFailed(systemHoldsInput: false, description: "no converter")),
            .rebuild(afterMilliseconds: recovery.firstBackoffMilliseconds))
        XCTAssertEqual(
            recovery.apply(.rebuildFailed(systemHoldsInput: false, description: "no converter")),
            .giveUp(.broken("no converter")))
    }

    /// A chain that began with the system taking the input is reported as
    /// exactly that, even when the last throw on the way down was something
    /// else. A probe refused while Siri holds the microphone can surface as a
    /// 0 Hz input node, and the user needs to be told what happened rather than
    /// the last thing that went wrong.
    func testAnInterruptedChainIsReportedAsTakenEvenIfTheLastErrorIsNot() {
        var recovery = CaptureRecovery(maxAttempts: 2)
        _ = recovery.apply(.interrupted)

        _ = recovery.apply(.rebuildFailed(systemHoldsInput: true, description: "!pri"))
        XCTAssertEqual(
            recovery.apply(.rebuildFailed(systemHoldsInput: false, description: "input unavailable")),
            .giveUp(.takenBySystem))
    }

    /// One give-up per chain. A straggler from the chain that gave up is not a
    /// reason to tell the keyboard twice — on the app side that second telling
    /// would be a second session being torn down.
    func testAStragglerFailureAfterGivingUpChangesNothing() {
        var recovery = givenUp()

        XCTAssertEqual(
            recovery.apply(.refusedInBackground), .wait)
        XCTAssertTrue(recovery.hasGivenUp)
    }

    // MARK: a fresh start

    /// The user tapped. Nothing this policy was remembering belongs to the
    /// capture that is being replaced — which is the rule the app side enforces
    /// by never reusing a capture that reported a loss.
    func testRestartingForgetsEverything() {
        var recovery = givenUp()

        XCTAssertEqual(recovery.apply(.restarted), .wait)
        XCTAssertTrue(recovery.holdsMicrophone)
        XCTAssertFalse(recovery.hasGivenUp)
        XCTAssertEqual(recovery.attempts, 0)
        // And the fresh capture's first interruption is reported on its own
        // terms, not inheriting the last one's story.
        _ = recovery.apply(.engineStopped)
        XCTAssertEqual(
            recovery.apply(.rebuildFailed(systemHoldsInput: false, description: "no converter")),
            .rebuild(afterMilliseconds: recovery.firstBackoffMilliseconds))
    }

    /// A healthy capture is not woken up by events it has nothing to do with.
    func testAForegroundTripDoesNothingWhileTheMicrophoneIsOurs() {
        var recovery = CaptureRecovery()

        XCTAssertEqual(recovery.apply(.appBecameActive), .wait)
        XCTAssertTrue(recovery.holdsMicrophone)
    }

    // MARK: helpers

    private func givenUp() -> CaptureRecovery {
        var recovery = CaptureRecovery()
        _ = recovery.apply(.interrupted)
        _ = recovery.apply(.interruptionEnded)
        while !recovery.hasGivenUp {
            _ = recovery.apply(.refusedInBackground)
        }
        return recovery
    }

    private func isGiveUp(_ action: CaptureRecovery.Action) -> Bool {
        if case .giveUp = action { return true }
        return false
    }
}

extension CaptureRecovery.Event {
    /// The failure the bug is made of: `setActive(true)` refused because the app
    /// is in the background and another client is running (`!pri`, 561017449).
    fileprivate static let refusedInBackground = CaptureRecovery.Event.rebuildFailed(
        systemHoldsInput: true, description: "!pri")
}
