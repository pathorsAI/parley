import XCTest

@testable import ParleyKit

final class BackgroundUploadPlanTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    // MARK: task ↔ queue entry

    func testTaskDescriptionRoundTripsTheRecordingId() {
        let id = "8f0c2a4e-1b3d-4e5f-9a7b-6c5d4e3f2a1b"
        let description = BackgroundUploadPlan.taskDescription(forRecording: id)
        XCTAssertEqual(BackgroundUploadPlan.recordingId(fromTaskDescription: description), id)
    }

    func testForeignOrEmptyDescriptionsBelongToNoRecording() {
        XCTAssertNil(BackgroundUploadPlan.recordingId(fromTaskDescription: nil))
        XCTAssertNil(BackgroundUploadPlan.recordingId(fromTaskDescription: ""))
        XCTAssertNil(BackgroundUploadPlan.recordingId(fromTaskDescription: "some-other-task"))
        XCTAssertNil(BackgroundUploadPlan.recordingId(fromTaskDescription: "parley-audio:"))
    }

    func testSessionIdentifierNeverChanges() {
        // A renamed session orphans every transfer in flight across an update.
        XCTAssertEqual(BackgroundUploadPlan.sessionIdentifier, "com.pathors.parley.ios.audio-upload")
    }

    // MARK: what to do with a queued entry

    func testAudioAlreadyUploadedSkipsThePutEvenWithATaskAround() {
        let tasks = [(identifier: 7, description: Optional(BackgroundUploadPlan.taskDescription(forRecording: "a")))]
        XCTAssertEqual(
            BackgroundUploadPlan.action(forRecording: "a", audioAlreadyUploaded: true, liveTasks: tasks),
            .skipAlreadyUploaded)
    }

    func testATransferAlreadyInFlightIsAttachedNotDuplicated() {
        let tasks: [(identifier: Int, description: String?)] = [
            (3, BackgroundUploadPlan.taskDescription(forRecording: "other")),
            (9, BackgroundUploadPlan.taskDescription(forRecording: "a")),
            (11, nil),
        ]
        XCTAssertEqual(
            BackgroundUploadPlan.action(forRecording: "a", audioAlreadyUploaded: false, liveTasks: tasks),
            .attach(taskIdentifier: 9))
    }

    func testNothingInFlightStartsATransfer() {
        let tasks: [(identifier: Int, description: String?)] = [
            (3, BackgroundUploadPlan.taskDescription(forRecording: "other"))
        ]
        XCTAssertEqual(
            BackgroundUploadPlan.action(forRecording: "a", audioAlreadyUploaded: false, liveTasks: tasks),
            .start)
        XCTAssertEqual(
            BackgroundUploadPlan.action(forRecording: "a", audioAlreadyUploaded: false, liveTasks: []),
            .start)
    }

    // MARK: how a transfer ended

    func testTwoHundredsAreUploaded() {
        for status in [200, 201, 204] {
            XCTAssertEqual(
                BackgroundUploadPlan.outcome(httpStatus: status, body: Data(), retryAfterHeader: nil, error: nil),
                .uploaded)
        }
    }

    func testARefusalCarriesStatusMessageAndRetryAfter() {
        let outcome = BackgroundUploadPlan.outcome(
            httpStatus: 429, body: Data("slow down".utf8), retryAfterHeader: " 30 ", error: nil)
        XCTAssertEqual(outcome, .refused(status: 429, message: "slow down", retryAfter: 30))
        XCTAssertEqual(
            BackgroundUploadPlan.outcome(httpStatus: 402, body: Data(), retryAfterHeader: nil, error: nil),
            .refused(status: 402, message: "", retryAfter: nil))
    }

    func testTransportErrorsAreNotRefusals() {
        let offline = URLError(.notConnectedToInternet)
        XCTAssertEqual(
            BackgroundUploadPlan.outcome(httpStatus: nil, body: Data(), retryAfterHeader: nil, error: offline),
            .transportFailed(code: URLError.notConnectedToInternet.rawValue, forceQuit: false))
    }

    func testForceQuitCancellationIsRecognised() {
        let error = NSError(
            domain: NSURLErrorDomain, code: NSURLErrorCancelled,
            userInfo: [
                NSURLErrorBackgroundTaskCancelledReasonKey: NSURLErrorCancelledReasonUserForceQuitApplication
            ])
        XCTAssertEqual(
            BackgroundUploadPlan.outcome(httpStatus: nil, body: Data(), retryAfterHeader: nil, error: error),
            .transportFailed(code: NSURLErrorCancelled, forceQuit: true))
    }

    func testNoResponseAndNoErrorIsATransportFailure() {
        XCTAssertEqual(
            BackgroundUploadPlan.outcome(httpStatus: nil, body: Data(), retryAfterHeader: nil, error: nil),
            .transportFailed(code: URLError.badServerResponse.rawValue, forceQuit: false))
    }

    // MARK: how long a foreground caller waits

    func testAMovingTransferIsWaitedOn() {
        XCTAssertFalse(
            BackgroundUploadPlan.shouldStopWaiting(
                now: t0.addingTimeInterval(120), startedAt: t0,
                lastProgressAt: t0.addingTimeInterval(118), overallLimit: 600))
    }

    func testAStalledTransferLetsTheCallerGo() {
        XCTAssertTrue(
            BackgroundUploadPlan.shouldStopWaiting(
                now: t0.addingTimeInterval(BackgroundUploadPlan.stallTimeout), startedAt: t0,
                lastProgressAt: t0, overallLimit: 600))
    }

    func testTheOverallLimitHoldsEvenWhileMoving() {
        XCTAssertTrue(
            BackgroundUploadPlan.shouldStopWaiting(
                now: t0.addingTimeInterval(600), startedAt: t0,
                lastProgressAt: t0.addingTimeInterval(599), overallLimit: 600))
    }
}
