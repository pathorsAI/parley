import UIKit

/// Run a piece of network work under a `UIApplication` background task, so a
/// user who leaves the app the moment a meeting ends still gives it the extra
/// half a minute or so iOS allows.
///
/// The hosted batch transcription is the reason this exists: the upload and
/// the first stretch of polling used to be cut off as soon as the app was
/// suspended, and the job left behind on the server was abandoned. When the
/// grace runs out the work is cancelled — nothing more — because the job id is
/// already written down (`BatchResume`) and the next foreground picks it up
/// where this left off.
enum BackgroundGrace {
    static func run<T: Sendable>(
        _ name: String, _ work: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        let task = Task { try await work() }
        let assertion = await Assertion.begin(name) { task.cancel() }
        defer { Task { @MainActor in assertion.end() } }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    /// One background task, ended exactly once — by the work finishing or by
    /// iOS calling time, whichever comes first. Ending one twice is a
    /// programming error UIKit logs; never ending one gets the app killed.
    @MainActor
    private final class Assertion {
        private var id: UIBackgroundTaskIdentifier = .invalid

        static func begin(_ name: String, onExpiry: @escaping @Sendable () -> Void) -> Assertion {
            let assertion = Assertion()
            assertion.id = UIApplication.shared.beginBackgroundTask(withName: name) {
                onExpiry()
                assertion.end()
            }
            return assertion
        }

        func end() {
            guard id != .invalid else { return }
            UIApplication.shared.endBackgroundTask(id)
            id = .invalid
        }
    }
}
