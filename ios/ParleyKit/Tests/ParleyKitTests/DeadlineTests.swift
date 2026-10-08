import XCTest

@testable import ParleyKit

/// `Deadline.wait` has to bound work that ignores cancellation — the case the
/// task-group race it replaced in `ParleyStreamClient` got wrong.
final class DeadlineTests: XCTestCase {
    func testWorkThatFinishesInTimeWins() async {
        let finished = await Deadline.wait(atMost: .seconds(5)) {
            try? await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertTrue(finished)
    }

    func testReturnsAtTheDeadlineWhenTheWorkIgnoresCancellation() async {
        // A writer stuck on a stalled socket, as `finish()` sees it: an
        // unstructured task whose `value` does not stop being awaited when the
        // waiter is cancelled.
        let stuck = Task { try? await Task.sleep(for: .seconds(3)) }
        defer { stuck.cancel() }
        let started = ContinuousClock.now
        let finished = await Deadline.wait(atMost: .milliseconds(100)) { _ = await stuck.value }
        let waited = ContinuousClock.now - started
        XCTAssertFalse(finished)
        XCTAssertLessThan(waited, .seconds(1), "waited \(waited) for a 100 ms deadline")
    }

    func testTheTaskGroupRaceItReplacesDoesNotBoundTheSameWork() async {
        // The old `drainWriter`, verbatim in shape. Kept as a test so the
        // reason `Deadline` exists cannot quietly stop being true.
        let stuck = Task { try? await Task.sleep(for: .milliseconds(600)) }
        let started = ContinuousClock.now
        await withTaskGroup(of: Void.self) { group in
            group.addTask { _ = await stuck.value }
            group.addTask { try? await Task.sleep(for: .milliseconds(50)) }
            await group.next()
            group.cancelAll()
        }
        let waited = ContinuousClock.now - started
        XCTAssertGreaterThanOrEqual(waited, .milliseconds(500))
    }

    func testACancelledCallerIsReleasedAtOnce() async {
        let stuck = Task { try? await Task.sleep(for: .seconds(3)) }
        defer { stuck.cancel() }
        let started = ContinuousClock.now
        let waiter = Task {
            await Deadline.wait(atMost: .seconds(10)) { _ = await stuck.value }
        }
        try? await Task.sleep(for: .milliseconds(50))
        waiter.cancel()
        let finished = await waiter.value
        XCTAssertFalse(finished)
        XCTAssertLessThan(ContinuousClock.now - started, .seconds(1))
    }
}
