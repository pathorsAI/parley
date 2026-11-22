import Foundation

/// The decisions behind handing a recording's audio to a background
/// `URLSession`, kept free of `URLSession` itself so they can be unit-tested
/// on macOS (`swift test`) without a simulator.
///
/// Why a background session at all (parley#727): the audio PUT used to run in
/// the app's own process, under a ~30 s `beginBackgroundTask`. A user who
/// locked the phone right after Stop got the app suspended mid-PUT, and the
/// next attempt waited for the app to come back to the foreground — days, for
/// someone who records once and does not open the app again. A background
/// session hands the transfer to the system, which finishes it while the app
/// is suspended or even terminated, and relaunches the app to hear about it.
public enum BackgroundUploadPlan {
    /// The session identifier. Must stay stable across releases: a transfer
    /// started by one build is reported to the next under this name, and a
    /// renamed session would orphan every upload in flight during an update.
    public static let sessionIdentifier = "com.pathors.parley.ios.audio-upload"

    /// How long the system may keep one transfer alive, waiting for a network
    /// included. Long enough to ride out a weekend in airplane mode, short
    /// enough that a transfer carrying a bearer token from a session that has
    /// since been replaced eventually fails and is re-created by the queue with
    /// a fresh one.
    public static let resourceTimeout: TimeInterval = 48 * 60 * 60

    // MARK: task ↔ queue entry

    private static let descriptionPrefix = "parley-audio:"

    /// What a task's `taskDescription` holds. The system persists it with the
    /// task, so it is how a relaunched app knows which queued recording a
    /// finished transfer belongs to.
    public static func taskDescription(forRecording id: String) -> String {
        descriptionPrefix + id
    }

    /// The recording id a task was started for, or nil for a task this code
    /// did not start (or a description written by something else).
    public static func recordingId(fromTaskDescription description: String?) -> String? {
        guard let description, description.hasPrefix(descriptionPrefix) else { return nil }
        let id = String(description.dropFirst(descriptionPrefix.count))
        return id.isEmpty ? nil : id
    }

    // MARK: what to do with a queued entry

    /// How an upload attempt should get the audio to the server.
    public enum Action: Equatable {
        /// An earlier transfer already landed the audio (the manifest says
        /// so): skip the PUT and go straight to the follow-up calls.
        case skipAlreadyUploaded
        /// A transfer for this recording is already running in the system:
        /// wait for that one rather than send the same hour of audio twice.
        case attach(taskIdentifier: Int)
        /// Nothing is in flight: start a new transfer.
        case start
    }

    /// - Parameters:
    ///   - audioAlreadyUploaded: the manifest carries a successful transfer.
    ///   - liveTasks: the session's running or suspended tasks, as
    ///     (taskIdentifier, taskDescription).
    public static func action(
        forRecording id: String,
        audioAlreadyUploaded: Bool,
        liveTasks: [(identifier: Int, description: String?)]
    ) -> Action {
        if audioAlreadyUploaded { return .skipAlreadyUploaded }
        if let task = liveTasks.first(where: { recordingId(fromTaskDescription: $0.description) == id }) {
            return .attach(taskIdentifier: task.identifier)
        }
        return .start
    }

    // MARK: how a transfer ended

    /// What a finished task means for its queue entry.
    public enum Outcome: Equatable {
        /// 2xx: the audio is on the server.
        case uploaded
        /// The server answered with something else. The queue treats it
        /// exactly as it treats the same answer to an in-process PUT
        /// (`UploadFailureDisposition`).
        case refused(status: Int, message: String, retryAfter: TimeInterval?)
        /// No answer: transport failure, timeout, or a cancelled task.
        /// `forceQuit` is iOS cancelling every background transfer because the
        /// user swiped the app away — expected, and retried at next launch.
        case transportFailed(code: Int, forceQuit: Bool)
    }

    public static func outcome(
        httpStatus: Int?, body: Data, retryAfterHeader: String?, error: Error?
    ) -> Outcome {
        if let error {
            let ns = error as NSError
            let reason = ns.userInfo[NSURLErrorBackgroundTaskCancelledReasonKey] as? Int
            return .transportFailed(
                code: ns.code,
                forceQuit: reason == NSURLErrorCancelledReasonUserForceQuitApplication)
        }
        guard let status = httpStatus else {
            return .transportFailed(code: URLError.badServerResponse.rawValue, forceQuit: false)
        }
        if (200..<300).contains(status) { return .uploaded }
        return .refused(
            status: status, message: String(data: body, encoding: .utf8) ?? "",
            retryAfter: retryAfterHeader.flatMap { TimeInterval($0.trimmingCharacters(in: .whitespaces)) })
    }

    // MARK: how long a foreground caller waits

    /// A caller waiting on a transfer gives up waiting — the transfer itself
    /// carries on in the system — when the transfer has made no progress for
    /// this long. A background session never fails fast offline (it waits for
    /// connectivity instead), so without this the end-of-meeting screen would
    /// sit on "Uploading…" for as long as the phone had no signal.
    public static let stallTimeout: TimeInterval = 20

    /// Whether a waiting caller should stop waiting.
    ///
    /// - Parameters:
    ///   - lastProgressAt: when the byte count last moved, or when the wait
    ///     started if it never has.
    ///   - startedAt: when the wait started.
    ///   - overallLimit: the most a caller waits even on a transfer that is
    ///     moving (`AudioUploadTimeout.forBody`).
    public static func shouldStopWaiting(
        now: Date, startedAt: Date, lastProgressAt: Date, overallLimit: TimeInterval
    ) -> Bool {
        now.timeIntervalSince(lastProgressAt) >= stallTimeout
            || now.timeIntervalSince(startedAt) >= overallLimit
    }
}
