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

    /// Keep the app running for a stretch of work that has no single closure
    /// to wrap — stopping a meeting, or the calls that follow a background
    /// transfer. When iOS calls time the assertion is simply ended (nothing is
    /// cancelled); the caller ends it when the work is done.
    @MainActor
    static func hold(_ name: String) -> Hold {
        Hold(Assertion.begin(name) {})
    }

    @MainActor
    final class Hold {
        private let assertion: Assertion
        fileprivate init(_ assertion: Assertion) { self.assertion = assertion }
        func end() { assertion.end() }
    }

    /// One background task, ended exactly once — by the work finishing or by
    /// iOS calling time, whichever comes first. Ending one twice is a
    /// programming error UIKit logs; never ending one gets the app killed.
    @MainActor
    fileprivate final class Assertion {
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
