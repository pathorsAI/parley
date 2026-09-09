import Foundation
import ParleyKit

/// Owns one live recording. Finished audio is first moved to Application
/// Support, then synced with the desktop's audio-first contract. A failed or
/// interrupted upload remains in the on-device queue until it succeeds.
///
/// The queue is not live-only: an imported audio file, once decoded and
/// batch-transcribed, is filed through `fileImported` and rides the exact same
/// persist → upload → push → share → delete-manifest path. Both sources are
/// retried by the same `syncPending`, so an import that loses the network is no
/// more lost than a meeting that does.
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

    /// Shorter than this and there is no meeting to keep. Shared with the
    /// import path so a picked file is judged by the same bar a live recording
    /// is — and so the two can never drift apart.
    static let minimumDurationMs: Double = 2_000

    /// What a finished upload left in the cloud.
    ///
    /// More than the org name it started as: the filing suggestion runs against
    /// the recording that just landed, so it needs the id to write back to and
    /// the name and folder the recording actually carries — which is the state
    /// its suggestion is accepted against.
    struct Outcome {
        let recordingId: String
        /// The name the recording landed under: the clock name for a live
        /// meeting (`title(for:)`), the file's own name for an import.
        let title: String
        /// The personal folder it landed in; nil = the personal root.
        let folderId: String?
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
        /// Desktop's `RecordingMeta.source`: `"live"` for a meeting recorded on
        /// this phone, `"upload"` for an imported file. Drives the LIVE/UPLOAD
        /// badge in the library, on both platforms.
        let source: String
        /// The name the user should recognise. nil means "no name of its own",
        /// which is every live recording — those are named by the clock at
        /// upload time so a queued recording is stamped when it was made.
        let title: String?

        /// Both new fields decode with a default, because this manifest is
        /// written to disk and read back by a *later build of the app*. Someone
        /// can update Parley with recordings still sitting in the queue, and a
        /// manifest written before imports existed has neither key. Failing to
        /// decode would drop that recording on the floor for good — so an old
        /// manifest reads as exactly what it was: a clock-named live recording.
        enum CodingKeys: String, CodingKey {
            case id, startedAt, durationMs, segments, defaultSave, source, title
        }

        init(
            id: String,
            startedAt: Date,
            durationMs: Double,
            segments: [TranscriptSegment],
            defaultSave: SaveDestination,
            source: String,
            title: String?
        ) {
            self.id = id
            self.startedAt = startedAt
            self.durationMs = durationMs
            self.segments = segments
            self.defaultSave = defaultSave
            self.source = source
            self.title = title
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try container.decode(String.self, forKey: .id)
            startedAt = try container.decode(Date.self, forKey: .startedAt)
            durationMs = try container.decode(Double.self, forKey: .durationMs)
            segments = try container.decode([TranscriptSegment].self, forKey: .segments)
            defaultSave = try container.decode(SaveDestination.self, forKey: .defaultSave)
            source = try container.decodeIfPresent(String.self, forKey: .source) ?? "live"
            title = try container.decodeIfPresent(String.self, forKey: .title)
        }

        /// The name this recording lands under.
        var displayTitle: String { title ?? MeetingUploader.title(for: startedAt) }
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

        guard durationMs >= Self.minimumDurationMs else {
            try? FileManager.default.removeItem(at: fileURL)
            return nil
        }

        let pending = PendingUpload(
            id: id,
            startedAt: startedAt,
            durationMs: durationMs,
            segments: segments.filter { $0.isFinal && !$0.id.hasSuffix("-tail") },
            defaultSave: defaultSave,
            source: "live",
            title: nil)
        try Self.persist(pending, audioAt: fileURL)
        return try await Self.upload(pending, cloud: cloud, orgs: orgs)
    }

    /// File an imported recording — audio that was decoded and batch-transcribed
    /// elsewhere (`RecordingImporter`) rather than captured live.
    ///
    /// Deliberately the same three moves as `finishAndUpload`: persist the
    /// manifest and the Ogg into Application Support first, then upload. If any
    /// cloud step fails the entry survives in the queue and `syncPending` picks
    /// it up on the next foreground launch — an import is no more losable than a
    /// meeting. `ogg` is *moved* out of its temp location, not copied.
    ///
    /// nil means the audio was too short to be worth keeping, matching
    /// `finishAndUpload`; the file is discarded in that case.
    static func fileImported(
        oggAt ogg: URL,
        durationMs: Double,
        segments: [TranscriptSegment],
        title: String,
        cloud: CloudClient,
        defaultSave: SaveDestination,
        orgs: [CloudOrg]
    ) async throws -> Outcome? {
        guard durationMs >= minimumDurationMs else {
            try? FileManager.default.removeItem(at: ogg)
            return nil
        }

        // A file whose name is nothing but whitespace would land as a blank row
        // in the library, which reads as a bug. Fall back to the clock name the
        // live path uses — it is at least something the user can place.
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)

        let pending = PendingUpload(
            id: UUID().uuidString.lowercased(),
            startedAt: Date(),
            durationMs: durationMs,
            segments: segments.filter { $0.isFinal && !$0.id.hasSuffix("-tail") },
            defaultSave: defaultSave,
            source: "upload",
            title: trimmed.isEmpty ? nil : trimmed)
        try persist(pending, audioAt: ogg)
        return try await upload(pending, cloud: cloud, orgs: orgs)
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

        var outcome = Outcome(
            recordingId: pending.id,
            title: pending.displayTitle,
            folderId: personalFolderId,
            sharedToOrgName: nil)
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
            "title": pending.displayTitle,
            "source": pending.source,
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
            id: pending.id, title: pending.displayTitle, source: pending.source,
            createdAt: pending.startedAt.timeIntervalSince1970 * 1_000,
            durationMs: pending.durationMs,
            speakerCount: max(speakers, finals.isEmpty ? 0 : 1),
            findingsCount: 0, actionItemsCount: 0,
            hasAudio: true, snippet: String(snippet),
            folderId: folderId, updatedAt: nil)
    }

    /// The title a recording with no name of its own carries into the library:
    /// every live meeting, and an import whose file name was blank. Formatted in
    /// the user's locale — a Chinese phone reads 8/9 下午3:20, an English one
    /// Aug 9, 3:20 PM — rather than one hard-coded pattern for everybody.
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
