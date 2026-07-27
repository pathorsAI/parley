import XCTest

@testable import ParleyKit

/// Read-loop semantics from `soniox.rs::run_session`, driven with realistic
/// Soniox relay frames (the relay is a byte-for-byte passthrough downstream).
final class SonioxStreamParserTests: XCTestCase {
    private var emitted: [TranscriptSegment] = []
    private var parser: SonioxStreamParser!

    override func setUp() {
        super.setUp()
        emitted = []
        parser = SonioxStreamParser(source: "mix") { self.emitted.append($0) }
    }

    func testFinalAndInterimTokensInOneFrame() throws {
        try parser.process(
            """
            {"tokens":[
              {"text":"你好","is_final":true,"start_ms":0,"end_ms":300,"speaker":"1"},
              {"text":"，請","is_final":true,"start_ms":300,"end_ms":500,"speaker":"1"},
              {"text":"問","is_final":false,"start_ms":500,"end_ms":600,"speaker":"1"}
            ],"finished":false}
            """)

        // emit_committed (solid run) + emit_tail (interim)
        XCTAssertEqual(emitted.count, 2)
        XCTAssertEqual(emitted[0].id, "mix-0")
        XCTAssertEqual(emitted[0].text, "你好，請")
        XCTAssertTrue(emitted[0].isFinal)
        XCTAssertEqual(emitted[1].id, "mix-tail")
        XCTAssertEqual(emitted[1].text, "問")
        XCTAssertFalse(emitted[1].isFinal)
        XCTAssertEqual(emitted[1].speaker, 1)
    }

    func testEndTokenDrivesEndpoint() throws {
        try parser.process(
            """
            {"tokens":[
              {"text":"Deal.","is_final":true,"start_ms":0,"end_ms":400,"speaker":"2"},
              {"text":"<end>","is_final":true}
            ]}
            """)
        try parser.process(
            """
            {"tokens":[{"text":"Next.","is_final":true,"start_ms":900,"end_ms":1200,"speaker":"2"}]}
            """)

        // Frame 1: committed run (emit_committed), cleared tail, endpoint commit
        // reuses the same id (mix-0) — matching Rust where emit_committed and the
        // endpoint commit both fire at index 0, then the index advances.
        let finals = emitted.filter { $0.isFinal }
        XCTAssertEqual(finals[0].id, "mix-0")
        XCTAssertEqual(finals[0].text, "Deal.")
        // Frame 2 opens a fresh run under the advanced id.
        XCTAssertEqual(finals.last?.id, "mix-1")
        XCTAssertEqual(finals.last?.text, "Next.")
    }

    func testMissingSpeakerParsesAsZero() throws {
        try parser.process(
            """
            {"tokens":[{"text":"hello","is_final":true,"start_ms":0,"end_ms":200}]}
            """)
        XCTAssertEqual(emitted.first?.speaker, 0)
    }

    func testErrorFrameThrows() {
        XCTAssertThrowsError(
            try parser.process(#"{"error_code":402,"error_message":"quota_exhausted"}"#)
        ) { error in
            XCTAssertEqual(error as? SonioxStreamError, SonioxStreamError(code: 402, message: "quota_exhausted"))
        }
    }

    func testFinishedMarkerSetsFlag() throws {
        try parser.process(
            """
            {"tokens":[{"text":"<fin>","is_final":true}],"finished":true}
            """)
        XCTAssertTrue(parser.finished)
    }

    func testUnparseableFrameIsSkipped() throws {
        try parser.process("not json at all")
        XCTAssertTrue(emitted.isEmpty)
    }

    func testEmptyTailClearsAfterFinalization() throws {
        try parser.process(
            """
            {"tokens":[{"text":"draft","is_final":false,"start_ms":0,"end_ms":100,"speaker":"1"}]}
            """)
        try parser.process(
            """
            {"tokens":[{"text":"drafted","is_final":true,"start_ms":0,"end_ms":150,"speaker":"1"}]}
            """)

        // Frame 1: tail only. Frame 2: solid run + empty tail (clears the row).
        XCTAssertEqual(emitted[0].id, "mix-tail")
        XCTAssertEqual(emitted[0].text, "draft")
        let last = emitted.last!
        XCTAssertEqual(last.id, "mix-tail")
        XCTAssertEqual(last.text, "", "tail cleared once text finalized")
    }

    func testPcmLittleEndianEncoding() {
        let data = SonioxProtocol.pcmToLeBytes([0x0102, -2])
        XCTAssertEqual([UInt8](data), [0x02, 0x01, 0xFE, 0xFF])
    }

    func testConfigFrameOmitsApiKeyInRelayMode() throws {
        let config = SonioxProtocol.Config(apiKey: nil, model: "stt-rt-v5", languageHints: ["zh", "en"])
        let json = String(data: try JSONEncoder().encode(config), encoding: .utf8)!
        XCTAssertFalse(json.contains("api_key"), "relay mode must not send a vendor key field")
        XCTAssertTrue(json.contains(#""audio_format":"pcm_s16le""#))
        XCTAssertTrue(json.contains(#""sample_rate":16000"#))
        XCTAssertTrue(json.contains(#""enable_speaker_diarization":true"#))
    }
}
