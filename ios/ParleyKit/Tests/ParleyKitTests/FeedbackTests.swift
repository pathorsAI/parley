import XCTest

@testable import ParleyKit

// MARK: X-Parley-Client

final class ParleyClientIdentityTests: XCTestCase {
    /// The server's parser, copied from the contract (§1). If a value this
    /// type produces stops matching it, the server silently stores nothing.
    private let serverRule = try! NSRegularExpression(
        pattern: #"^(ios|android|macos|windows|linux)\/([^\s()]{1,32})(?:\s\((\d{1,10})\))?$"#)

    private func parses(_ value: String) -> Bool {
        serverRule.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
    }

    func testTheShippedShape() {
        XCTAssertEqual(
            ParleyClientIdentity.headerValue(platform: "ios", version: "1.22", build: "34"),
            "ios/1.22 (34)")
        XCTAssertTrue(parses("ios/1.22 (34)"))
    }

    func testANonNumericBuildIsLeftOffRatherThanSpoilingTheVersion() {
        let value = ParleyClientIdentity.headerValue(platform: "ios", version: "1.24", build: "41b")
        XCTAssertEqual(value, "ios/1.24")
        XCTAssertTrue(parses(value))
    }

    func testAMissingBuildIsLeftOff() {
        XCTAssertEqual(
            ParleyClientIdentity.headerValue(platform: "ios", version: "1.24", build: nil),
            "ios/1.24")
        XCTAssertEqual(
            ParleyClientIdentity.headerValue(platform: "ios", version: "1.24", build: ""),
            "ios/1.24")
    }

    func testVersionsTheServerRuleExcludesAreCleanedUntilTheyParse() {
        for version in ["1.24 beta", "1.24(rc)", String(repeating: "9", count: 40), "", " "] {
            let value = ParleyClientIdentity.headerValue(
                platform: "ios", version: version, build: "41")
            XCTAssertTrue(parses(value), "\(value) would be discarded by the server")
        }
    }

    func testAnOverlongBuildIsLeftOff() {
        let value = ParleyClientIdentity.headerValue(
            platform: "ios", version: "1.24", build: "12345678901")
        XCTAssertEqual(value, "ios/1.24")
    }

    func testEveryRequestThePackageStartsCarriesTheHeader() {
        let request = ParleyClientIdentity.request(url: URL(string: "https://api.parley.tw/me")!)
        XCTAssertEqual(
            request.value(forHTTPHeaderField: "X-Parley-Client"), ParleyClientIdentity.current)
        XCTAssertTrue(parses(ParleyClientIdentity.current))
    }
}

// MARK: scrubbing

final class DiagnosticsScrubberTests: XCTestCase {
    func testEmailsAreRemoved() {
        XCTAssertEqual(
            DiagnosticsScrubber.scrub("sign-in failed for jack.lin+test@pathors.com (401)"),
            "sign-in failed for <email> (401)")
    }

    func testBearerTokensAreRemoved() {
        XCTAssertEqual(
            DiagnosticsScrubber.scrub("Authorization: Bearer abc.DEF-123_456"),
            "Authorization: Bearer <token>")
    }

    func testQueryTokensAreRemoved() {
        XCTAssertEqual(
            DiagnosticsScrubber.scrub("parley://auth/cb?token=s3cr3t&x=1"),
            "parley://auth/cb?token=<redacted>&x=1")
    }

    func testJSONSecretsAreRemoved() {
        XCTAssertEqual(
            DiagnosticsScrubber.scrub(#"{"token": "abc", "ok": true}"#),
            #"{"token":"<redacted>", "ok": true}"#)
    }

    func testJWTsAreRemoved() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl"
        XCTAssertEqual(DiagnosticsScrubber.scrub("got \(jwt)"), "got <jwt>")
    }

    func testOpaqueSessionTokensAreRemoved() {
        let token = "Zx81kPq0aB7cD9eF2gH4iJ6kL8mN0oP2"
        XCTAssertEqual(DiagnosticsScrubber.scrub("session \(token) expired"), "session <redacted> expired")
    }

    /// Recording ids are what make a report actionable, and they are UUIDs.
    func testRecordingIdsSurvive() {
        let line = "upload 0b8f65b6-1c2d-4e5f-8a9b-0c1d2e3f4a5b failed: http_503"
        XCTAssertEqual(DiagnosticsScrubber.scrub(line), line)
    }

    func testCloseCodesSurvive() {
        let line = "relay closed: close code=1006 abnormal"
        XCTAssertEqual(DiagnosticsScrubber.scrub(line), line)
    }

    func testOnlyReportableCategoriesOfOurSubsystemReachTheLog() {
        let at = Date(timeIntervalSince1970: 1_759_030_000)
        let entries = [
            DiagnosticLogEntry(
                date: at, subsystem: "com.pathors.parley", category: "Sync", level: "error",
                message: "upload failed: http_503"),
            DiagnosticLogEntry(
                date: at, subsystem: "com.pathors.parley", category: "Transcript", level: "info",
                message: "我們下週三再開會"),
            DiagnosticLogEntry(
                date: at, subsystem: "com.apple.network", category: "Sync", level: "info",
                message: "someone else's line"),
            DiagnosticLogEntry(
                date: at.addingTimeInterval(1), subsystem: "com.pathors.parley",
                category: "Recording", level: "notice", message: "user a@b.co relay closed"),
        ]
        let log = DiagnosticLogFormatter.format(entries)
        XCTAssertTrue(log.contains("[Sync] upload failed: http_503"))
        XCTAssertTrue(log.contains("[Recording] user <email> relay closed"))
        XCTAssertFalse(log.contains("我們"), "an unlisted category leaked into the report")
        XCTAssertFalse(log.contains("someone else"))
        XCTAssertEqual(log.split(separator: "\n").count, 2)
    }

    func testTheLogKeepsTheNewestLinesWithinItsBudget() {
        let entries = (0..<1_000).map { i in
            DiagnosticLogEntry(
                date: Date(timeIntervalSince1970: Double(i)), subsystem: ParleyLog.subsystem,
                category: "Sync", level: "info", message: "line \(i) " + String(repeating: "ab ", count: 100))
        }
        let log = DiagnosticLogFormatter.format(entries)
        XCTAssertLessThanOrEqual(log.utf8.count, FeedbackDiagnostics.maxLogBytes)
        XCTAssertLessThanOrEqual(log.split(separator: "\n").count, DiagnosticLogFormatter.maxLines)
        XCTAssertTrue(log.hasSuffix(String(repeating: "ab ", count: 100)))
        XCTAssertTrue(log.contains("line 999 "))
        XCTAssertFalse(log.contains("line 0 "))
    }

    func testRecentErrorsAreScrubbedOnTheWayIn() {
        var errors = RecentErrorLog()
        errors.record(code: "http_401", message: "token=abc for me@x.io")
        XCTAssertEqual(errors.entries.last?.message, "token=<redacted> for <email>")
        for i in 0..<30 { errors.record(code: "e\(i)", message: "") }
        XCTAssertEqual(errors.entries.count, RecentErrorLog.capacity)
        XCTAssertEqual(errors.lastCode, "e29")
    }
}

// MARK: frequency limits

final class FeedbackPromptPolicyTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_759_000_000)
    private let day: TimeInterval = 86_400

    func testTwoDismissalsSilenceATriggerForThirtyDays() {
        var policy = FeedbackPromptPolicy()
        XCTAssertTrue(policy.mayOffer(.emptyTranscript, recordingId: "a", now: t0))
        policy.noteDismissed(.emptyTranscript, now: t0)
        XCTAssertTrue(policy.mayOffer(.emptyTranscript, recordingId: "b", now: t0))
        policy.noteDismissed(.emptyTranscript, now: t0)
        XCTAssertFalse(policy.mayOffer(.emptyTranscript, recordingId: "c", now: t0))
        XCTAssertFalse(
            policy.mayOffer(.emptyTranscript, recordingId: "c", now: t0.addingTimeInterval(29 * day)))
        XCTAssertTrue(
            policy.mayOffer(.emptyTranscript, recordingId: "c", now: t0.addingTimeInterval(30 * day)))
    }

    func testTheCountStartsOverOnceTheQuietEnds() {
        var policy = FeedbackPromptPolicy()
        policy.noteDismissed(.screenshot, now: t0)
        policy.noteDismissed(.screenshot, now: t0)
        let later = t0.addingTimeInterval(31 * day)
        policy.noteDismissed(.screenshot, now: later)
        XCTAssertTrue(policy.mayOffer(.screenshot, recordingId: nil, now: later))
        policy.noteDismissed(.screenshot, now: later)
        XCTAssertFalse(policy.mayOffer(.screenshot, recordingId: nil, now: later))
    }

    func testTriggersAreLimitedIndependently() {
        var policy = FeedbackPromptPolicy()
        policy.noteDismissed(.syncFailed, now: t0)
        policy.noteDismissed(.syncFailed, now: t0)
        XCTAssertFalse(policy.mayOffer(.syncFailed, recordingId: "a", now: t0))
        XCTAssertTrue(policy.mayOffer(.micRecovery, recordingId: "a", now: t0))
    }

    func testARecordingIsAskedAboutOncePerTrigger() {
        var policy = FeedbackPromptPolicy()
        policy.noteOffered(.truncatedTranscript, recordingId: "rec")
        XCTAssertFalse(policy.mayOffer(.truncatedTranscript, recordingId: "rec", now: t0))
        XCTAssertTrue(policy.mayOffer(.emptyTranscript, recordingId: "rec", now: t0))
        XCTAssertTrue(policy.mayOffer(.truncatedTranscript, recordingId: "other", now: t0))
    }

    func testCrashAndManualAreNeverLimited() {
        var policy = FeedbackPromptPolicy()
        for _ in 0..<5 {
            policy.noteDismissed(.crash, now: t0)
            policy.noteDismissed(.manual, now: t0)
            policy.noteOffered(.crash, recordingId: "r")
        }
        XCTAssertTrue(policy.mayOffer(.crash, recordingId: "r", now: t0))
        XCTAssertTrue(policy.mayOffer(.manual, recordingId: nil, now: t0))
    }

    func testTheRememberedPromptsAreBounded() {
        var policy = FeedbackPromptPolicy()
        for i in 0..<(FeedbackPromptPolicy.maxRememberedPrompts + 10) {
            policy.noteOffered(.emptyTranscript, recordingId: "r\(i)")
        }
        XCTAssertEqual(policy.prompted.count, FeedbackPromptPolicy.maxRememberedPrompts)
        XCTAssertTrue(policy.mayOffer(.emptyTranscript, recordingId: "r0", now: t0))
    }

    func testTheStorePersists() throws {
        let suite = "feedback-policy-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        FeedbackPromptStore(defaults: defaults).noteOffered(.syncFailed, recordingId: "x")
        XCTAssertFalse(FeedbackPromptStore(defaults: defaults).mayOffer(.syncFailed, recordingId: "x"))
    }
}

// MARK: trigger conditions

final class FeedbackConditionsTests: XCTestCase {
    private func seg(_ start: UInt64, _ end: UInt64, text: String = "hi", final: Bool = true, id: String? = nil)
        -> TranscriptSegment
    {
        TranscriptSegment(
            id: id ?? "mix-\(start)", source: "mix", speaker: 1, text: text, isFinal: final,
            startMs: start, endMs: end)
    }

    func testEmptyNeedsTwentySecondsAndNoTranscript() {
        XCTAssertTrue(FeedbackConditions.isEmptyTranscript(durationMs: 20_000, segments: []))
        XCTAssertFalse(FeedbackConditions.isEmptyTranscript(durationMs: 19_999, segments: []))
        XCTAssertFalse(
            FeedbackConditions.isEmptyTranscript(durationMs: 60_000, segments: [seg(0, 1_000)]))
    }

    func testTailsAndBlankSegmentsDoNotCountAsTranscript() {
        let segments = [
            seg(0, 5_000, final: false, id: "mix-tail"), seg(0, 1_000, text: "  "),
        ]
        XCTAssertTrue(FeedbackConditions.isEmptyTranscript(durationMs: 60_000, segments: segments))
    }

    func testTruncatedWhenTheWordsStopBeforeHalfway() {
        // 111 minutes of audio, words for the first 12 — the Android case.
        let duration: Double = 111 * 60_000
        let segments = [seg(0, 60_000), seg(60_000, 12 * 60_000)]
        XCTAssertEqual(
            FeedbackConditions.truncatedAt(durationMs: duration, segments: segments), 12 * 60_000)
    }

    func testNotTruncatedAtOrPastHalfway() {
        XCTAssertNil(
            FeedbackConditions.truncatedAt(durationMs: 600_000, segments: [seg(0, 300_000)]))
    }

    func testShortRecordingsAreNeverTruncated() {
        XCTAssertNil(
            FeedbackConditions.truncatedAt(durationMs: 179_999, segments: [seg(0, 1_000)]))
        XCTAssertNotNil(
            FeedbackConditions.truncatedAt(durationMs: 180_000, segments: [seg(0, 1_000)]))
    }

    func testAnEmptyTranscriptIsTheEmptyCaseNotTheTruncatedOne() {
        XCTAssertNil(FeedbackConditions.truncatedAt(durationMs: 600_000, segments: []))
        XCTAssertTrue(FeedbackConditions.isEmptyTranscript(durationMs: 600_000, segments: []))
    }

    func testTheLastEndIsTheLatestNotTheLastInOrder() {
        let segments = [seg(0, 400_000), seg(10_000, 20_000)]
        XCTAssertNil(FeedbackConditions.truncatedAt(durationMs: 600_000, segments: segments))
        XCTAssertEqual(FeedbackConditions.lastSegmentEndMs(segments), 400_000)
    }

    func testSyncIsStuckAfterThreeFailuresOrADay() {
        let now = Date()
        XCTAssertFalse(
            FeedbackConditions.isSyncStuck(consecutiveFailures: 2, queuedAt: now, now: now))
        XCTAssertTrue(
            FeedbackConditions.isSyncStuck(consecutiveFailures: 3, queuedAt: now, now: now))
        XCTAssertTrue(
            FeedbackConditions.isSyncStuck(
                consecutiveFailures: 0, queuedAt: now.addingTimeInterval(-86_400), now: now))
    }

    func testMicRecoveryThreshold() {
        XCTAssertFalse(FeedbackConditions.isMicRecoveryWorthAsking(4))
        XCTAssertTrue(FeedbackConditions.isMicRecoveryWorthAsking(5))
    }

    func testClock() {
        XCTAssertEqual(FeedbackConditions.clock(725_000), "12:05")
        XCTAssertEqual(FeedbackConditions.clock(3_725_000), "1:02:05")
    }

    func testErrorCodes() {
        XCTAssertEqual(FeedbackErrorCode.of(CloudError(status: 503, message: "x")), "http_503")
        XCTAssertEqual(
            FeedbackErrorCode.of(URLError(.notConnectedToInternet)), "urlerror_-1009")
        XCTAssertEqual(FeedbackErrorCode.of(CancellationError()), "cancelled")
    }
}

// MARK: payload, multipart, queue

final class FeedbackPayloadTests: XCTestCase {
    private func diagnostics(log: String? = nil, crash: JSONValue? = nil) -> FeedbackDiagnostics {
        FeedbackDiagnostics(
            app: .init(version: "1.24", build: "41"), os: .init(name: "iOS", version: "18.7"),
            device: .init(model: "iPhone15,2", locale: "zh-Hant-TW", timezone: "Asia/Taipei"),
            context: .init(recordingId: "r1", recordingDurationMs: 1_440_000, transcriptSegments: 0),
            log: log, crash: crash)
    }

    func testThePayloadMatchesTheContract() throws {
        let payload = FeedbackPayload(
            id: "11111111-2222-3333-4444-555555555555", trigger: .emptyTranscript,
            recordingId: "r1", message: "  ", tags: [], diagnostics: diagnostics())
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: payload.jsonData()) as? [String: Any])
        XCTAssertEqual(object["id"] as? String, "11111111-2222-3333-4444-555555555555")
        XCTAssertEqual(object["trigger"] as? String, "empty_transcript")
        XCTAssertEqual(object["recordingId"] as? String, "r1")
        XCTAssertNil(object["message"], "a blank message is omitted, not sent empty")
        XCTAssertNil(object["tags"])
        let diag = try XCTUnwrap(object["diagnostics"] as? [String: Any])
        XCTAssertEqual((diag["app"] as? [String: Any])?["build"] as? String, "41")
        let context = try XCTUnwrap(diag["context"] as? [String: Any])
        XCTAssertEqual(context["recordingDurationMs"] as? Int, 1_440_000)
        XCTAssertNil(context["audioRoute"], "unknown fields are omitted")
        XCTAssertNil(diag["crash"])
    }

    func testMessagesAndTagsAreCappedLikeTheServerCapsThem() {
        let payload = FeedbackPayload(
            trigger: .retranscribe, message: String(repeating: "字", count: 2_500),
            tags: (0..<12).map { "tag\($0)" } + [String(repeating: "t", count: 40)],
            diagnostics: diagnostics())
        XCTAssertEqual(payload.message?.count, FeedbackPayload.maxMessageLength)
        XCTAssertEqual(payload.tags?.count, FeedbackPayload.maxTags)
    }

    func testDiagnosticsNeverExceedTheServerLimit() throws {
        let hugeLog = (0..<5_000).map { "line \($0) " + String(repeating: "y", count: 60) }
            .joined(separator: "\n")
        let hugeCrash = JSONValue.object([
            "diagnosticMetaData": .object(["exceptionType": .number(1)]),
            "callStackTree": .object([
                "callStacks": .array(
                    (0..<4_000).map { i in
                        .object([
                            "threadAttributed": .bool(i == 7),
                            "frames": .string(String(repeating: "f", count: 40)),
                        ])
                    })
            ]),
        ])
        let payload = FeedbackPayload(
            trigger: .crash, diagnostics: diagnostics(log: hugeLog, crash: hugeCrash))
        let encoded = try FeedbackPayload.encoder.encode(payload.diagnostics)
        XCTAssertLessThanOrEqual(encoded.count, FeedbackDiagnostics.maxEncodedBytes)
        XCTAssertLessThanOrEqual(payload.diagnostics.log?.utf8.count ?? 0, FeedbackDiagnostics.maxLogBytes)
        XCTAssertTrue(payload.diagnostics.log?.hasSuffix("line 4999 " + String(repeating: "y", count: 60)) ?? false)
        let crashSize = try FeedbackPayload.encoder.encode(payload.diagnostics.crash).count
        XCTAssertLessThanOrEqual(crashSize, FeedbackDiagnostics.maxCrashBytes)
    }

    func testAnOversizedCrashKeepsTheCrashingThreadFirst() {
        let stacks: [JSONValue] = (0..<600).map { i in
            .object([
                "threadAttributed": .bool(i == 3),
                "frames": .string(String(repeating: "\(i % 10)", count: 100)),
            ])
        }
        let crash = JSONValue.object([
            "callStackTree": .object(["callStacks": .array(stacks)]),
            "diagnosticMetaData": .object(["signal": .number(11)]),
        ])
        let fitted = CrashDiagnosticJSON.fit(crash, limit: 48 * 1024)
        guard case .object(let object) = fitted,
            case .object(let tree)? = object["callStackTree"],
            case .array(let kept)? = tree["callStacks"]
        else { return XCTFail("structure lost: \(fitted)") }
        XCTAssertEqual(kept.count, 1)
        XCTAssertEqual(object["truncated"], .string("attributed_thread_only"))
        XCTAssertEqual(object["diagnosticMetaData"], .object(["signal": .number(11)]))
    }

    func testAnUnparseableCrashIsStillValidJSON() throws {
        let value = CrashDiagnosticJSON.decode(Data("{not json".utf8))
        let data = try FeedbackPayload.encoder.encode(value)
        XCTAssertNoThrow(try JSONSerialization.jsonObject(with: data))
    }

    func testTheMultipartBody() {
        let form = MultipartFormData.feedback(
            payload: Data(#"{"id":"x"}"#.utf8), screenshot: Data([0xFF, 0xD8, 0xFF]),
            boundary: "B")
        XCTAssertEqual(form.contentType, "multipart/form-data; boundary=B")
        var expected = Data()
        expected.append(
            Data(
                ("--B\r\nContent-Disposition: form-data; name=\"payload\"\r\n\r\n{\"id\":\"x\"}\r\n"
                    + "--B\r\nContent-Disposition: form-data; name=\"screenshot\"; filename=\"screenshot.jpg\"\r\n"
                    + "Content-Type: image/jpeg\r\n\r\n").utf8))
        expected.append(Data([0xFF, 0xD8, 0xFF]))
        expected.append(Data("\r\n--B--\r\n".utf8))
        XCTAssertEqual(form.body(), expected)
    }

    func testTheMultipartBodyWithoutAScreenshotHasOnlyThePayload() {
        let body = String(
            decoding: MultipartFormData.feedback(payload: Data("{}".utf8), screenshot: nil, boundary: "B").body(),
            as: UTF8.self)
        XCTAssertEqual(
            body, "--B\r\nContent-Disposition: form-data; name=\"payload\"\r\n\r\n{}\r\n--B--\r\n")
    }
}

final class FeedbackQueueTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("feedback-queue-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
    }

    private func payload(_ id: String, message: String = "") -> FeedbackPayload {
        FeedbackPayload(id: id, trigger: .manual, message: message, diagnostics: .init())
    }

    /// Sends recorded by a test, and a scripted answer per call.
    private actor Server {
        var received: [Data] = []
        var screenshots: [Data?] = []
        var answers: [Error?]
        init(answers: [Error?] = []) { self.answers = answers }
        func take(_ payload: Data, _ screenshot: Data?) throws {
            received.append(payload)
            screenshots.append(screenshot)
            if !answers.isEmpty, let error = answers.removeFirst() { throw error }
        }
    }

    func testEnqueuingTheSameIdTwiceKeepsOneReport() async throws {
        let queue = FeedbackQueue(directory: directory)
        try await queue.enqueue(payload("a", message: "first"), screenshot: Data([1]))
        try await queue.enqueue(payload("a", message: "second"), screenshot: nil)
        let items = await queue.items()
        XCTAssertEqual(items.count, 1)
        let sent = try JSONDecoder().decode(FeedbackPayload.self, from: items[0].payload)
        XCTAssertEqual(sent.message, "second")
        XCTAssertFalse(items[0].hasScreenshot)
    }

    func testADeliveredReportLeavesTheQueueAndCarriesItsScreenshot() async throws {
        let queue = FeedbackQueue(directory: directory)
        try await queue.enqueue(payload("a"), screenshot: Data([9, 9]))
        let server = Server()
        let result = await queue.drain { try await server.take($0, $1) }
        XCTAssertEqual(result.delivered, 1)
        XCTAssertEqual(result.remaining, 0)
        let screenshots = await server.screenshots
        XCTAssertEqual(screenshots, [Data([9, 9])])
    }

    func testATransportFailureKeepsTheReportAndStopsThePass() async throws {
        let queue = FeedbackQueue(directory: directory)
        try await queue.enqueue(payload("a"), screenshot: nil, now: Date(timeIntervalSince1970: 1))
        try await queue.enqueue(payload("b"), screenshot: nil, now: Date(timeIntervalSince1970: 2))
        let server = Server(answers: [URLError(.notConnectedToInternet)])
        let result = await queue.drain { try await server.take($0, $1) }
        XCTAssertEqual(result.delivered, 0)
        XCTAssertEqual(result.remaining, 2)
        XCTAssertEqual(result.stoppedOn, "urlerror_-1009")
        let received = await server.received
        XCTAssertEqual(received.count, 1, "the pass should stop at the first transport failure")
        let attempts = await queue.items().first { $0.id == "a" }?.attempts
        XCTAssertEqual(attempts, 1)
    }

    /// The retry after a lost response resends the same id, and nothing else.
    func testARetriedReportIsTheSameReport() async throws {
        let queue = FeedbackQueue(directory: directory)
        try await queue.enqueue(payload("a"), screenshot: nil)
        let server = Server(answers: [CloudError(status: 503, message: ""), nil])
        _ = await queue.drain { try await server.take($0, $1) }
        let result = await queue.drain { try await server.take($0, $1) }
        XCTAssertEqual(result.delivered, 1)
        let received = await server.received
        XCTAssertEqual(received.count, 2)
        XCTAssertEqual(received[0], received[1])
    }

    func testARefusedReportIsDroppedAndTheRestStillGo() async throws {
        let queue = FeedbackQueue(directory: directory)
        try await queue.enqueue(payload("a"), screenshot: nil, now: Date(timeIntervalSince1970: 1))
        try await queue.enqueue(payload("b"), screenshot: nil, now: Date(timeIntervalSince1970: 2))
        let server = Server(answers: [CloudError(status: 413, message: ""), nil])
        let result = await queue.drain { try await server.take($0, $1) }
        XCTAssertEqual(result.dropped, 1)
        XCTAssertEqual(result.delivered, 1)
        XCTAssertEqual(result.remaining, 0)
    }

    func testTheDailyLimitIsWaitedOutNotDropped() async throws {
        let queue = FeedbackQueue(directory: directory)
        try await queue.enqueue(payload("a"), screenshot: nil)
        let server = Server(answers: [CloudError(status: 429, message: "rate_limited")])
        let result = await queue.drain { try await server.take($0, $1) }
        XCTAssertEqual(result.remaining, 1)
        XCTAssertEqual(result.stoppedOn, "http_429")
    }

    /// A missing route is an endpoint not deployed yet, not a bad report.
    func testAMissingEndpointKeepsTheReport() async throws {
        let queue = FeedbackQueue(directory: directory)
        try await queue.enqueue(payload("a"), screenshot: nil)
        let server = Server(answers: [CloudError(status: 404, message: "Not Found")])
        let result = await queue.drain { try await server.take($0, $1) }
        XCTAssertEqual(result.remaining, 1)
        XCTAssertEqual(result.dropped, 0)
    }

    func testTheQueueKeepsTheNewestTwenty() async throws {
        let queue = FeedbackQueue(directory: directory)
        for i in 0..<25 {
            try await queue.enqueue(
                payload(String(format: "id-%02d", i)), screenshot: nil,
                now: Date(timeIntervalSince1970: Double(i)))
        }
        let ids = await queue.items().map(\.id)
        XCTAssertEqual(ids.count, FeedbackQueue.capacity)
        XCTAssertEqual(ids.first, "id-05")
        XCTAssertEqual(ids.last, "id-24")
    }
}
