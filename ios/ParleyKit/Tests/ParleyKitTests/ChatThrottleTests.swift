import Foundation
import XCTest

@testable import ParleyKit

/// The hosted chat calls back off instead of hammering a rate-limited
/// provider: a 429 waits as long as `Retry-After` says, a 502 gets a couple of
/// short retries, and anything else surfaces at once.
final class ChatThrottleTests: XCTestCase {
    private let policy = ChatRetryPolicy(
        maxRateLimitRetries: 3, maxBadGatewayRetries: 2, baseDelay: 2, maxDelay: 30,
        jitterFraction: 0.5)

    // MARK: delay

    func testRateLimitHonoursRetryAfter() {
        let error = CloudError(status: 429, message: "", retryAfter: 12)
        XCTAssertEqual(policy.delay(after: error, retry: 0, jitter: 0), 12)
    }

    func testRateLimitWithoutRetryAfterBacksOffExponentially() {
        let error = CloudError(status: 429, message: "")
        XCTAssertEqual(policy.delay(after: error, retry: 0, jitter: 0), 2)
        XCTAssertEqual(policy.delay(after: error, retry: 1, jitter: 0), 4)
        XCTAssertEqual(policy.delay(after: error, retry: 2, jitter: 0), 8)
        XCTAssertNil(policy.delay(after: error, retry: 3, jitter: 0), "bounded")
    }

    func testRetryAfterIsCapped() {
        let error = CloudError(status: 429, message: "", retryAfter: 600)
        XCTAssertEqual(policy.delay(after: error, retry: 0, jitter: 0), 30)
    }

    func testJitterOnlyEverAddsAndStaysBounded() {
        let error = CloudError(status: 429, message: "", retryAfter: 10)
        XCTAssertEqual(policy.delay(after: error, retry: 0, jitter: 0.999)!, 15, accuracy: 0.01)
    }

    func testBadGatewayGetsTwoShortRetries() {
        let error = CloudError(status: 502, message: "")
        XCTAssertEqual(policy.delay(after: error, retry: 0, jitter: 0), 2)
        XCTAssertEqual(policy.delay(after: error, retry: 1, jitter: 0), 4)
        XCTAssertNil(policy.delay(after: error, retry: 2, jitter: 0))
    }

    func testOtherStatusesAreNeverRetried() {
        for status in [400, 401, 402, 403, 413, 500, 503] {
            XCTAssertNil(
                policy.delay(after: CloudError(status: status, message: ""), retry: 0, jitter: 0),
                "HTTP \(status)")
        }
    }

    // MARK: Retry-After parsing

    func testRetryAfterParsesSecondsAndHTTPDates() {
        XCTAssertEqual(ChatRetryPolicy.retryAfter("7"), 7)
        XCTAssertNil(ChatRetryPolicy.retryAfter(nil))
        XCTAssertNil(ChatRetryPolicy.retryAfter("soon"))
        let now = Date(timeIntervalSince1970: 1_445_412_480)  // Wed, 21 Oct 2015 07:28:00 GMT
        XCTAssertEqual(
            ChatRetryPolicy.retryAfter("Wed, 21 Oct 2015 07:28:30 GMT", now: now)!, 30,
            accuracy: 0.5)
    }

    // MARK: run

    func testRunRetriesARateLimitThenSucceeds() async throws {
        let attempts = Counter()
        let waits = Recorder()
        let result = try await policy.run(
            jitter: { 0 }, sleep: { await waits.add($0) },
            {
                let n = await attempts.next()
                if n < 2 { throw CloudError(status: 429, message: "", retryAfter: 5) }
                return "ok"
            })

        XCTAssertEqual(result, "ok")
        let recorded = await waits.values
        XCTAssertEqual(recorded, [5, 5])
    }

    func testRunGivesUpAfterTheBudgetAndRethrows() async {
        let attempts = Counter()
        do {
            _ = try await policy.run(
                jitter: { 0 }, sleep: { _ in },
                { () async throws -> String in
                    _ = await attempts.next()
                    throw CloudError(status: 502, message: "")
                })
            XCTFail("must rethrow once retries are spent")
        } catch let error as CloudError {
            XCTAssertEqual(error.status, 502)
        } catch {
            XCTFail("unexpected \(error)")
        }
        let total = await attempts.count
        XCTAssertEqual(total, 3, "one attempt plus two retries")
    }

    func testRunDoesNotRetryNonCloudErrors() async {
        let attempts = Counter()
        do {
            _ = try await policy.run(
                jitter: { 0 }, sleep: { _ in },
                { () async throws -> String in
                    _ = await attempts.next()
                    throw URLError(.timedOut)
                })
            XCTFail("must rethrow")
        } catch {}
        let total = await attempts.count
        XCTAssertEqual(total, 1)
    }

    // MARK: gate

    func testGateNeverLetsMoreThanTheLimitIn() async throws {
        let gate = ConcurrencyGate(limit: 2)
        let peak = Recorder()
        let live = Counter()

        try await withThrowingTaskGroup(of: Void.self) { group in
            for _ in 0..<8 {
                group.addTask {
                    try await gate.withSlot {
                        let now = await live.next() + 1
                        await peak.add(Double(now))
                        try await Task.sleep(for: .milliseconds(10))
                        await live.decrement()
                    }
                }
            }
            try await group.waitForAll()
        }

        let maxSeen = await peak.values.max() ?? 0
        XCTAssertEqual(maxSeen, 2)
        let remaining = await gate.inFlight
        XCTAssertEqual(remaining, 0)
    }

    func testCancelledWaiterLeavesTheQueue() async throws {
        let gate = ConcurrencyGate(limit: 1)
        let release = AsyncFlag()
        let holder = Task { try await gate.withSlot { await release.wait() } }
        try await Task.sleep(for: .milliseconds(20))

        let waiter = Task { try await gate.withSlot { "ran" } }
        try await Task.sleep(for: .milliseconds(20))
        waiter.cancel()
        do {
            _ = try await waiter.value
            XCTFail("a cancelled waiter must not run")
        } catch is CancellationError {}

        await release.set()
        _ = try await holder.value
        let after = try await gate.withSlot { "free" }
        XCTAssertEqual(after, "free")
    }
}

private actor Counter {
    private(set) var count = 0
    func next() -> Int {
        defer { count += 1 }
        return count
    }
    func decrement() { count -= 1 }
}

private actor Recorder {
    private(set) var values: [Double] = []
    func add(_ value: Double) { values.append(value) }
}

private actor AsyncFlag {
    private var isSet = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        if isSet { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func set() {
        isSet = true
        waiters.forEach { $0.resume() }
        waiters = []
    }
}
