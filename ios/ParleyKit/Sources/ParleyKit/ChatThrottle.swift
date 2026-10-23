import Foundation

/// How a hosted chat call is retried, and how many may be out at once.
///
/// The cloud's LLM proxy sits in front of a provider with a per-minute token
/// budget shared by every user. A phone that fires a burst of long requests
/// (each filing pass reads up to 24 000 characters of transcript) drains that
/// budget for everyone, and when every request then fails at once, retrying
/// them all immediately is the worst possible answer. So: at most two in
/// flight per process, a 429 waits for as long as the server's `Retry-After`
/// says (or a bounded exponential backoff when it does not say), a 502 gets a
/// couple of short retries, and nothing else is retried at all.
public struct ChatRetryPolicy: Sendable, Equatable {
    /// Retries after the first attempt, per status.
    public var maxRateLimitRetries: Int
    public var maxBadGatewayRetries: Int
    /// The first backoff; each later one doubles it.
    public var baseDelay: TimeInterval
    /// No single wait is longer than this, whatever `Retry-After` asks for.
    public var maxDelay: TimeInterval
    /// Up to this fraction of the delay is added at random, so a set of
    /// requests that failed together does not come back together.
    public var jitterFraction: Double

    public init(
        maxRateLimitRetries: Int = 3, maxBadGatewayRetries: Int = 2,
        baseDelay: TimeInterval = 2, maxDelay: TimeInterval = 30, jitterFraction: Double = 0.5
    ) {
        self.maxRateLimitRetries = maxRateLimitRetries
        self.maxBadGatewayRetries = maxBadGatewayRetries
        self.baseDelay = baseDelay
        self.maxDelay = maxDelay
        self.jitterFraction = jitterFraction
    }

    public static let standard = ChatRetryPolicy()

    /// How long to wait before retry number `retry` (0 for the first retry)
    /// after `error`, or `nil` to give up and surface the error.
    ///
    /// `jitter` is a number in `0..<1`, injected so the tests can pin it.
    public func delay(after error: CloudError, retry: Int, jitter: Double) -> TimeInterval? {
        guard let limit = retryLimit(for: error.status), retry < limit else { return nil }
        let backoff = baseDelay * pow(2, Double(retry))
        let wanted = error.status == 429 ? max(error.retryAfter ?? backoff, backoff) : backoff
        let capped = min(wanted, maxDelay)
        return capped + capped * jitterFraction * jitter
    }

    private func retryLimit(for status: Int) -> Int? {
        switch status {
        case 429: return maxRateLimitRetries
        case 502: return maxBadGatewayRetries
        default: return nil
        }
    }

    /// `Retry-After` as seconds: either the delta-seconds form or an HTTP date.
    /// `nil` for a header that is absent or unreadable.
    public static func retryAfter(_ header: String?, now: Date = Date()) -> TimeInterval? {
        guard let raw = header?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else {
            return nil
        }
        if let seconds = Double(raw), seconds.isFinite, seconds >= 0 { return seconds }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        guard let date = formatter.date(from: raw) else { return nil }
        return max(0, date.timeIntervalSince(now))
    }

    /// Run `operation`, retrying it by this policy. Each wait goes through
    /// `sleep`, which throws on cancellation, so a caller that has given up —
    /// the dictation polish racing its own deadline — stops the retries too.
    public func run<T: Sendable>(
        jitter: @Sendable () -> Double = { Double.random(in: 0..<1) },
        sleep: @Sendable (TimeInterval) async throws -> Void = { try await ChatRetryPolicy.sleep($0) },
        _ operation: @Sendable () async throws -> T
    ) async throws -> T {
        var retry = 0
        while true {
            do {
                return try await operation()
            } catch let error as CloudError {
                guard let wait = delay(after: error, retry: retry, jitter: jitter()) else {
                    throw error
                }
                try await sleep(wait)
                retry += 1
            }
        }
    }

    public static func sleep(_ seconds: TimeInterval) async throws {
        try await Task.sleep(for: .milliseconds(Int(seconds * 1000)))
    }
}

/// An async counting semaphore: at most `limit` holders at a time, the rest
/// waiting in arrival order. A waiter whose task is cancelled leaves the queue
/// and throws `CancellationError`.
public actor ConcurrencyGate {
    private let limit: Int
    private var holders = 0
    private var waiters: [(id: UUID, continuation: CheckedContinuation<Void, Error>)] = []

    public init(limit: Int) {
        self.limit = max(1, limit)
    }

    /// Hold a slot for the duration of `body`.
    public func withSlot<T: Sendable>(_ body: @Sendable () async throws -> T) async throws -> T {
        try await acquire()
        defer { release() }
        return try await body()
    }

    var inFlight: Int { holders }

    private func acquire() async throws {
        if holders < limit {
            holders += 1
            return
        }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                if Task.isCancelled {
                    continuation.resume(throwing: CancellationError())
                } else {
                    waiters.append((id, continuation))
                }
            }
        } onCancel: {
            Task { await self.cancelWaiter(id) }
        }
    }

    /// The slot passes straight to the next waiter, so `holders` only falls
    /// when nobody is waiting for it.
    private func release() {
        if waiters.isEmpty {
            holders -= 1
        } else {
            waiters.removeFirst().continuation.resume()
        }
    }

    private func cancelWaiter(_ id: UUID) {
        guard let index = waiters.firstIndex(where: { $0.id == id }) else { return }
        waiters.remove(at: index).continuation.resume(throwing: CancellationError())
    }
}
