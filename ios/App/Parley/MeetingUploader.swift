import Foundation
import ParleyKit

/// Owns one meeting's recording artifacts: streams PCM into the Ogg/Opus
/// encoder (pages go straight to a temp file — a 1-hour meeting never sits in
/// memory), then syncs the finished meeting to the cloud with the desktop's
/// exact contract:
///
///   1. `PUT /recordings/:id/audio` FIRST — a summary row must never claim
///      `hasAudio` before its blob exists (sync.ts:80-89).
///   2. `POST /recordings/:id` with `{summary, meta}`.
///   3. Default-save rule (history.ts:176-215): an org default never moves
///      the original — the recording lands in the personal space, then a copy
///      is auto-shared into the org.
final class MeetingUploader {
    let id = UUID().uuidString.lowercased()
    private let startedAt = Date()
    private var encoder: OggOpusEncoder?
    private var fileHandle: FileHandle?
    private let fileURL: URL
    private var samplesFed: Int = 0
    private let queue = DispatchQueue(label: "parley.recorder")

    init() throws {
        fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("parley-recording-\(id).ogg")
        FileManager.default.createFile(atPath: fileURL.path, contents: nil)
        let handle = try FileHandle(forWritingTo: fileURL)
        fileHandle = handle
        encoder = try OggOpusEncoder { page in
            try? handle.write(contentsOf: page)
        }
    }

    /// Called from the audio callback path — hop to the serial queue so the
    /// encoder never races.
    func append(_ samples: [Int16]) {
        queue.async { [self] in
            samplesFed += samples.count
            encoder?.append(samples)
        }
    }

    var durationMs: Double {
        Double(samplesFed) / Double(OggOpusEncoder.sampleRate) * 1000
    }

    struct Outcome {
        var sharedToOrgName: String?
    }

    /// Finish the file and sync. Discards (returns nil) when the meeting is
    /// shorter than 2 s — same threshold as the desktop recorder.
    func finishAndUpload(
        segments: [TranscriptSegment],
        cloud: CloudClient,
        defaultSave: SaveDestination,
        orgs: [CloudOrg]
    ) async throws -> Outcome? {
        // Drain the encoder queue, then close the stream.
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            queue.async { [self] in
                encoder?.finalize()
                try? fileHandle?.close()
                cont.resume()
            }
        }
        defer { try? FileManager.default.removeItem(at: fileURL) }

        guard durationMs >= 2000 else { return nil }

        let finals = segments.filter { $0.isFinal && !$0.id.hasSuffix("-tail") }
        let personalFolderId = defaultSave.isOrg ? nil : defaultSave.folderId
        let meta = buildMeta(finals: finals, folderId: personalFolderId)
        let summary = buildSummary(finals: finals, folderId: personalFolderId)

        let audio = try Data(contentsOf: fileURL)
        try await cloud.uploadAudio(id: id, ogg: audio)
        try await cloud.pushRecording(id: id, summary: summary, meta: meta)

        var outcome = Outcome()
        if defaultSave.isOrg, let orgId = defaultSave.orgId {
            try await cloud.shareRecording(id: id, orgId: orgId, folderId: defaultSave.folderId)
            outcome.sharedToOrgName = orgs.first { $0.id == orgId }?.name ?? "組織"
        }
        return outcome
    }

    // MARK: meta / summary (desktop HistoryEntry shape)

    private var defaultTitle: String {
        let fmt = DateFormatter()
        fmt.dateFormat = "M/d HH:mm"
        return "會議 \(fmt.string(from: startedAt))"
    }

    private func buildMeta(finals: [TranscriptSegment], folderId: String?) -> RecordingMeta {
        var raw: [String: Any] = [
            "id": id,
            "title": defaultTitle,
            "source": "live",
            "createdAt": startedAt.timeIntervalSince1970 * 1000,
            "durationMs": durationMs,
            "segments": finals.map { s in
                [
                    "id": s.id, "source": s.source, "speaker": s.speaker,
                    "text": s.text, "isFinal": true,
                    "startMs": Double(s.startMs), "endMs": Double(s.endMs),
                ] as [String: Any]
            },
            "speakerNames": [String: String](),
            "findings": [Any](),
            "actionItems": [Any](),
            "meetingContext": "",
            "meetingBatna": "",
            "meetingTarget": "",
            "meetingFloor": "",
            "audio": "audio.ogg",
            "analyzed": false,
        ]
        if let folderId { raw["folderId"] = folderId }
        return RecordingMeta(raw: raw)
    }

    private func buildSummary(finals: [TranscriptSegment], folderId: String?)
        -> CloudRecordingSummary
    {
        let speakers = Set(finals.map { "\($0.source)-\($0.speaker)" }).count
        let snippet = finals.prefix(3).map(\.text).joined(separator: " ").prefix(120)
        return CloudRecordingSummary(
            id: id, title: defaultTitle, source: "live",
            createdAt: startedAt.timeIntervalSince1970 * 1000,
            durationMs: durationMs,
            speakerCount: max(speakers, finals.isEmpty ? 0 : 1),
            findingsCount: 0, actionItemsCount: 0,
            hasAudio: true, snippet: String(snippet),
            folderId: folderId, updatedAt: nil)
    }
}
