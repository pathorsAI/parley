import Foundation
import XCTest

@testable import ParleyKit

/// Semantics ported from `src-tauri/src/replay.rs` (`group_tokens` and
/// `parley_batch`). These tests are the contract: an imported file has to come
/// back split into the same speakers on the phone as it does on the Mac, so if
/// these diverge from the desktop's behaviour the two transcripts drift.
///
/// Everything here runs against a fake `BatchTranscriptionService` — this
/// package stubs no URLs anywhere, and the polling loop is the interesting part
/// regardless of what carries the bytes.
final class BatchTranscriptionTests: XCTestCase {

    // MARK: groupBatchTokens

    func testSpeakerChangeClosesTheRun() {
        let segments = groupBatchTokens(
            [
                tok("Hi there.", 1, 0, 500),
                tok("Hello!", 2, 600, 900),
            ], source: "mix")

        XCTAssertEqual(segments.count, 2)
        XCTAssertEqual(segments[0].id, "mix-0")
        XCTAssertEqual(segments[0].source, "mix")
        XCTAssertEqual(segments[0].speaker, 1)
        XCTAssertEqual(segments[0].text, "Hi there.")
        XCTAssertEqual(segments[0].startMs, 0)
        XCTAssertEqual(segments[0].endMs, 500)
        XCTAssertTrue(segments[0].isFinal)
        // The trailing run is emitted too, rather than being left open.
        XCTAssertEqual(segments[1].id, "mix-1")
        XCTAssertEqual(segments[1].speaker, 2)
        XCTAssertEqual(segments[1].text, "Hello!")
        XCTAssertEqual(segments[1].startMs, 600)
        XCTAssertEqual(segments[1].endMs, 900)
    }

    func testTextIsConcatenatedWithoutASeparator() {
        // The provider's tokens carry their own spacing; inserting any would
        // double the spaces it already sent.
        let segments = groupBatchTokens(
            [
                tok("Hello", 1, 0, 400),
                tok(" world", 1, 400, 800),
            ], source: "mix")

        XCTAssertEqual(segments.count, 1)
        XCTAssertEqual(segments[0].text, "Hello world")
        XCTAssertEqual(segments[0].endMs, 800)
    }

    func testControlTokensAreSkipped() {
        // `<fin>` here claims speaker 2. If it were not skipped outright it
        // would close the run and invent a second speaker.
        let segments = groupBatchTokens(
            [
                tok("Hello", 1, 0, 300),
                tok("<end>", nil, 300, 300),
                tok("<fin>", 2, 300, 300),
                tok(" world", 1, 300, 600),
            ], source: "mix")

        XCTAssertEqual(segments.count, 1)
        XCTAssertEqual(segments[0].speaker, 1)
        XCTAssertEqual(segments[0].text, "Hello world")
        XCTAssertEqual(segments[0].endMs, 600)
    }

    func testSpeakerlessTokenStaysInTheCurrentRun() {
        // Snapping a speakerless token to 0 would close speaker 1's run and
        // fragment one utterance into three segments.
        let segments = groupBatchTokens(
            [
                tok("Hello", 1, 0, 400),
                tok(" ", nil, 400, 410),
                tok("world", 1, 410, 800),
            ], source: "mix")

        XCTAssertEqual(segments.count, 1)
        XCTAssertEqual(segments[0].speaker, 1)
        XCTAssertEqual(segments[0].text, "Hello world")
    }

    func testSpeakerlessTokenBelongsToTheRunItArrivedIn() {
        // It joins the run that is open when it arrives, so the comma stays with
        // speaker 1 and the change to speaker 2 still splits.
        let segments = groupBatchTokens(
            [
                tok("A", 1, 0, 100),
                tok(",", nil, 100, 110),
                tok("B", 2, 200, 300),
            ], source: "mix")

        XCTAssertEqual(segments.count, 2)
        XCTAssertEqual(segments[0].text, "A,")
        XCTAssertEqual(segments[0].speaker, 1)
        XCTAssertEqual(segments[1].text, "B")
        XCTAssertEqual(segments[1].speaker, 2)
    }

    func testEntirelySpeakerlessStreamIsOneSegmentAtSpeakerZero() {
        // Non-diarizing output: nobody is identified, so it is all one speaker,
        // and the trailing emit clamps the -1 sentinel back to 0.
        let segments = groupBatchTokens(
            [
                tok("Hello", nil, 0, 300),
                tok(" there", nil, 300, 700),
            ], source: "mix")

        XCTAssertEqual(segments.count, 1)
        XCTAssertEqual(segments[0].id, "mix-0")
        XCTAssertEqual(segments[0].speaker, 0)
        XCTAssertEqual(segments[0].text, "Hello there")
        XCTAssertEqual(segments[0].startMs, 0)
        XCTAssertEqual(segments[0].endMs, 700)
    }

    func testWhitespaceRunIsDroppedAndDoesNotConsumeAnIndex() {
        // Speaker 2 says nothing but spaces. Dropping the run is not enough —
        // the segment index must not advance either, or the ids would gap and
        // the UI would upsert against slots that never arrive.
        let segments = groupBatchTokens(
            [
                tok("Hello", 1, 0, 500),
                tok("   ", 2, 500, 600),
                tok("Hi", 3, 600, 900),
            ], source: "mix")

        XCTAssertEqual(segments.count, 2)
        XCTAssertEqual(segments[0].id, "mix-0")
        XCTAssertEqual(segments[0].speaker, 1)
        XCTAssertEqual(segments[1].id, "mix-1")
        XCTAssertEqual(segments[1].speaker, 3)
        XCTAssertEqual(segments[1].text, "Hi")
    }

    func testTrailingWhitespaceOnlyRunIsNotEmitted() {
        let segments = groupBatchTokens(
            [
                tok("Hello", 1, 0, 500),
                tok("  ", 2, 500, 600),
            ], source: "mix")

        XCTAssertEqual(segments.count, 1)
        XCTAssertEqual(segments[0].text, "Hello")
    }

    func testEmptyInputProducesNoSegments() {
        XCTAssertTrue(groupBatchTokens([], source: "mix").isEmpty)
    }

    func testIdsCarryTheCallerSource() {
        let segments = groupBatchTokens([tok("x", 0, 0, 10)], source: "them")
        XCTAssertEqual(segments[0].id, "them-0")
        XCTAssertEqual(segments[0].source, "them")
    }

    // MARK: decoding

    func testTokenAcceptsSpeakerAsNumberStringOrAbsent() throws {
        // The vendor sends all three shapes; a strict decoder would decode none.
        let json = Data(
            """
            {"tokens":[
              {"text":"a","startMs":0,"endMs":100,"speaker":2},
              {"text":"b","startMs":100,"endMs":200,"speaker":"3"},
              {"text":"c","startMs":200,"endMs":300}
            ]}
            """.utf8)
        let decoded = try JSONDecoder().decode(BatchTranscriptResponse.self, from: json)

        XCTAssertEqual(decoded.tokens.count, 3)
        XCTAssertEqual(decoded.tokens.map(\.speaker), [2, 3, nil])
        XCTAssertEqual(decoded.tokens[1].text, "b")
        XCTAssertEqual(decoded.tokens[2].endMs, 300)
    }

    func testTranscriptWithoutTokensDecodesEmpty() throws {
        let decoded = try JSONDecoder().decode(
            BatchTranscriptResponse.self, from: Data("{}".utf8))
        XCTAssertTrue(decoded.tokens.isEmpty)
    }

    func testJobStatusDecodesWithoutTheOptionalHalves() throws {
        let job = try JSONDecoder().decode(
            BatchJobStatus.self, from: Data(#"{"status":"queued"}"#.utf8))
        XCTAssertEqual(job.status, "queued")
        XCTAssertNil(job.errorMessage)
        XCTAssertNil(job.durationMs)
    }

    // MARK: BatchTranscriber

    func testPollsThroughQueuedAndProcessingToCompleted() async throws {
        let fake = FakeBatchService(
            statuses: [
                BatchJobStatus(status: "queued"),
                BatchJobStatus(status: "processing"),
                BatchJobStatus(status: "completed", durationMs: 4_000),
            ],
            transcript: BatchTranscriptResponse(tokens: [tok("Hello", 1, 0, 900)]))
        let transcriber = BatchTranscriber(
            service: fake, pollInterval: .milliseconds(1), maxPolls: 10)

        let result = try await transcriber.transcribe(audio: Data([0x01, 0x02]))

        let polls = await fake.pollCount
        XCTAssertEqual(polls, 3)
        XCTAssertEqual(result.segments.count, 1)
        XCTAssertEqual(result.segments[0].text, "Hello")
        XCTAssertEqual(result.segments[0].id, "mix-0", "the phone records one mixed stream")
        XCTAssertEqual(result.durationMs, 4_000)
    }

    func testUnknownStatusKeepsPolling() async throws {
        // The cloud may grow a state we have never heard of; that has to read as
        // "still working", not as a failure.
        let fake = FakeBatchService(
            statuses: [
                BatchJobStatus(status: "some_future_state"),
                BatchJobStatus(status: "completed", durationMs: 1_000),
            ])
        let transcriber = BatchTranscriber(
            service: fake, pollInterval: .milliseconds(1), maxPolls: 10)

        let result = try await transcriber.transcribe(audio: Data())

        let polls = await fake.pollCount
        XCTAssertEqual(polls, 2)
        XCTAssertEqual(result.durationMs, 1_000)
    }

    func testUploadCarriesDiarizationAndHints() async throws {
        let fake = FakeBatchService(statuses: [BatchJobStatus(status: "completed", durationMs: 0)])
        let transcriber = BatchTranscriber(
            service: fake, pollInterval: .milliseconds(1), maxPolls: 4)

        _ = try await transcriber.transcribe(
            audio: Data(count: 7), diarization: false, languageHints: ["zh", "en"])

        let starts = await fake.starts
        XCTAssertEqual(starts.count, 1)
        XCTAssertEqual(starts[0].byteCount, 7)
        XCTAssertFalse(starts[0].diarization)
        XCTAssertEqual(starts[0].languageHints, ["zh", "en"])
    }

    func testJobErrorThrowsTheServersMessage() async throws {
        let fake = FakeBatchService(
            statuses: [BatchJobStatus(status: "error", errorMessage: "audio too short")])
        let transcriber = BatchTranscriber(
            service: fake, pollInterval: .milliseconds(1), maxPolls: 10)

        do {
            _ = try await transcriber.transcribe(audio: Data())
            XCTFail("a job that errored must not return a result")
        } catch let error as BatchTranscriptionError {
            XCTAssertEqual(error, .jobFailed("audio too short"))
        }

        let fetches = await fake.transcriptFetches
        XCTAssertEqual(fetches, 0, "a failed job has no transcript to fetch")
    }

    func testJobErrorWithoutAMessageStillThrows() async throws {
        let fake = FakeBatchService(statuses: [BatchJobStatus(status: "error")])
        let transcriber = BatchTranscriber(
            service: fake, pollInterval: .milliseconds(1), maxPolls: 10)

        do {
            _ = try await transcriber.transcribe(audio: Data())
            XCTFail("a job that errored must not return a result")
        } catch let error as BatchTranscriptionError {
            XCTAssertEqual(error, .jobFailed("unknown error"))
        }
    }

    func testTimesOutAfterMaxPolls() async throws {
        let fake = FakeBatchService(statuses: [BatchJobStatus(status: "processing")])
        let transcriber = BatchTranscriber(
            service: fake, pollInterval: .milliseconds(1), maxPolls: 4)

        do {
            _ = try await transcriber.transcribe(audio: Data())
            XCTFail("an unsettled job must time out rather than hang")
        } catch let error as BatchTranscriptionError {
            XCTAssertEqual(error, .timedOut)
        }

        let polls = await fake.pollCount
        XCTAssertEqual(polls, 4, "the cap is a count of polls, not of anything else")
    }

    func testSuccessDeletesTheJob() async throws {
        let fake = FakeBatchService(
            statuses: [BatchJobStatus(status: "completed", durationMs: 500)],
            transcript: BatchTranscriptResponse(tokens: [tok("ok", 0, 0, 400)]))
        let transcriber = BatchTranscriber(
            service: fake, pollInterval: .milliseconds(1), maxPolls: 4)

        _ = try await transcriber.transcribe(audio: Data())

        let deleted = await fake.deletedIDs
        XCTAssertEqual(deleted, ["job-1"], "the cloud must not be left holding the audio")
    }

    func testCleanupThatDoesNothingDoesNotFailTheTranscription() async throws {
        // `deleteBatchJob` swallows its own failures, so from here a cleanup that
        // silently did nothing is indistinguishable from one that threw — and
        // either way the transcript we already hold has to come back.
        let fake = FakeBatchService(
            statuses: [BatchJobStatus(status: "completed", durationMs: 500)],
            transcript: BatchTranscriptResponse(tokens: [tok("ok", 0, 0, 400)]),
            deletesSucceed: false)
        let transcriber = BatchTranscriber(
            service: fake, pollInterval: .milliseconds(1), maxPolls: 4)

        let result = try await transcriber.transcribe(audio: Data())

        XCTAssertEqual(result.segments.count, 1)
        XCTAssertEqual(result.segments[0].text, "ok")
        let deleted = await fake.deletedIDs
        XCTAssertTrue(deleted.isEmpty)
    }

    func testDurationPrefersTheTranscriptWhenItRunsLonger() async throws {
        let fake = FakeBatchService(
            statuses: [BatchJobStatus(status: "completed", durationMs: 2_000)],
            transcript: BatchTranscriptResponse(
                tokens: [tok("a", 1, 0, 1_000), tok("b", 1, 1_000, 9_000)]))
        let transcriber = BatchTranscriber(
            service: fake, pollInterval: .milliseconds(1), maxPolls: 4)

        let result = try await transcriber.transcribe(audio: Data())
        XCTAssertEqual(result.durationMs, 9_000)
    }

    func testDurationPrefersTheJobWhenItRunsLonger() async throws {
        // Trailing silence: the file is longer than the last word in it.
        let fake = FakeBatchService(
            statuses: [BatchJobStatus(status: "completed", durationMs: 12_000)],
            transcript: BatchTranscriptResponse(tokens: [tok("a", 1, 0, 3_000)]))
        let transcriber = BatchTranscriber(
            service: fake, pollInterval: .milliseconds(1), maxPolls: 4)

        let result = try await transcriber.transcribe(audio: Data())
        XCTAssertEqual(result.durationMs, 12_000)
    }

    func testDurationFallsBackToTheTranscriptWhenTheJobReportsNone() async throws {
        let fake = FakeBatchService(
            statuses: [BatchJobStatus(status: "completed")],
            transcript: BatchTranscriptResponse(tokens: [tok("a", 1, 0, 5_000)]))
        let transcriber = BatchTranscriber(
            service: fake, pollInterval: .milliseconds(1), maxPolls: 4)

        let result = try await transcriber.transcribe(audio: Data())
        XCTAssertEqual(result.durationMs, 5_000)
    }

    // MARK: user-facing errors

    func testEachFailureStatusNamesADifferentNextStep() {
        // These land in an alert, and the whole point of the mapping is that
        // "sign in", "you're out of quota" and "the file is too big" are three
        // different actions. Sharing wording would hide that.
        let statuses = [401, 402, 413, 429, 502]
        let messages = statuses.map { CloudError(status: $0, message: "").batchTranscriptionMessage }
        for message in messages { XCTAssertFalse(message.isEmpty) }
        XCTAssertEqual(Set(messages).count, statuses.count)
    }

    func testUnrecognizedStatusKeepsTheStatusAndTheCloudsErrorCode() {
        let withCode = CloudError(status: 500, message: #"{"error":"upstream_dead"}"#)
            .batchTranscriptionMessage
        XCTAssertTrue(withCode.contains("500"))
        XCTAssertTrue(withCode.contains("upstream_dead"))
    }

    func testUnrecognizedStatusSurvivesABodyThatIsNotJSON() {
        // An HTML error page or an empty body must still produce a message.
        let bare = CloudError(status: 503, message: "<html>nope</html>").batchTranscriptionMessage
        XCTAssertTrue(bare.contains("503"))
        XCTAssertFalse(bare.isEmpty)
    }
}

// MARK: helpers

private func tok(
    _ text: String, _ speaker: Int?, _ startMs: UInt64 = 0, _ endMs: UInt64 = 0
) -> BatchToken {
    BatchToken(text: text, startMs: startMs, endMs: endMs, speaker: speaker)
}

/// Stands in for `CloudClient`. `statuses` is walked one entry per poll and the
/// last entry repeats forever, so a single `processing` is an job that never
/// settles — which is what the timeout test needs.
private actor FakeBatchService: BatchTranscriptionService {
    struct StartRecord: Equatable, Sendable {
        let byteCount: Int
        let diarization: Bool
        let languageHints: [String]
    }

    private let statuses: [BatchJobStatus]
    private let transcript: BatchTranscriptResponse
    private let jobID: String
    private let deletesSucceed: Bool

    private(set) var starts: [StartRecord] = []
    private(set) var pollCount = 0
    private(set) var transcriptFetches = 0
    private(set) var deletedIDs: [String] = []
    private var cursor = 0

    init(
        statuses: [BatchJobStatus],
        transcript: BatchTranscriptResponse = BatchTranscriptResponse(tokens: []),
        jobID: String = "job-1",
        deletesSucceed: Bool = true
    ) {
        precondition(!statuses.isEmpty, "the fake needs at least one status to report")
        self.statuses = statuses
        self.transcript = transcript
        self.jobID = jobID
        self.deletesSucceed = deletesSucceed
    }

    func startBatchJob(audio: Data, diarization: Bool, languageHints: [String]) async throws
        -> String
    {
        starts.append(
            StartRecord(
                byteCount: audio.count, diarization: diarization, languageHints: languageHints))
        return jobID
    }

    func batchJobStatus(id: String) async throws -> BatchJobStatus {
        pollCount += 1
        let status = statuses[min(cursor, statuses.count - 1)]
        cursor += 1
        return status
    }

    func batchTranscript(id: String) async throws -> BatchTranscriptResponse {
        transcriptFetches += 1
        return transcript
    }

    func deleteBatchJob(id: String) async {
        // A cleanup that quietly does nothing — the caller cannot tell it apart
        // from one that failed, and must not care either way.
        guard deletesSucceed else { return }
        deletedIDs.append(id)
    }
}
