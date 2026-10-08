import Foundation

/// Parley's own streaming transcription protocol (v2), spoken with the hosted
/// service at `wss://api.parley.tw/stt/v2/stream`.
///
/// The protocol belongs to Parley, not to whichever recognizer runs behind the
/// service: the client sends a `start` frame, raw PCM, `keepalive`,
/// `finalize` and `end`; the server answers with `ready`, `transcript`,
/// `endpoint`, `finalized`, `done` and `error`. Nothing on this wire depends on
/// the recognizer, so it can change server-side without a client release.
public enum ParleyStreamProtocol {
    /// Keepalive cadence. The server closes a session that sees neither audio
    /// nor a keepalive for its idle window (`idle_timeout`); every two seconds
    /// is well inside it and matches the desktop.
    public static let keepaliveInterval: TimeInterval = 2
    public static let keepaliveFrame = #"{"type":"keepalive"}"#
    /// Finalize everything received so far; the server answers `finalized` and
    /// the session stays open for more audio.
    public static let finalizeFrame = #"{"type":"finalize"}"#
    /// No more audio. The server finalizes, flushes the tail, sends `done` and
    /// closes 1000 — so a client sends this and keeps reading.
    public static let endFrame = #"{"type":"end"}"#

    /// Everything in the pipeline is 16 kHz mono s16le, matching the desktop's
    /// `TARGET_SAMPLE_RATE` and the service's metering (32 000 bytes/second).
    /// It is also the only audio format the service accepts today.
    public static let sampleRate: UInt32 = 16_000

    /// How many terms ride in `hints.terms` — the desktop's
    /// `VOCABULARY_LIMIT` (`src/lib/dictionary/index.ts`). Past a couple
    /// hundred terms the hint stops helping and starts costing latency; the
    /// callers order their terms by priority, so the cut keeps the ones that
    /// matter.
    public static let vocabularyLimit = 200

    /// Normalize a vocabulary before it goes on the wire: trim each term, drop
    /// the empties, de-duplicate preserving order, and cap at
    /// `vocabularyLimit`. The desktop's `clean_vocabulary`
    /// (`transcription/common.rs`) plus the cap its `vocabularyTerms()` applies
    /// before the list reaches Rust.
    public static func cleanVocabulary(_ vocabulary: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for raw in vocabulary {
            let term = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !term.isEmpty, seen.insert(term).inserted else { continue }
            out.append(term)
            if out.count == vocabularyLimit { break }
        }
        return out
    }

    /// Recognition hints: the domain terms to bias toward.
    public struct Hints: Encodable, Equatable, Sendable {
        public var terms: [String]

        public init(terms: [String]) {
            self.terms = terms
        }
    }

    /// The `hints` field for a vocabulary — `nil` when there is nothing to
    /// bias toward, so the field is left out of the frame altogether.
    public static func hints(for vocabulary: [String]) -> Hints? {
        let terms = cleanVocabulary(vocabulary)
        return terms.isEmpty ? nil : Hints(terms: terms)
    }

    /// The declared audio format. Only `pcm_s16le` / 16 000 / 1 is supported.
    public struct Audio: Encodable, Equatable, Sendable {
        public var encoding = "pcm_s16le"
        public var sampleRate = ParleyStreamProtocol.sampleRate
        public var channels: UInt32 = 1

        public init() {}

        enum CodingKeys: String, CodingKey {
            case encoding
            case sampleRate = "sample_rate"
            case channels
        }
    }

    /// First frame on the socket, required before any audio.
    ///
    /// **`hints` carries the personal dictionary**: the user's own words
    /// (`LexiconStore.recognitionTerms` — never contact names), cleaned and
    /// capped by `hints(for:)`, and omitted entirely when there are none.
    /// `languages` is omitted when empty so the service auto-detects.
    public struct Start: Encodable, Equatable, Sendable {
        public let type = "start"
        public var audio = Audio()
        public var languages: [String]?
        public var diarization: Bool
        public var endpointing: Bool
        /// `nil` is left out of the frame (synthesised `Encodable` skips a
        /// `nil` optional).
        public var hints: Hints?

        public init(
            languages: [String]? = nil, diarization: Bool = true, endpointing: Bool = true,
            hints: Hints? = nil
        ) {
            self.languages = (languages?.isEmpty ?? true) ? nil : languages
            self.diarization = diarization
            self.endpointing = endpointing
            self.hints = hints
        }

        enum CodingKeys: String, CodingKey {
            case type, audio, languages, diarization, endpointing, hints
        }

        /// The frame as the text the socket sends.
        public func encoded() throws -> String {
            String(decoding: try JSONEncoder().encode(self), as: UTF8.self)
        }
    }

    /// One recognized token. `final` tokens are appended once and never
    /// repeated; non-final tokens are the current tentative tail and are
    /// replaced by the next `transcript` frame.
    public struct Token: Decodable, Equatable, Sendable {
        public var text = ""
        public var startMs: UInt64 = 0
        public var endMs: UInt64 = 0
        public var isFinal = false
        /// Diarized speaker (1, 2, …), present only with diarization. Absent
        /// reads as 0 — the "nobody in particular" speaker `SegmentBuilder`
        /// never splits on.
        public var speaker = 0
        public var language: String?
        public var confidence: Double?

        enum CodingKeys: String, CodingKey {
            case text
            case startMs = "start_ms"
            case endMs = "end_ms"
            case isFinal = "final"
            case speaker, language, confidence
        }

        public init(
            text: String, startMs: UInt64 = 0, endMs: UInt64 = 0, isFinal: Bool,
            speaker: Int = 0, language: String? = nil, confidence: Double? = nil
        ) {
            self.text = text
            self.startMs = startMs
            self.endMs = endMs
            self.isFinal = isFinal
            self.speaker = speaker
            self.language = language
            self.confidence = confidence
        }

        /// Permissive on purpose: one odd field must not cost the whole frame
        /// its words.
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            text = (try? c.decodeIfPresent(String.self, forKey: .text)) ?? ""
            startMs = Self.millis(c, .startMs)
            endMs = Self.millis(c, .endMs)
            isFinal = (try? c.decodeIfPresent(Bool.self, forKey: .isFinal)) ?? false
            if let n = try? c.decode(Int.self, forKey: .speaker) {
                speaker = n
            } else if let s = try? c.decode(String.self, forKey: .speaker) {
                speaker = Int(s.trimmingCharacters(in: .whitespaces)) ?? 0
            }
            language = try? c.decodeIfPresent(String.self, forKey: .language)
            confidence = try? c.decodeIfPresent(Double.self, forKey: .confidence)
        }

        private static func millis(
            _ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys
        ) -> UInt64 {
            if let n = try? c.decode(UInt64.self, forKey: key) { return n }
            if let d = try? c.decode(Double.self, forKey: key), d.isFinite, d >= 0 {
                return UInt64(d)
            }
            return 0
        }
    }

    /// Every frame the server sends, decoded once by its `type`. Frames of a
    /// type this client does not know are `.unknown` and ignored, so the
    /// server can add one without breaking an installed app.
    public enum ServerFrame: Equatable, Sendable {
        case ready(sessionId: String?)
        case transcript([Token])
        case endpoint
        case finalized
        case done
        case error(code: String, message: String)
        case unknown(String)

        private struct Wire: Decodable {
            var type: String?
            var sessionId: String?
            var tokens: [Token]?
            var code: String?
            var message: String?

            enum CodingKeys: String, CodingKey {
                case type
                case sessionId = "session_id"
                case tokens, code, message
            }
        }

        /// `nil` for anything that is not a JSON object with a `type`.
        public static func decode(_ payload: String) -> ServerFrame? {
            guard let data = payload.data(using: .utf8),
                let wire = try? JSONDecoder().decode(Wire.self, from: data),
                let type = wire.type
            else { return nil }
            switch type {
            case "ready": return .ready(sessionId: wire.sessionId)
            case "transcript": return .transcript(wire.tokens ?? [])
            case "endpoint": return .endpoint
            case "finalized": return .finalized
            case "done": return .done
            case "error": return .error(code: wire.code ?? "internal", message: wire.message ?? "")
            default: return .unknown(type)
            }
        }
    }

    /// Error codes the server sends in an `error` frame.
    public enum ErrorCode {
        public static let badRequest = "bad_request"
        public static let quotaExceeded = "quota_exceeded"
        public static let idleTimeout = "idle_timeout"
        public static let upstreamUnavailable = "upstream_unavailable"
        public static let internalError = "internal"
    }

    /// The error code a close implies when the server closed without (or
    /// before this client read) an `error` frame. `nil` for closes that are
    /// not errors of the protocol's own (1000, 1006, …) — 1011 included, since
    /// it does not say which of two codes it was.
    public static func errorCode(forClose code: Int) -> String? {
        switch code {
        case 4400: return ErrorCode.badRequest
        case 4402: return ErrorCode.quotaExceeded
        case 4408: return ErrorCode.idleTimeout
        default: return nil
        }
    }

    /// Encode 16-bit PCM samples as little-endian bytes for a binary WS frame,
    /// matching `pcm_to_le_bytes` in the desktop's `audio/resample.rs`.
    public static func pcmToLeBytes(_ samples: [Int16]) -> Data {
        var data = Data(capacity: samples.count * 2)
        for s in samples {
            withUnsafeBytes(of: s.littleEndian) { data.append(contentsOf: $0) }
        }
        return data
    }
}

/// An `error` frame from the service. The stream is dead from that point.
public struct ParleyStreamError: Error, Equatable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

/// Turns the server's frames into transcript segments via a `SegmentBuilder` —
/// the read-loop semantics of the desktop's streaming session, extracted so
/// they are testable without a socket.
///
/// - `transcript`: final tokens are pushed into the open run, which is emitted
///   as committed text; the non-final tokens become the tentative tail (an
///   empty tail clears the previous one).
/// - `endpoint` and `finalized`: the utterance is over — the open run is
///   committed and the next final token opens a fresh one.
/// - `done`: the stream is complete (`finished`).
/// - `ready`: the session is up (`ready`).
/// - `error`: thrown as `ParleyStreamError`.
public final class ParleyStreamParser {
    private let builder: SegmentBuilder
    /// Set once `ready` arrives — the server accepted the start frame and the
    /// recognizer behind it is open.
    public private(set) var ready = false
    /// Set once `done` arrives — the stream ended normally.
    public private(set) var finished = false

    /// `idPrefix` and `timeOffsetMs` are forwarded to `SegmentBuilder` — see
    /// its initializer for why a reconnected leg needs both.
    public init(
        source: String = "mix", idPrefix: String? = nil, timeOffsetMs: UInt64 = 0,
        sink: @escaping (TranscriptSegment) -> Void
    ) {
        self.builder = SegmentBuilder(
            source: source, idPrefix: idPrefix, timeOffsetMs: timeOffsetMs, sink: sink)
    }

    /// Feed one raw text frame from the socket. Throws `ParleyStreamError` on
    /// an `error` frame; unparseable and unknown frames are skipped.
    public func process(_ payload: String) throws {
        guard let frame = ParleyStreamProtocol.ServerFrame.decode(payload) else { return }
        try process(frame)
    }

    public func process(_ frame: ParleyStreamProtocol.ServerFrame) throws {
        switch frame {
        case .ready:
            ready = true
        case .transcript(let tokens):
            apply(tokens)
        case .endpoint, .finalized:
            builder.endpoint()
        case .done:
            finished = true
        case .error(let code, let message):
            throw ParleyStreamError(code: code, message: message)
        case .unknown:
            break
        }
    }

    private func apply(_ tokens: [ParleyStreamProtocol.Token]) {
        var tail = ""
        var tailSpeaker = builder.currentSpeaker
        var tailStart = builder.currentEnd

        for tok in tokens {
            if tok.isFinal {
                builder.pushFinal(tok.text, speaker: tok.speaker, startMs: tok.startMs, endMs: tok.endMs)
            } else {
                if tail.isEmpty {
                    tailSpeaker = tok.speaker
                    tailStart = tok.startMs
                }
                tail += tok.text
            }
        }

        builder.emitCommitted()
        builder.emitTail(tail, speaker: tailSpeaker, startMs: tailStart)
    }
}
