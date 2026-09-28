import Foundation

/// Wait for some work, but never past a deadline.
///
/// The obvious way to write this — a task group racing the work against a
/// `Task.sleep` and cancelling the loser — does not bound anything when the
/// work is something that ignores cancellation, such as awaiting an
/// unstructured `Task`'s `value` or a socket send that is stuck in the network
/// stack: a task group always waits for *every* child before it returns,
/// cancelled or not. That is exactly how `SttRelayClient.finish()` used to wait
/// on a writer blocked by a stalled socket for as long as the socket stayed
/// stalled, with its three-second "timeout" in place the whole time, and how a
/// dictation stopped in a network dead spot stayed `finishing` — polish wave
/// running, nothing inserted — with the app alive and vouching for it.
///
/// Here the work runs in a task of its own and the caller is resumed by
/// whichever of the work and the clock gets there first. The work is neither
/// cancelled nor awaited past the deadline: it keeps running unobserved and
/// ends whenever it ends, which is the only thing that can be done with work
/// that will not stop when asked.
public enum Deadline {
    /// Run `work` and return once it has finished or `limit` has passed,
    /// whichever comes first — or at once if the caller is cancelled. `true`
    /// means the work finished in time.
    @discardableResult
    public static func wait(
        atMost limit: Duration, for work: @escaping @Sendable () async -> Void
    ) async -> Bool {
        let race = Race()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
                race.arm(continuation)
                Task {
                    await work()
                    race.settle(true)
                }
                let clock = Task {
                    try? await Task.sleep(for: limit)
                    race.settle(false)
                }
                // The clock has nothing left to do once either side has won;
                // the work is left alone (see the type doc).
                race.onSettle { clock.cancel() }
            }
        } onCancel: {
            race.settle(false)
        }
    }
}

/// The one-shot continuation behind `Deadline.wait`: the first `settle` wins,
/// and one that lands before the continuation is armed (the caller cancelled
/// before the race began) is kept for it.
private final class Race: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Bool, Never>?
    private var outcome: Bool?
    private var cleanup: (() -> Void)?

    func arm(_ continuation: CheckedContinuation<Bool, Never>) {
        lock.lock()
        if let outcome {
            lock.unlock()
            continuation.resume(returning: outcome)
            return
        }
        self.continuation = continuation
        lock.unlock()
    }

    func onSettle(_ body: @escaping () -> Void) {
        lock.lock()
        if outcome != nil {
            lock.unlock()
            body()
            return
        }
        cleanup = body
        lock.unlock()
    }

    func settle(_ value: Bool) {
        lock.lock()
        guard outcome == nil else {
            lock.unlock()
            return
        }
        outcome = value
        let waiting = continuation
        continuation = nil
        let done = cleanup
        cleanup = nil
        lock.unlock()
        waiting?.resume(returning: value)
        done?()
    }
}
