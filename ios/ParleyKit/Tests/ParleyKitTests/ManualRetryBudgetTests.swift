import XCTest

@testable import ParleyKit

final class ManualRetryBudgetTests: XCTestCase {

    private let id = "rec-1"

    // MARK: the cap

    func testAFreshRecordingHasTheWholeBudget() {
        let budget = ManualRetryBudget()

        XCTAssertEqual(budget.spentCount(for: id), 0)
        XCTAssertEqual(budget.remaining(for: id), 3)
        XCTAssertTrue(budget.allowsRetry(for: id))
    }

    func testSpendingTheBudgetClosesTheEntryPoint() {
        var budget = ManualRetryBudget()
        for expected in [2, 1, 0] {
            XCTAssertTrue(budget.allowsRetry(for: id))
            budget.spend(for: id)
            XCTAssertEqual(budget.remaining(for: id), expected)
        }

        XCTAssertFalse(budget.allowsRetry(for: id))
    }

    /// The failure the ledger exists to prevent: the queue entry that carries a
    /// request is deleted when the run finishes, so if the count lived there a
    /// successful re-run would leave no trace and the budget would reset.
    func testTheCountSurvivesEncodingAndDecoding() throws {
        var budget = ManualRetryBudget()
        budget.spend(for: id)
        budget.spend(for: "rec-2")
        budget.spend(for: "rec-2")

        let round = try JSONDecoder().decode(
            ManualRetryBudget.self, from: JSONEncoder().encode(budget))

        XCTAssertEqual(round.spentCount(for: id), 1)
        XCTAssertEqual(round.spentCount(for: "rec-2"), 2)
        XCTAssertEqual(round, budget)
    }

    func testRecordingsDoNotShareABudget() {
        var budget = ManualRetryBudget()
        for _ in 0..<3 { budget.spend(for: id) }

        XCTAssertFalse(budget.allowsRetry(for: id))
        XCTAssertTrue(budget.allowsRetry(for: "rec-2"))
    }

    /// A build that raises or lowers the cap has to read an existing ledger
    /// without going negative or granting a refund it cannot account for.
    func testALedgerOverTheCapReadsAsSpentOutRatherThanAsADebt() {
        let budget = ManualRetryBudget(spent: [id: 9])
        let tight = TranscriptCoverage.BackfillPolicy(maxManualRetries: 1)

        XCTAssertEqual(budget.remaining(for: id, policy: tight), 0)
        XCTAssertFalse(budget.allowsRetry(for: id, policy: tight))
    }

    func testSpendingIsClampedToTheCap() {
        var budget = ManualRetryBudget()
        for _ in 0..<10 { budget.spend(for: id) }

        XCTAssertEqual(budget.spentCount(for: id), 3)
    }

    func testNothingSpentIsNotStoredAsZero() {
        let budget = ManualRetryBudget(spent: [id: 0])

        XCTAssertEqual(budget.spent, [:])
    }

    // MARK: the attempt ordinal

    /// The ordinal stamped on the queued request. Non-zero is how a finished
    /// backfill knows it was asked for by hand and should be charged; the
    /// automatic one carries 0 and is not.
    func testTheFirstHandTriggeredAttemptIsOneSoItIsNeverMistakenForTheAutomaticOne() {
        var budget = ManualRetryBudget()

        XCTAssertEqual(budget.nextAttempt(for: id), 1)
        budget.spend(for: id)
        XCTAssertEqual(budget.nextAttempt(for: id), 2)
    }

    func testForgettingARecordingGivesItsBudgetBack() {
        var budget = ManualRetryBudget()
        budget.spend(for: id)
        budget.forget(id)

        XCTAssertEqual(budget.remaining(for: id), 3)
    }
}
