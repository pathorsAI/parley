import Foundation
import XCTest

@testable import ParleyKit

/// A job created by one attempt is collected by the next instead of being paid
/// for again — the fix for iOS cancelling the poll loop when the app is
/// suspended, after which every retry re-uploaded the whole recording.
final class BatchResumeTests: XCTestCase {
    private let key = "rec-1"
    private let audio = Data(count: 42)
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    private func transcriber(_ service: ResumeFakeService, at now: Date? = nil) -> BatchTranscriber {
        let clock = now ?? t0
        return BatchTranscriber(
            service: service, pollInterval: .milliseconds(1), maxPolls: 5, now: { clock })
    }

    private func record(_ jobId: String, bytes: Int? = nil, age: TimeInterval = 60) -> BatchJobRecord {
        BatchJobRecord(
            jobId: jobId, audioBytes: bytes ?? audio.count, createdAt: t0.addingTimeInterval(-age))
    }

    func testFreshUploadPersistsTheJobUntilTheTranscriptIsIn() async throws {
        let store = InMemoryBatchJobStore()
        let fake = ResumeFakeService(newJobId: "new", status: [:])
        await fake.onPoll { id in
            // While the job is being polled it is already written down.
            XCTAssertEqual(store.job(for: "rec-1")?.jobId, id)
        }

        _ = try await transcriber(fake).transcribe(
            audio: audio, resume: BatchResume(store: store, key: key))

        let starts = await fake.starts
        XCTAssertEqual(starts, 1)
        XCTAssertNil(store.job(for: key), "a collected job is forgotten")
        let deleted = await fake.deleted
        XCTAssertEqual(deleted, ["new"])
    }

    func testCancelledPollKeepsTheJobForTheNextAttempt() async throws {
        let store = InMemoryBatchJobStore()
        let fake = ResumeFakeService(newJobId: "new", status: ["new": .stuck])

        do {
            _ = try await transcriber(fake).transcribe(
                audio: audio, resume: BatchResume(store: store, key: key))
            XCTFail("a job that never settles must not return")
        } catch BatchTranscriptionError.timedOut {}

        XCTAssertEqual(store.job(for: key)?.jobId, "new")
        XCTAssertEqual(store.job(for: key)?.audioBytes, audio.count)
    }

    func testPersistedJobIsResumedInsteadOfUploading() async throws {
        let store = InMemoryBatchJobStore()
        store.save(record("old"), for: key)
        let fake = ResumeFakeService(newJobId: "new", status: [:])

        _ = try await transcriber(fake).transcribe(
            audio: audio, resume: BatchResume(store: store, key: key))

        let starts = await fake.starts
        let polled = await fake.polledIds
        XCTAssertEqual(starts, 0, "the audio must not be uploaded again")
        XCTAssertEqual(Set(polled), ["old"])
        XCTAssertNil(store.job(for: key))
    }

    func testVanishedJobFallsBackToAFreshUpload() async throws {
        let store = InMemoryBatchJobStore()
        store.save(record("old"), for: key)
        let fake = ResumeFakeService(newJobId: "new", status: ["old": .notFound])

        _ = try await transcriber(fake).transcribe(
            audio: audio, resume: BatchResume(store: store, key: key))

        let starts = await fake.starts
        let deleted = await fake.deleted
        XCTAssertEqual(starts, 1)
        XCTAssertEqual(deleted, ["new"])
        XCTAssertNil(store.job(for: key))
    }

    func testFailedJobFallsBackToAFreshUpload() async throws {
        let store = InMemoryBatchJobStore()
        store.save(record("old"), for: key)
        let fake = ResumeFakeService(newJobId: "new", status: ["old": .failed])

        _ = try await transcriber(fake).transcribe(
            audio: audio, resume: BatchResume(store: store, key: key))

        let starts = await fake.starts
        XCTAssertEqual(starts, 1)
        XCTAssertNil(store.job(for: key))
    }

    func testNetworkFailureOnResumeKeepsTheJob() async throws {
        let store = InMemoryBatchJobStore()
        store.save(record("old"), for: key)
        let fake = ResumeFakeService(newJobId: "new", status: ["old": .offline])

        do {
            _ = try await transcriber(fake).transcribe(
                audio: audio, resume: BatchResume(store: store, key: key))
            XCTFail("an offline poll must surface")
        } catch is URLError {}

        let starts = await fake.starts
        XCTAssertEqual(starts, 0, "no network is not a reason to pay for a second job")
        XCTAssertEqual(store.job(for: key)?.jobId, "old")
    }

    func testExpiredJobIsNotResumed() async throws {
        let store = InMemoryBatchJobStore()
        store.save(record("old", age: BatchJobRecord.maximumAge + 1), for: key)
        let fake = ResumeFakeService(newJobId: "new", status: [:])

        _ = try await transcriber(fake).transcribe(
            audio: audio, resume: BatchResume(store: store, key: key))

        let starts = await fake.starts
        let polled = await fake.polledIds
        XCTAssertEqual(starts, 1)
        XCTAssertFalse(polled.contains("old"))
    }

    func testChangedAudioIsNotResumed() async throws {
        let store = InMemoryBatchJobStore()
        store.save(record("old", bytes: audio.count + 1), for: key)
        let fake = ResumeFakeService(newJobId: "new", status: [:])

        _ = try await transcriber(fake).transcribe(
            audio: audio, resume: BatchResume(store: store, key: key))

        let starts = await fake.starts
        XCTAssertEqual(starts, 1)
    }

    func testWithoutAResumeNothingIsRemembered() async throws {
        let fake = ResumeFakeService(newJobId: "new", status: [:])
        _ = try await transcriber(fake).transcribe(audio: audio)
        let starts = await fake.starts
        XCTAssertEqual(starts, 1)
    }

    func testUserDefaultsStoreRoundTripsAndDropsExpiredEntries() throws {
        let suite = "BatchResumeTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let now = t0
        let store = UserDefaultsBatchJobStore(defaults: defaults, now: { now })

        store.save(record("stale", age: BatchJobRecord.maximumAge + 10), for: "a")
        store.save(record("fresh"), for: "b")

        let reopened = UserDefaultsBatchJobStore(defaults: defaults, now: { now })
        XCTAssertNil(reopened.job(for: "a"), "expired entries are pruned on write")
        XCTAssertEqual(reopened.job(for: "b")?.jobId, "fresh")
        reopened.clear("b")
        XCTAssertNil(store.job(for: "b"))
    }
}

/// A batch service whose jobs behave per id: `status[id]` says how polling a
/// given job goes; any id not listed completes on the first poll.
private actor ResumeFakeService: BatchTranscriptionService {
    enum Behaviour: Sendable {
        case stuck, notFound, failed, offline
    }

    private let newJobId: String
    private let status: [String: Behaviour]
    private var pollHook: (@Sendable (String) -> Void)?

    private(set) var starts = 0
    private(set) var polledIds: [String] = []
    private(set) var deleted: [String] = []

    init(newJobId: String, status: [String: Behaviour]) {
        self.newJobId = newJobId
        self.status = status
    }

    func onPoll(_ hook: @escaping @Sendable (String) -> Void) {
        pollHook = hook
    }

    func startBatchJob(
        audio: Data, diarization: Bool, languages: [String], terms: [String]
    ) async throws -> String {
        starts += 1
        return newJobId
    }

    func batchJobStatus(id: String) async throws -> BatchJobStatus {
        polledIds.append(id)
        pollHook?(id)
        switch status[id] {
        case .stuck: return BatchJobStatus(status: "processing")
        case .notFound: throw CloudError(status: 404, message: #"{"error":"not_found"}"#)
        case .failed: return BatchJobStatus(status: "error", errorMessage: "boom")
        case .offline: throw URLError(.notConnectedToInternet)
        case nil: return BatchJobStatus(status: "completed", durationMs: 1_000)
        }
    }

    func batchTranscript(id: String) async throws -> BatchTranscriptResponse {
        BatchTranscriptResponse(tokens: [BatchToken(text: "hi", startMs: 0, endMs: 500, speaker: 1)])
    }

    func deleteBatchJob(id: String) async {
        deleted.append(id)
    }
}
