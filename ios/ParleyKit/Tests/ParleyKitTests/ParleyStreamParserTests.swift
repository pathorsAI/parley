import XCTest

@testable import ParleyKit

/// Frame encoding and decoding for Parley's streaming protocol (v2), and the
/// mapping of server frames onto transcript segments.
final class ParleyStreamParserTests: XCTestCase {
    private var emitted: [TranscriptSegment] = []
    private var parser: ParleyStreamParser!

    override func setUp() {
        super.setUp()
        emitted = []
        parser = ParleyStreamParser(source: "mix") { self.emitted.append($0) }
    }

    private func json(_ frame: ParleyStreamProtocol.Start) throws -> [String: Any] {
        let text = try frame.encoded()
        return try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }

    // MARK: client → server

    func testStartFrameDeclaresTheAudioFormat() throws {
        let object = try json(ParleyStreamProtocol.Start())
        XCTAssertEqual(object["type"] as? String, "start")
        let audio = try XCTUnwrap(object["audio"] as? [String: Any])
        XCTAssertEqual(audio["encoding"] as? String, "pcm_s16le")
        XCTAssertEqual(audio["sample_rate"] as? Int, 16000)
        XCTAssertEqual(audio["channels"] as? Int, 1)
        XCTAssertEqual(object["diarization"] as? Bool, true)
        XCTAssertEqual(object["endpointing"] as? Bool, true)
    }

    func testStartFrameOmitsEmptyLanguagesAndHints() throws {
        let object = try json(
            ParleyStreamProtocol.Start(
                languages: [], hints: ParleyStreamProtocol.hints(for: ["  ", ""])))
        XCTAssertNil(object["languages"])
        XCTAssertNil(object["hints"])
    }

    func testStartFrameCarriesLanguagesAndTheVocabularyAsHintTerms() throws {
        let object = try json(
            ParleyStreamProtocol.Start(
                languages: ["zh", "en"], diarization: false, endpointing: false,
                hints: ParleyStreamProtocol.hints(for: [" Pathors ", "派斯", "Pathors"])))
        XCTAssertEqual(object["languages"] as? [String], ["zh", "en"])
        XCTAssertEqual(object["diarization"] as? Bool, false)
        XCTAssertEqual(object["endpointing"] as? Bool, false)
        let hints = try XCTUnwrap(object["hints"] as? [String: Any])
        XCTAssertEqual(hints["terms"] as? [String], ["Pathors", "派斯"])
    }

    func testStartFrameCarriesNoRecognizerSpecificFields() throws {
        let text = try ParleyStreamProtocol.Start(languages: ["zh"]).encoded()
        for field in ["api_key", "model", "language_hints", "context", "enable_"] {
            XCTAssertFalse(text.contains(field), "start frame leaked \(field)")
        }
    }

    func testControlFrames() throws {
        for (frame, type) in [
            (ParleyStreamProtocol.keepaliveFrame, "keepalive"),
            (ParleyStreamProtocol.finalizeFrame, "finalize"),
            (ParleyStreamProtocol.endFrame, "end"),
        ] {
            let object = try JSONSerialization.jsonObject(with: Data(frame.utf8)) as? [String: Any]
            XCTAssertEqual(object?["type"] as? String, type)
            XCTAssertEqual(object?.count, 1)
        }
    }

    func testPcmLittleEndianEncoding() {
        let data = ParleyStreamProtocol.pcmToLeBytes([0x0102, -2])
        XCTAssertEqual([UInt8](data), [0x02, 0x01, 0xFE, 0xFF])
    }

    func testTheVocabularyIsCleanedAndCappedLikeTheDesktops() {
        XCTAssertEqual(
            ParleyStreamProtocol.cleanVocabulary([" a ", "", "b", "a", "\n"]), ["a", "b"])
        let many = (0..<(ParleyStreamProtocol.vocabularyLimit + 20)).map { "t\($0)" }
        let cleaned = ParleyStreamProtocol.cleanVocabulary(many)
        XCTAssertEqual(cleaned.count, ParleyStreamProtocol.vocabularyLimit)
        XCTAssertEqual(cleaned.first, "t0", "the front of the list is the priority")
        XCTAssertNil(ParleyStreamProtocol.hints(for: []))
    }

    // MARK: server → client decoding

    func testDecodesEveryServerFrame() {
        typealias F = ParleyStreamProtocol.ServerFrame
        XCTAssertEqual(F.decode(#"{"type":"ready","session_id":"s1"}"#), .ready(sessionId: "s1"))
        XCTAssertEqual(F.decode(#"{"type":"endpoint"}"#), .endpoint)
        XCTAssertEqual(F.decode(#"{"type":"finalized"}"#), .finalized)
        XCTAssertEqual(F.decode(#"{"type":"done"}"#), .done)
        XCTAssertEqual(
            F.decode(#"{"type":"error","code":"idle_timeout","message":"Idle."}"#),
            .error(code: "idle_timeout", message: "Idle."))
        XCTAssertEqual(F.decode(#"{"type":"something_new","x":1}"#), .unknown("something_new"))
        XCTAssertNil(F.decode("not json at all"))
        XCTAssertNil(F.decode(#"{"tokens":[]}"#), "a frame without a type is not v2")
    }

    func testDecodesTokens() {
        let frame = ParleyStreamProtocol.ServerFrame.decode(
            """
            {"type":"transcript","tokens":[
              {"text":"你好","start_ms":0,"end_ms":320,"final":true,"speaker":1,"language":"zh","confidence":0.97},
              {"text":" there","start_ms":320,"end_ms":400,"final":false}
            ],"final_audio_ms":320,"total_audio_ms":400}
            """)
        XCTAssertEqual(
            frame,
            .transcript([
                .init(
                    text: "你好", startMs: 0, endMs: 320, isFinal: true, speaker: 1,
                    language: "zh", confidence: 0.97),
                .init(text: " there", startMs: 320, endMs: 400, isFinal: false),
            ]))
    }

    // MARK: mapping onto segments

    func testFinalAndTentativeTokensInOneFrame() throws {
        try parser.process(
            """
            {"type":"transcript","tokens":[
              {"text":"你好","start_ms":0,"end_ms":300,"final":true,"speaker":1},
              {"text":"，請","start_ms":300,"end_ms":500,"final":true,"speaker":1},
              {"text":"問","start_ms":500,"end_ms":600,"final":false,"speaker":1}
            ]}
            """)

        // Committed run + tentative tail.
        XCTAssertEqual(emitted.count, 2)
        XCTAssertEqual(emitted[0].id, "mix-0")
        XCTAssertEqual(emitted[0].text, "你好，請")
        XCTAssertTrue(emitted[0].isFinal)
        XCTAssertEqual(emitted[1].id, "mix-tail")
        XCTAssertEqual(emitted[1].text, "問")
        XCTAssertFalse(emitted[1].isFinal)
        XCTAssertEqual(emitted[1].speaker, 1)
    }

    func testEndpointClosesTheUtterance() throws {
        try parser.process(
            """
            {"type":"transcript","tokens":[{"text":"Deal.","start_ms":0,"end_ms":400,"final":true,"speaker":2}]}
            """)
        try parser.process(#"{"type":"endpoint"}"#)
        try parser.process(
            """
            {"type":"transcript","tokens":[{"text":"Next.","start_ms":900,"end_ms":1200,"final":true,"speaker":2}]}
            """)

        let finals = emitted.filter { $0.isFinal }
        XCTAssertEqual(finals[0].id, "mix-0")
        XCTAssertEqual(finals[0].text, "Deal.")
        // The endpoint commits under the same id, then the next run is fresh.
        XCTAssertEqual(finals.last?.id, "mix-1")
        XCTAssertEqual(finals.last?.text, "Next.")
    }

    func testFinalizedAlsoClosesTheUtterance() throws {
        try parser.process(
            #"{"type":"transcript","tokens":[{"text":"One","start_ms":0,"end_ms":200,"final":true}]}"#)
        try parser.process(#"{"type":"finalized"}"#)
        try parser.process(
            #"{"type":"transcript","tokens":[{"text":"Two","start_ms":300,"end_ms":500,"final":true}]}"#)
        XCTAssertEqual(emitted.filter(\.isFinal).last?.id, "mix-1")
    }

    func testMissingSpeakerParsesAsZero() throws {
        try parser.process(
            #"{"type":"transcript","tokens":[{"text":"hello","start_ms":0,"end_ms":200,"final":true}]}"#)
        XCTAssertEqual(emitted.first?.speaker, 0)
    }

    func testReadyAndDoneAreTracked() throws {
        XCTAssertFalse(parser.ready)
        try parser.process(#"{"type":"ready","session_id":"abc"}"#)
        XCTAssertTrue(parser.ready)
        XCTAssertFalse(parser.finished)
        try parser.process(#"{"type":"done"}"#)
        XCTAssertTrue(parser.finished)
        XCTAssertTrue(emitted.isEmpty, "control frames emit no segments")
    }

    func testErrorFrameThrows() {
        XCTAssertThrowsError(
            try parser.process(#"{"type":"error","code":"quota_exceeded","message":"Out of quota."}"#)
        ) { error in
            XCTAssertEqual(
                error as? ParleyStreamError,
                ParleyStreamError(code: "quota_exceeded", message: "Out of quota."))
        }
    }

    func testUnparseableAndUnknownFramesAreSkipped() throws {
        try parser.process("not json at all")
        try parser.process(#"{"type":"something_new"}"#)
        XCTAssertTrue(emitted.isEmpty)
    }

    func testEmptyTailClearsAfterFinalization() throws {
        try parser.process(
            #"{"type":"transcript","tokens":[{"text":"draft","start_ms":0,"end_ms":100,"final":false,"speaker":1}]}"#)
        try parser.process(
            #"{"type":"transcript","tokens":[{"text":"drafted","start_ms":0,"end_ms":150,"final":true,"speaker":1}]}"#)

        XCTAssertEqual(emitted[0].id, "mix-tail")
        XCTAssertEqual(emitted[0].text, "draft")
        let last = emitted.last!
        XCTAssertEqual(last.id, "mix-tail")
        XCTAssertEqual(last.text, "", "tail cleared once text finalized")
    }

    /// The order the server promises after `end`: the flushed tail as final
    /// tokens, `finalized`, then `done`.
    func testEndSequenceSettlesEverything() throws {
        try parser.process(
            #"{"type":"transcript","tokens":[{"text":"almost","start_ms":0,"end_ms":300,"final":false}]}"#)
        try parser.process(
            #"{"type":"transcript","tokens":[{"text":"almost done","start_ms":0,"end_ms":600,"final":true}]}"#)
        try parser.process(#"{"type":"finalized"}"#)
        try parser.process(#"{"type":"done"}"#)

        XCTAssertTrue(parser.finished)
        XCTAssertEqual(emitted.last(where: \.isFinal)?.text, "almost done")
        XCTAssertEqual(emitted.last(where: { !$0.isFinal })?.text, "")
    }

    func testReconnectedLegKeepsItsPrefixAndOffset() throws {
        let leg = ParleyStreamParser(source: "mix", idPrefix: "mix@2", timeOffsetMs: 5000) {
            self.emitted.append($0)
        }
        try leg.process(
            #"{"type":"transcript","tokens":[{"text":"hi","start_ms":100,"end_ms":200,"final":true}]}"#)
        XCTAssertEqual(emitted.first?.id, "mix@2-0")
        XCTAssertEqual(emitted.first?.startMs, 5100)
    }

    /// `tokens: []` is the server saying the tentative tail is gone.
    func testAnEmptyTranscriptClearsTheTail() throws {
        try parser.process(
            #"{"type":"transcript","tokens":[{"text":"maybe","start_ms":0,"end_ms":100,"final":false}]}"#)
        try parser.process(#"{"type":"transcript","tokens":[]}"#)
        XCTAssertEqual(emitted.last?.id, "mix-tail")
        XCTAssertEqual(emitted.last?.text, "")
    }

    /// `finalize` then `end` can answer `finalized` twice; the second is a no-op.
    func testARepeatedFinalizedIsHarmless() throws {
        try parser.process(
            #"{"type":"transcript","tokens":[{"text":"One","start_ms":0,"end_ms":200,"final":true}]}"#)
        try parser.process(#"{"type":"finalized"}"#)
        try parser.process(#"{"type":"finalized"}"#)
        try parser.process(
            #"{"type":"transcript","tokens":[{"text":"Two","start_ms":300,"end_ms":500,"final":true}]}"#)
        XCTAssertEqual(emitted.filter(\.isFinal).map(\.id), ["mix-0", "mix-0", "mix-1"])
    }
}
