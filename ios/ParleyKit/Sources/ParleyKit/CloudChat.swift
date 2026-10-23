import Foundation

/// The OpenAI-compatible chat endpoint the cloud exposes, and the two wire
/// shapes every pass that talks to it needs.
///
/// This exists because there is now more than one such pass — the dictation
/// rewrite (`TranscriptPolisher`) and the filing pass (`FilingSuggester`) — and
/// two hand-copied `ChatRequest`s drift the moment one of them needs a new
/// field. The endpoint is one contract with the worker, so it is spelled out
/// once.
enum CloudChat {
    /// The cloud's OpenAI-compatible chat endpoint.
    static let path = "v1/chat/completions"

    /// One gate for the whole process: the provider's rate limit is per
    /// account, not per screen, so two passes from two different features
    /// count against the same budget.
    static let gate = ConcurrencyGate(limit: 2)

    static let retryPolicy = ChatRetryPolicy.standard

    /// The header the cloud attributes a call's credit usage by.
    static let featureHeader = "X-Parley-Feature"

    /// Which product feature a call bills to; the raw value is the header
    /// value. The desktop's `LlmFeature`.
    enum Feature: String {
        case voiceTyping = "voice_typing"
        case ask
        case meeting
        case report
    }

    struct Request: Encodable {
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

    struct Response: Decodable {
        struct Choice: Decodable {
            struct Message: Decodable { let content: String }
            let message: Message
        }
        let choices: [Choice]
    }

    /// The assistant's text, or `nil` when the response was unparsable or
    /// choiceless. Both callers treat those the same way they treat a network
    /// failure — keep what the user already has — so neither wants an error to
    /// interpret here.
    static func content(from data: Data) -> String? {
        guard let response = try? JSONDecoder().decode(Response.self, from: data) else {
            return nil
        }
        return response.choices.first?.message.content
    }
}
