import XCTest

@testable import ParleyKit

/// The gates around the cleanup pass. Every one of them exists to make the same
/// promise keepable: a polish that is not obviously a polish must be dropped,
/// because the raw transcript is already correct in the user's document.
final class TranscriptPolisherTests: XCTestCase {

    // MARK: shouldPolish

    func testShouldPolishSkipsShortPhrases() {
        XCTAssertFalse(TranscriptPolisher.shouldPolish(""))
        XCTAssertFalse(TranscriptPolisher.shouldPolish("thanks"))
        XCTAssertFalse(TranscriptPolisher.shouldPolish("   ok    "), "whitespace doesn't count")
    }

    func testShouldPolishAcceptsFromEightCharacters() {
        XCTAssertTrue(TranscriptPolisher.shouldPolish("12345678"))
        XCTAssertTrue(TranscriptPolisher.shouldPolish("um so I was thinking we could ship it"))
        XCTAssertTrue(TranscriptPolisher.shouldPolish("我們明天早上再確認一次"))
    }

    // MARK: accept

    func testAcceptsAPlausibleCleanup() {
        XCTAssertTrue(
            TranscriptPolisher.accept(
                raw: "um so I was thinking like we could maybe ship it tomorrow",
                polished: "I was thinking we could ship it tomorrow."))
    }

    func testRejectsEmptyPolish() {
        XCTAssertFalse(
            TranscriptPolisher.accept(raw: "um so I was thinking about it", polished: ""))
        XCTAssertFalse(
            TranscriptPolisher.accept(raw: "um so I was thinking about it", polished: "   \n "))
    }

    func testRejectsWhenTooMuchWasCutAway() {
        // The shape of a model that summarised instead of cleaning up.
        XCTAssertFalse(
            TranscriptPolisher.accept(
                raw: String(repeating: "the quick brown fox jumped over it. ", count: 4),
                polished: "A fox jumped."))
    }

    func testRejectsWhenTheModelAnsweredInsteadOfCleaning() {
        XCTAssertFalse(
            TranscriptPolisher.accept(
                raw: "what is the capital of France",
                polished:
                    "The capital of France is Paris, a city on the Seine in the north of the "
                    + "country, and it has been the seat of government since the tenth century."))
    }

    func testRejectsSimplifiedDrift() {
        XCTAssertFalse(
            TranscriptPolisher.accept(
                raw: "我們說好的時間到了", polished: "我们说好的时间到了。"),
            "Traditional in, Simplified out is the failure that looks like success")
    }

    func testSimplifiedInputKeepsItsOwnScript() {
        XCTAssertTrue(
            TranscriptPolisher.accept(
                raw: "我们说好的时间到了嗯就是这样",
                polished: "我们说好的时间到了，就是这样。"),
            "the guard is about drift, not about preferring one script")
    }

    func testEnglishIsUntouchedByTheScriptGuard() {
        XCTAssertTrue(
            TranscriptPolisher.accept(
                raw: "so uh we should probably call them back on monday",
                polished: "We should call them back on Monday."))
    }

    // MARK: containsSimplifiedChinese

    func testDetectsSimplifiedOnlyCharacters() {
        XCTAssertTrue(TranscriptPolisher.containsSimplifiedChinese("说"))
        XCTAssertTrue(TranscriptPolisher.containsSimplifiedChinese("对"))
        XCTAssertTrue(TranscriptPolisher.containsSimplifiedChinese("开"))
        XCTAssertTrue(TranscriptPolisher.containsSimplifiedChinese("先開門再说"))
    }

    func testTraditionalAndNonChineseAreNotFlagged() {
        XCTAssertFalse(TranscriptPolisher.containsSimplifiedChinese("說"))
        XCTAssertFalse(TranscriptPolisher.containsSimplifiedChinese("對"))
        XCTAssertFalse(TranscriptPolisher.containsSimplifiedChinese("開"))
        XCTAssertFalse(
            TranscriptPolisher.containsSimplifiedChinese("我們說好的時間到了，明天早上再確認。"))
        XCTAssertFalse(TranscriptPolisher.containsSimplifiedChinese("Nothing Chinese in here."))
        XCTAssertFalse(TranscriptPolisher.containsSimplifiedChinese("ありがとうございます"))
        XCTAssertFalse(TranscriptPolisher.containsSimplifiedChinese(""))
    }

    // MARK: wire shapes

    func testDecodesChatCompletionContent() {
        let json = Data(
            """
            {
              "id": "chatcmpl-1",
              "object": "chat.completion",
              "model": "parley-fast",
              "choices": [
                {
                  "index": 0,
                  "message": { "role": "assistant", "content": "We should ship it tomorrow." },
                  "finish_reason": "stop"
                }
              ],
              "usage": { "prompt_tokens": 90, "completion_tokens": 8, "total_tokens": 98 }
            }
            """.utf8)

        XCTAssertEqual(
            TranscriptPolisher.content(fromChatCompletion: json), "We should ship it tomorrow.")
    }

    func testChoicelessOrUnparsableResponseIsNil() {
        XCTAssertNil(TranscriptPolisher.content(fromChatCompletion: Data(#"{"choices":[]}"#.utf8)))
        XCTAssertNil(TranscriptPolisher.content(fromChatCompletion: Data("not json".utf8)))
    }

    func testRequestBodyUsesTheFastModelAndOpenAIKeys() throws {
        let body = try JSONEncoder().encode(
            TranscriptPolisher.ChatRequest(
                model: TranscriptPolisher.model, temperature: 0.2, maxTokens: 2048,
                messages: [
                    .init(role: "system", content: TranscriptPolisher.systemPrompt),
                    .init(role: "user", content: "hello there"),
                ]))
        let obj = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: body) as? [String: Any])

        XCTAssertEqual(obj["model"] as? String, "parley-fast")
        XCTAssertEqual(obj["max_tokens"] as? Int, 2048, "snake_case, as the OpenAI shape wants")
        let messages = try XCTUnwrap(obj["messages"] as? [[String: String]])
        XCTAssertEqual(messages.count, 2)
        XCTAssertEqual(messages[0]["role"], "system")
        XCTAssertEqual(messages[1]["content"], "hello there")
    }

    // MARK: the personal dictionary rides along

    func testNoTermsLeavesTheStandingPromptAlone() {
        XCTAssertEqual(
            TranscriptPolisher.systemPrompt(protecting: []), TranscriptPolisher.systemPrompt)
    }

    func testTermsAreNamedInTheSystemPrompt() {
        let prompt = TranscriptPolisher.systemPrompt(protecting: ["Cerana", "派斯科技"])
        XCTAssertTrue(prompt.hasPrefix(TranscriptPolisher.systemPrompt), "the standing rules stay")
        XCTAssertTrue(prompt.contains("Cerana、派斯科技"))
    }

    func testOnlyTheFirstThirtyTermsTravel() {
        let terms = (1...40).map { "term\($0)" }
        let prompt = TranscriptPolisher.systemPrompt(protecting: terms)
        XCTAssertTrue(prompt.contains("term30"))
        XCTAssertFalse(prompt.contains("term31"), "the dictionary grows; the prompt must not")
    }
}
