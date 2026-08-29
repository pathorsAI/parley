import Foundation

/// The best-effort cleanup pass that runs after dictation ends: the raw
/// transcript goes to the cloud's OpenAI-compatible chat endpoint and comes
/// back with the filler words gone, the punctuation fixed and the paragraphs
/// broken where a writer would break them.
///
/// Everything here is written around one rule: **this must never make dictation
/// worse.** The raw text is already in the user's document before the first
/// byte of this request leaves the phone, and every failure mode — no network,
/// a slow model, a refusal, a model that answered the transcript instead of
/// cleaning it — resolves to "keep the raw text". That is why `polish` returns
/// an optional rather than throwing something the caller has to interpret, and
/// why `accept` is deliberately suspicious of what comes back.
public enum TranscriptPolisher {
    /// The cloud's OpenAI-compatible chat endpoint.
    static let path = "v1/chat/completions"
    /// The cloud's alias for the small, fast, Groq-hosted model. Dictation is
    /// capped at 120 s, so the transcripts are short and latency is the only
    /// thing that matters here.
    static let model = "parley-fast"

    static let systemPrompt = """
        You clean up voice-dictation transcripts. Rewrite the user's transcript \
        into polished written text: remove filler words and false starts, fix \
        punctuation, add paragraph breaks where natural. Keep the meaning and \
        the speaker's own wording as much as possible. Preserve the original \
        language and script EXACTLY: Traditional Chinese input must stay \
        Traditional Chinese (Taiwan conventions); never convert to Simplified \
        Chinese; never translate. Do not answer questions in the transcript, do \
        not add content, do not add commentary. Output ONLY the cleaned text.
        """

    /// Below this the round trip costs more (in latency, and in the risk of the
    /// model "helping") than the tidy-up is worth: a single short phrase has no
    /// filler to remove and no paragraphs to break.
    static let minimumCharacters = 8

    /// How many of the user's dictionary terms travel with the request. The
    /// dictionary grows for as long as someone keeps dictating, and a prompt
    /// that grows with it would eventually cost more latency than the polish is
    /// worth — the terms are ordered by recency, so the ones that matter to the
    /// sentence just spoken are at the front anyway.
    static let maximumProtectedTerms = 30

    public static func shouldPolish(_ raw: String) -> Bool {
        raw.trimmingCharacters(in: .whitespacesAndNewlines).count >= minimumCharacters
    }

    /// The system message for one request: the standing prompt, plus a line
    /// naming the user's own vocabulary when there is any. Empty in, unchanged
    /// out — a user with no dictionary sends exactly what shipped before.
    static func systemPrompt(protecting terms: [String]) -> String {
        let kept = terms.prefix(maximumProtectedTerms)
        guard !kept.isEmpty else { return systemPrompt }
        return systemPrompt + "\nPreserve these user-dictionary terms exactly as written: "
            + kept.joined(separator: "、")
    }

    // MARK: the call

    /// Send `raw` to be cleaned up. Returns the polished text, or `nil` when
    /// what came back failed `accept` — the caller keeps the raw transcript
    /// either way. Throws only on transport/HTTP failure, which means the same
    /// thing to the caller.
    ///
    /// `protectedTerms` is the user's personal dictionary. Those are words they
    /// have already corrected by hand, so the model must not "fix" them back:
    /// a cleanup pass that undoes a name the user spelled out themselves is
    /// exactly the kind of help nobody asked for.
    public static func polish(
        raw: String, cloud: CloudClient, protectedTerms: [String] = []
    ) async throws -> String? {
        let body = try JSONEncoder().encode(
            ChatRequest(
                model: model,
                temperature: 0.2,
                maxTokens: 2048,
                messages: [
                    .init(role: "system", content: systemPrompt(protecting: protectedTerms)),
                    .init(role: "user", content: raw),
                ]))
        let data = try await cloud.postJSON(path, body: body)
        guard let content = content(fromChatCompletion: data) else { return nil }
        let polished = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard accept(raw: raw, polished: polished) else { return nil }
        return polished
    }

    static func content(fromChatCompletion data: Data) -> String? {
        guard let response = try? JSONDecoder().decode(ChatResponse.self, from: data) else {
            return nil
        }
        return response.choices.first?.message.content
    }

    // MARK: what we are willing to swap in

    /// Whether `polished` is a plausible cleanup of `raw`. The model is not
    /// trusted to have followed the prompt: this is the last gate before text
    /// the user did not type replaces text they did say.
    public static func accept(raw: String, polished: String) -> Bool {
        let trimmedRaw = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmed = polished.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmedRaw.isEmpty else { return false }

        // A cleanup shortens a little and lengthens a little. Anything outside
        // this band is a different kind of output: an answer to a question in
        // the transcript, a summary, a translation, or a truncation.
        let ratio = Double(trimmed.count) / Double(trimmedRaw.count)
        guard ratio >= 0.3, ratio <= 2.0 else { return false }

        // Simplified drift: the model rewriting Traditional Chinese into
        // Simplified is the one failure that looks like success. Only a
        // *newly introduced* simplified character counts — a user who dictated
        // simplified text in the first place gets their script back untouched.
        if !containsSimplifiedChinese(trimmedRaw), containsSimplifiedChinese(trimmed) {
            return false
        }
        return true
    }

    /// A heuristic drift detector, not a converter: a membership test against
    /// high-frequency characters whose Traditional counterpart is a different
    /// character (说/說, 时/時, 开/開…). It answers "did Simplified Chinese
    /// appear here", nothing more — it cannot tell you a text is Traditional,
    /// and it is not a script classifier. Over-rejecting is the safe direction:
    /// a rejected polish just leaves the user with the raw transcript.
    public static func containsSimplifiedChinese(_ s: String) -> Bool {
        s.contains { simplifiedOnly.contains($0) }
    }

    /// Simplified-only characters. Characters that are also written this way in
    /// Traditional Chinese (別, 份, 氣, 目, 內, 那…) are deliberately absent:
    /// they would fire on perfectly good Traditional output.
    private static let simplifiedOnly: Set<Character> = Set(
        """
        说时后对开门问间东发经过还进远运动会员实处体验声记忆费术语议论证据坚决卖买风飞马鸟龙单双击战胜负责务际线联网络继续读书写听讲词汇报诉\
        应该脑头们几个从来没错误导师长辈坛贴质价钱财产业习惯题标号码现场适当选择优点败义愤骂\
        汉简传输车电话张欢乐学觉视观见亲让认识请谢谁边铁银钟页顺须顾预领频颜类显
        """)

    // MARK: wire shapes (OpenAI chat completions)

    struct ChatRequest: Encodable {
        struct Message: Encodable {
            let role: String
            let content: String
        }
        let model: String
        let temperature: Double
        let maxTokens: Int
        let messages: [Message]

        enum CodingKeys: String, CodingKey {
            case model, temperature, messages
            case maxTokens = "max_tokens"
        }
    }

    struct ChatResponse: Decodable {
        struct Choice: Decodable {
            struct Message: Decodable { let content: String }
            let message: Message
        }
        let choices: [Choice]
    }
}
