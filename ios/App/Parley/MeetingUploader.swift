import Foundation
import ParleyKit

/// Owns one live recording. Finished audio is first moved to Application
/// Support, then synced with the desktop's audio-first contract. A failed or
/// interrupted upload remains in the on-device queue until it succeeds.
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

    struct SyncResult {
        let uploaded: Int
        let remaining: Int
    }

    private struct PendingUpload: Codable {
        let id: String
        let startedAt: Date
        let durationMs: Double
        let segments: [TranscriptSegment]
        let defaultSave: SaveDestination
    }

    /// Finalize the Ogg stream, place it in the durable queue, then attempt an
    /// immediate sync. Files are deleted only after every cloud step succeeds.
    func finishAndUpload(
        segments: [TranscriptSegment],
        cloud: CloudClient,
        defaultSave: SaveDestination,
        orgs: [CloudOrg]
    ) async throws -> Outcome? {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            queue.async { [self] in
                encoder?.finalize()
                try? fileHandle?.close()
                continuation.resume()
            }
        }

        guard durationMs >= 2_000 else {
            try? FileManager.default.removeItem(at: fileURL)
            return nil
        }

        let pending = PendingUpload(
            id: id,
            startedAt: startedAt,
            durationMs: durationMs,
            segments: segments.filter { $0.isFinal && !$0.id.hasSuffix("-tail") },
            defaultSave: defaultSave)
        try Self.persist(pending, audioAt: fileURL)
        return try await Self.upload(pending, cloud: cloud, orgs: orgs)
    }

    static func syncPending(cloud: CloudClient, orgs: [CloudOrg]) async -> SyncResult {
        let pending = loadPending()
        var uploaded = 0
        for item in pending {
            do {
                _ = try await upload(item, cloud: cloud, orgs: orgs)
                uploaded += 1
            } catch {
                // Keep the item in-order. A later recording can be retried by the
                // next foreground launch, but do not spin a failing network loop.
                break
            }
        }
        return SyncResult(uploaded: uploaded, remaining: max(0, pending.count - uploaded))
    }

    static var pendingCount: Int { loadPending().count }

    private static func upload(
        _ pending: PendingUpload,
        cloud: CloudClient,
        orgs: [CloudOrg]
    ) async throws -> Outcome {
        let finals = pending.segments
        let personalFolderId = pending.defaultSave.isOrg ? nil : pending.defaultSave.folderId
        let meta = buildMeta(pending: pending, finals: finals, folderId: personalFolderId)
        let summary = buildSummary(pending: pending, finals: finals, folderId: personalFolderId)
        let audio = try Data(contentsOf: audioURL(for: pending.id))

        try await cloud.uploadAudio(id: pending.id, ogg: audio)
        try await cloud.pushRecording(id: pending.id, summary: summary, meta: meta)

        var outcome = Outcome()
        if pending.defaultSave.isOrg, let orgId = pending.defaultSave.orgId {
            try await cloud.shareRecording(id: pending.id, orgId: orgId, folderId: pending.defaultSave.folderId)
            outcome.sharedToOrgName =
                orgs.first { $0.id == orgId }?.name ?? String(localized: "Organization")
        }

        removePending(id: pending.id)
        return outcome
    }

    private static func buildMeta(
        pending: PendingUpload,
        finals: [TranscriptSegment],
        folderId: String?
    ) -> RecordingMeta {
        var raw: [String: Any] = [
            "id": pending.id,
            "title": title(for: pending.startedAt),
            "source": "live",
            "createdAt": pending.startedAt.timeIntervalSince1970 * 1_000,
            "durationMs": pending.durationMs,
            "segments": finals.map { segment in
                [
                    "id": segment.id, "source": segment.source, "speaker": segment.speaker,
                    "text": segment.text, "isFinal": true,
                    "startMs": Double(segment.startMs), "endMs": Double(segment.endMs),
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

    private static func buildSummary(
        pending: PendingUpload,
        finals: [TranscriptSegment],
        folderId: String?
    ) -> CloudRecordingSummary {
        let speakers = Set(finals.map { "\($0.source)-\($0.speaker)" }).count
        let snippet = finals.prefix(3).map(\.text).joined(separator: " ").prefix(120)
        return CloudRecordingSummary(
            id: pending.id, title: title(for: pending.startedAt), source: "live",
            createdAt: pending.startedAt.timeIntervalSince1970 * 1_000,
            durationMs: pending.durationMs,
            speakerCount: max(speakers, finals.isEmpty ? 0 : 1),
            findingsCount: 0, actionItemsCount: 0,
            hasAudio: true, snippet: String(snippet),
            folderId: folderId, updatedAt: nil)
    }

    /// The default title a recording carries into the library. Formatted in the
    /// user's locale — a Chinese phone reads 8/9 下午3:20, an English one Aug 9,
    /// 3:20 PM — rather than one hard-coded pattern for everybody.
    private static func title(for date: Date) -> String {
        let stamp = date.formatted(
            .dateTime.month(.abbreviated).day().hour().minute())
        return String(localized: "Meeting \(stamp)")
    }

    private static func pendingDirectory() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("Parley/PendingUploads", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private static func audioURL(for id: String) throws -> URL {
        try pendingDirectory().appendingPathComponent("\(id).ogg")
    }

    private static func manifestURL(for id: String) throws -> URL {
        try pendingDirectory().appendingPathComponent("\(id).json")
    }

    private static func persist(_ pending: PendingUpload, audioAt source: URL) throws {
        let destination = try audioURL(for: pending.id)
        if FileManager.default.fileExists(atPath: destination.path) {
            try FileManager.default.removeItem(at: destination)
        }
        try FileManager.default.moveItem(at: source, to: destination)
        let manifest = try manifestURL(for: pending.id)
        try JSONEncoder().encode(pending).write(to: manifest, options: .atomic)
    }

    private static func loadPending() -> [PendingUpload] {
        guard let directory = try? pendingDirectory(),
            let files = try? FileManager.default.contentsOfDirectory(
                at: directory, includingPropertiesForKeys: [.creationDateKey])
        else { return [] }
        return files
            .filter { $0.pathExtension == "json" }
            .compactMap { url in
                guard let data = try? Data(contentsOf: url) else { return nil }
                return try? JSONDecoder().decode(PendingUpload.self, from: data)
            }
            .sorted { $0.startedAt < $1.startedAt }
    }

    private static func removePending(id: String) {
        [try? audioURL(for: id), try? manifestURL(for: id)].compactMap { $0 }.forEach { url in
            try? FileManager.default.removeItem(at: url)
        }
    }
}
