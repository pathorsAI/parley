import Foundation

/// Hosted batch transcription through Parley Cloud (`POST /stt/batch`).
///
/// The desktop already walks this endpoint in `src-tauri/src/replay.rs`
/// (`parley_batch`); this is the same four steps in Swift — upload, poll, fetch,
/// delete — so an imported file transcribes identically on the phone and on the
/// Mac. Where the two could drift the Rust is the reference: the token grouping
/// below is a line-for-line port of `group_tokens`, and the poll cadence and cap
/// are the same numbers.

// MARK: wire shapes

/// One token from the cloud transcript. The shapes are permissive on purpose:
/// the upstream vendor omits `speaker` on control and spacing tokens, and sends
/// it as a string in some responses and a number in others (see `SpeakerId` in
/// `replay.rs`), so a token that decodes strictly would decode nothing at all.
public struct BatchToken: Decodable, Equatable, Sendable {
    public let text: String
    public let startMs: UInt64
    public let endMs: UInt64
    /// `nil` means the token carried no speaker — which is not the same as
    /// speaker 0. `groupBatchTokens` keeps such tokens in the current run.
    public let speaker: Int?

    public init(text: String, startMs: UInt64, endMs: UInt64, speaker: Int?) {
        self.text = text
        self.startMs = startMs
        self.endMs = endMs
        self.speaker = speaker
    }

    enum CodingKeys: String, CodingKey {
        case text, startMs, endMs, speaker
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        startMs = try c.decodeIfPresent(UInt64.self, forKey: .startMs) ?? 0
        endMs = try c.decodeIfPresent(UInt64.self, forKey: .endMs) ?? 0
        // `decode` rather than `decodeIfPresent`: an absent key and a key of the
        // wrong type both need to fall through, and only the last fall-through
        // means "no speaker".
        if let n = try? c.decode(Int.self, forKey: .speaker) {
            speaker = n
        } else if let s = try? c.decode(String.self, forKey: .speaker) {
            // A string speaker that isn't a number is treated as 0, matching the
            // Rust's `parse().unwrap_or(0)` — an unparseable label still means
            // "somebody spoke", so dropping the token would lose words.
            speaker = Int(s.trimmingCharacters(in: .whitespaces)) ?? 0
        } else {
            speaker = nil
        }
    }
}

public struct BatchTranscriptResponse: Decodable, Sendable {
    public let tokens: [BatchToken]

    public init(tokens: [BatchToken]) { self.tokens = tokens }

    enum CodingKeys: String, CodingKey { case tokens }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tokens = try c.decodeIfPresent([BatchToken].self, forKey: .tokens) ?? []
    }
}

/// A job's state as the cloud reports it. `status` is left as the raw string
/// rather than an enum: the cloud normalizes several upstream vocabularies into
/// `queued` / `processing` / `completed` / `error`, and a value we don't know
/// yet has to read as "still working", not as a decode failure.
public struct BatchJobStatus: Decodable, Sendable {
    public let status: String
    public let errorMessage: String?
    public let durationMs: UInt64?

    public init(status: String, errorMessage: String? = nil, durationMs: UInt64? = nil) {
        self.status = status
        self.errorMessage = errorMessage
        self.durationMs = durationMs
    }
}

// MARK: service

/// The four calls `BatchTranscriber` needs. `CloudClient` conforms; tests use a
/// fake. Splitting them out keeps the polling loop testable without a network —
/// this package has no URL-protocol stubbing and does not want any.
public protocol BatchTranscriptionService: Sendable {
    func startBatchJob(audio: Data, diarization: Bool, languageHints: [String]) async throws
        -> String
    func batchJobStatus(id: String) async throws -> BatchJobStatus
    func batchTranscript(id: String) async throws -> BatchTranscriptResponse
    /// Best effort, and deliberately not `throws`: by the time this runs the
    /// transcript is already in hand, so a failed cleanup must not fail the
    /// transcription.
    func deleteBatchJob(id: String) async
}

// MARK: errors

/// Failures that belong to the job rather than to the HTTP call. Transport and
/// status-code failures still surface as `CloudError` — see
/// `CloudError.batchTranscriptionMessage` for the user-facing wording of those.
public enum BatchTranscriptionError: Error, Equatable, LocalizedError {
    /// The cloud reported `status: "error"`; the payload is its `errorMessage`.
    case jobFailed(String)
    /// The poll cap was exhausted with the job still unsettled.
    case timedOut

    public var errorDescription: String? { message }

    /// The message to put in front of the user, localized.
    public var message: String {
        switch self {
        case .jobFailed(let reason):
            return String(
                format: String(localized: "Transcription failed: %@", bundle: .module), reason)
        case .timedOut:
            return String(localized: "Transcription timed out.", bundle: .module)
        }
    }
}

extension CloudError {
    /// Turn a failed batch request into something the user can act on. These
    /// strings land in an alert, so each one names the next step: the status is
    /// what distinguishes "your session died" from "you're out of quota" from
    /// "this file is simply too big", and those need different actions.
    /// Unrecognized statuses keep the cloud's own `{"error": …}` code so a bug
    /// report still carries detail. Ported from `parley_batch_error` in
    /// `src-tauri/src/replay.rs`.
    public var batchTranscriptionMessage: String {
        switch status {
        case 401:
            return String(
                localized: "Sign in to Parley Cloud to transcribe recordings.", bundle: .module)
        case 402:
            return String(
                localized:
                    "Your monthly hosted transcription quota is used up — upgrade your plan or wait for it to reset.",
                bundle: .module)
        // The cloud caps how many transcriptions one account can have in flight,
        // counting live meetings too — so this usually means "you're recording
        // right now", which is a wait, not a failure.
        case 429:
            return String(
                localized:
                    "Too many transcriptions running at once — wait for a meeting or an earlier upload to finish, then try again.",
                bundle: .module)
        case 413:
            return String(
                localized:
                    "This recording is too large for hosted transcription — split it into shorter files and upload them separately.",
                bundle: .module)
        case 502:
            return String(
                localized:
                    "Parley Cloud couldn't reach the transcription service — try again in a few minutes.",
                bundle: .module)
        default:
            let code = errorCodeFromBody
            if code.isEmpty {
                return String(
                    format: String(
                        localized: "Hosted transcription failed (HTTP %lld)", bundle: .module),
                    Int64(status))
            }
            return String(
                format: String(
                    localized: "Hosted transcription failed (HTTP %lld): %@", bundle: .module),
                Int64(status), code)
        }
    }

    /// `message` is the raw response body. The cloud answers errors with
    /// `{"error": "some_code"}`; anything else (an HTML error page, an empty
    /// body) yields "" and the caller falls back to the bare status.
    private var errorCodeFromBody: String {
        guard let data = message.data(using: .utf8),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let code = obj["error"] as? String
        else { return "" }
        return code
    }
}

// MARK: grouping

/// Group a flat token stream into speaker runs. A change of speaker closes the
/// current run and starts a new one; whitespace is preserved as the provider
/// supplies it. Empty / whitespace-only runs are dropped.
///
/// Port of `group_tokens` in `src-tauri/src/replay.rs` — behaviour must match it
/// exactly, or the same file transcribed on the phone and on the Mac would come
/// back split into different speakers.
public func groupBatchTokens(_ tokens: [BatchToken], source: String) -> [TranscriptSegment] {
    var segments: [TranscriptSegment] = []
    var segIndex = 0

    // -1 is "no run open yet", which is why this is signed and the trailing
    // emit clamps it back to 0.
    var curSpeaker = -1
    var curText = ""
    var curStart: UInt64 = 0
    var curEnd: UInt64 = 0

    func isBlank(_ s: String) -> Bool {
        s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    for tok in tokens {
        // Skip control / endpoint markers that some models emit.
        if tok.text == "<end>" || tok.text == "<fin>" { continue }

        // Tokens without a speaker (e.g. some punctuation/spacing tokens) should
        // stay in the CURRENT speaker's run — snapping them to speaker 0 would
        // close the run and fragment the transcript into spurious extra speakers.
        let spk: Int
        if let s = tok.speaker {
            spk = s
        } else if curSpeaker >= 0 {
            spk = curSpeaker
        } else {
            spk = 0
        }

        if curSpeaker == -1 {
            curSpeaker = spk
            curStart = tok.startMs
        } else if spk != curSpeaker {
            if !isBlank(curText) {
                segments.append(
                    TranscriptSegment(
                        id: "\(source)-\(segIndex)", source: source, speaker: curSpeaker,
                        text: curText, isFinal: true, startMs: curStart, endMs: curEnd))
                segIndex += 1
            }
            curSpeaker = spk
            curText = ""
            curStart = tok.startMs
        }
        curText += tok.text
        curEnd = tok.endMs
    }

    if !isBlank(curText) {
        segments.append(
            TranscriptSegment(
                id: "\(source)-\(segIndex)", source: source, speaker: max(curSpeaker, 0),
                text: curText, isFinal: true, startMs: curStart, endMs: curEnd))
    }

    return segments
}

// MARK: the transcriber

public struct BatchTranscriptionResult: Sendable {
    public let segments: [TranscriptSegment]
    public let durationMs: UInt64

    public init(segments: [TranscriptSegment], durationMs: UInt64) {
        self.segments = segments
        self.durationMs = durationMs
    }
}

/// Drives one hosted transcription from raw bytes to grouped segments.
///
/// The cadence — sleep first, then poll, 1500 ms apart, at most 800 times — is
/// the desktop's, which puts the ceiling a little over 20 minutes of waiting.
public struct BatchTranscriber: Sendable {
    /// iOS records one mixed stream, so every segment a phone produces carries
    /// this source (see the doc comment on `TranscriptSegment`).
    public static let source = "mix"

    private let service: any BatchTranscriptionService
    private let pollInterval: Duration
    private let maxPolls: Int

    public init(
        service: BatchTranscriptionService,
        pollInterval: Duration = .milliseconds(1500),
        maxPolls: Int = 800
    ) {
        self.service = service
        self.pollInterval = pollInterval
        self.maxPolls = maxPolls
    }

    /// Upload → poll → fetch → group → best-effort delete.
    public func transcribe(
        audio: Data, diarization: Bool = true, languageHints: [String] = []
    ) async throws -> BatchTranscriptionResult {
        let jobId = try await service.startBatchJob(
            audio: audio, diarization: diarization, languageHints: languageHints)

        // The cloud normalizes upstream states into the four handled here, so a
        // status we don't recognize is treated as "still working" rather than a
        // hard failure.
        var reportedDurationMs: UInt64?
        polling: for _ in 0..<maxPolls {
            try await Task.sleep(for: pollInterval)
            let job = try await service.batchJobStatus(id: jobId)
            switch job.status {
            case "completed":
                reportedDurationMs = job.durationMs ?? 0
                break polling
            case "error":
                throw BatchTranscriptionError.jobFailed(job.errorMessage ?? "unknown error")
            default:
                continue
            }
        }
        guard let audioDurationMs = reportedDurationMs else {
            throw BatchTranscriptionError.timedOut
        }

        let transcript = try await service.batchTranscript(id: jobId)

        // Fire and forget so the cloud isn't left holding the audio.
        await service.deleteBatchJob(id: jobId)

        let segments = groupBatchTokens(transcript.tokens, source: Self.source)
        // The job's own duration can undershoot the transcript (a trailing token
        // may end past it) and can be absent entirely, so take whichever is
        // longer — same reconciliation the Rust does.
        let durationMs = max(segments.map(\.endMs).max() ?? 0, audioDurationMs)

        return BatchTranscriptionResult(segments: segments, durationMs: durationMs)
    }
}
