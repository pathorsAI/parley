import Foundation

/// The Soniox realtime wire protocol, as spoken through Parley's hosted STT
/// relay (`wss://api.parley.tw/stt/stream`). The relay is a byte-for-byte
/// passthrough of Soniox frames downstream, and injects the vendor key into
/// the first config frame upstream — so the client speaks plain Soniox minus
/// the `api_key` field. Mirrors `src-tauri/src/transcription/soniox.rs`.
public enum SonioxProtocol {
    /// Endpoint markers. `<end>` closes an utterance; `<fin>` is the final
    /// token emitted when the whole stream ends.
    public static let tokenEnd = "<end>"
    public static let tokenFin = "<fin>"

    /// Keepalive cadence — Soniox 408s an idle connection; the desktop sends
    /// this every 2 seconds and the relay passes it through.
    public static let keepaliveInterval: TimeInterval = 2
    public static let keepaliveFrame = #"{"type":"keepalive"}"#
    public static let finalizeFrame = #"{"type":"finalize"}"#

    /// Everything in the pipeline is 16 kHz mono s16le, matching the desktop's
    /// `TARGET_SAMPLE_RATE` and the relay's metering (32 000 bytes/second).
    public static let sampleRate: UInt32 = 16_000

    /// First frame on the socket. In relay mode `apiKey` stays nil — the relay
    /// injects the master key server-side and forces the model, so neither
    /// secret nor model choice rides in the client frame.
    ///
    /// **No recognition context here, deliberately.** Soniox's config frame
    /// takes a `context.terms` list to bias vocabulary, and the desktop fills it
    /// from the phrase dictionary (`src-tauri/src/transcription/soniox.rs`). The
    /// phone's personal dictionary has the terms ready
    /// (`LexiconStore.recognitionTerms`) and does not send them: whether the
    /// hosted relay forwards a `context` from an iOS client is not something
    /// this side can establish, and a config frame the relay rejects costs the
    /// user dictation altogether. Adding the field is the known follow-up —
    /// see `docs/design/ios-voice-keyboard.md`.
    public struct Config: Encodable {
        public var apiKey: String?
        public var model: String
        public var audioFormat = "pcm_s16le"
        public var sampleRate = SonioxProtocol.sampleRate
        public var numChannels: UInt32 = 1
        public var languageHints: [String]?
        public var enableEndpointDetection = true
        public var enableSpeakerDiarization = true

        public init(apiKey: String? = nil, model: String, languageHints: [String]? = nil) {
            self.apiKey = apiKey
            self.model = model
            self.languageHints = languageHints
        }

        enum CodingKeys: String, CodingKey {
            case apiKey = "api_key"
            case model
            case audioFormat = "audio_format"
            case sampleRate = "sample_rate"
            case numChannels = "num_channels"
            case languageHints = "language_hints"
            case enableEndpointDetection = "enable_endpoint_detection"
            case enableSpeakerDiarization = "enable_speaker_diarization"
        }
    }

    public struct Token: Decodable {
        public var text = ""
        public var isFinal = false
        public var startMs: UInt64 = 0
        public var endMs: UInt64 = 0
        /// Diarized speaker — Soniox sends this as a STRING (e.g. "1"), or
        /// omits it on control tokens like `<end>`.
        public var speaker = ""

        enum CodingKeys: String, CodingKey {
            case text
            case isFinal = "is_final"
            case startMs = "start_ms"
            case endMs = "end_ms"
            case speaker
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
            isFinal = try c.decodeIfPresent(Bool.self, forKey: .isFinal) ?? false
            startMs = try c.decodeIfPresent(UInt64.self, forKey: .startMs) ?? 0
            endMs = try c.decodeIfPresent(UInt64.self, forKey: .endMs) ?? 0
            speaker = try c.decodeIfPresent(String.self, forKey: .speaker) ?? ""
        }
    }

    public struct Response: Decodable {
        public var tokens: [Token] = []
        public var errorCode: Int?
        public var errorMessage: String?
        public var finished = false

        enum CodingKeys: String, CodingKey {
            case tokens
            case errorCode = "error_code"
            case errorMessage = "error_message"
            case finished
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            tokens = try c.decodeIfPresent([Token].self, forKey: .tokens) ?? []
            errorCode = try c.decodeIfPresent(Int.self, forKey: .errorCode)
            errorMessage = try c.decodeIfPresent(String.self, forKey: .errorMessage)
            finished = try c.decodeIfPresent(Bool.self, forKey: .finished) ?? false
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

/// In-band Soniox error frame (e.g. relay 402 surfaced mid-stream, rejected
/// session). The stream is dead from that point.
public struct SonioxStreamError: Error, Equatable {
    public let code: Int
    public let message: String
}

/// Parses the Soniox token stream into transcript segments via a
/// `SegmentBuilder` — the exact read-loop semantics of
/// `soniox.rs::run_session`, extracted so they are testable without a socket.
public final class SonioxStreamParser {
    private let builder: SegmentBuilder
    /// Set once a `finished` marker arrives — the stream ended normally.
    public private(set) var finished = false

    /// `idPrefix` and `timeOffsetMs` are forwarded to `SegmentBuilder` — see
    /// its initializer for why a reconnected relay leg needs both.
    public init(
        source: String = "mix", idPrefix: String? = nil, timeOffsetMs: UInt64 = 0,
        sink: @escaping (TranscriptSegment) -> Void
    ) {
        self.builder = SegmentBuilder(
            source: source, idPrefix: idPrefix, timeOffsetMs: timeOffsetMs, sink: sink)
    }

    /// Feed one raw text frame from the socket. Throws `SonioxStreamError` on
    /// an in-band error frame; unparseable frames are skipped (the desktop
    /// logs and continues).
    public func process(_ payload: String) throws {
        guard let data = payload.data(using: .utf8),
            let resp = try? JSONDecoder().decode(SonioxProtocol.Response.self, from: data)
        else { return }

        if let code = resp.errorCode {
            throw SonioxStreamError(code: code, message: resp.errorMessage ?? "")
        }

        var tail = ""
        var tailSpeaker = builder.currentSpeaker
        var tailStart = builder.currentEnd
        var endpoint = false

        for tok in resp.tokens {
            if tok.text == SonioxProtocol.tokenEnd || tok.text == SonioxProtocol.tokenFin {
                endpoint = true
                continue
            }
            let spk = Int(tok.speaker) ?? 0
            if tok.isFinal {
                builder.pushFinal(tok.text, speaker: spk, startMs: tok.startMs, endMs: tok.endMs)
            } else {
                if tail.isEmpty {
                    tailSpeaker = spk
                    tailStart = tok.startMs
                }
                tail += tok.text
            }
        }

        builder.emitCommitted()
        builder.emitTail(tail, speaker: tailSpeaker, startMs: tailStart)
        if endpoint {
            builder.endpoint()
        }
        if resp.finished {
            finished = true
        }
    }
}
