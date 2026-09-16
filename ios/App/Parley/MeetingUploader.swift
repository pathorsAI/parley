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

    /// The user threw the meeting away: close the encoder and delete the audio
    /// file so nothing is left to upload. Not persisted to the pending queue,
    /// so `syncPending` never resurrects it.
    func abandon() {
        queue.sync { [self] in
            encoder = nil
            try? fileHandle?.close()
            fileHandle = nil
            try? FileManager.default.removeItem(at: fileURL)
        }
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

    /// What one pass over the upload queue did.
    ///
    /// `@unchecked Sendable` for the one field that cannot be checked: `Error`
    /// carries no `Sendable` conformance, and this value crosses from the pass
    /// back to the main actor. Everything that reaches it is an immutable value
    /// — `CloudError`, `CancellationError`, or a finished `NSError` out of
    /// `URLSession` — so there is nothing here for two threads to disagree
    /// about.
    struct SyncResult: @unchecked Sendable {
        let uploaded: Int
        /// Entries that could never have succeeded and were dropped rather than
        /// left at the head of the queue. See `hasAudio` and `isTerminal`.
        let discarded: Int
        let remaining: Int
        /// Why the pass stopped short, if it did; nil when it reached the end.
        /// Kept rather than swallowed so a caller has something true to say
        /// about a queue that is not draining.
        let failure: Error?
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
        var uploaded = 0
        var discarded = 0
        var failure: Error?
        for item in loadPending() {
            // The manifest outlived its audio — an interrupted `persist`, or
            // the user clearing storage out from under the queue. `upload`
            // reads the Ogg with a hard `try`, so this entry throws on every
            // pass for the life of the install and, because the queue is
            // oldest-first and stops at the first failure, takes every
            // recording behind it down with it. There is no meeting left to
            // send, so drop it instead of guarding the door with it.
            guard hasAudio(at: try? audioURL(for: item.id)) else {
                removePending(id: item.id)
                discarded += 1
                continue
            }
            do {
                _ = try await upload(item, cloud: cloud, orgs: orgs)
                uploaded += 1
            } catch is CancellationError {
                // The pass was torn down, not the upload refused. Stop without
                // marking anything: the queue is exactly as it was.
                failure = CancellationError()
                break
            } catch let error as CloudError where isTerminal(error) {
                // The server will refuse this request identically forever — the
                // file is too large, the account is out of credit, the payload
                // is malformed. Retrying costs an upload of an hour of audio
                // every launch and blocks everything queued behind it.
                removePending(id: item.id)
                discarded += 1
                failure = error
            } catch {
                // Transport, or a 5xx: the next item would fail the same way,
                // so stop the pass and keep the queue in order.
                failure = error
                break
            }
        }
        // Read back rather than subtracted: `upload` retires an entry itself —
        // to the backfill queue when the transcript came up short — so the only
        // honest count of what is left is the directory's own.
        return SyncResult(
            uploaded: uploaded, discarded: discarded, remaining: loadPending().count,
            failure: failure)
    }

    static var pendingCount: Int { loadPending().count }

    /// Whether a queued entry still has an Ogg worth running.
    ///
    /// Both queues read their audio with a hard `try`, so an entry whose file
    /// is gone or truncated to nothing can never run again — and both queues
    /// stop at the first failure, so one of those at the head holds everything
    /// behind it hostage. Android skips and drops them for exactly this reason
    /// and calls it "the same protection `MeetingUploader.drain` gives the
    /// upload queue" (`TranscriptBackfiller.kt`); this is that protection,
    /// which iOS turns out never to have had on either queue.
    private static func hasAudio(at url: URL?) -> Bool {
        guard let url else { return false }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        return size > 0
    }

    /// Whether a server's answer is the end of the road for a queued entry.
    ///
    /// A 4xx means the server objected to the request itself — the file is too
    /// large (413), the account is out of credit (402), the payload is
    /// malformed (400) — and the identical request will be refused identically
    /// on every future pass. Left in a stop-at-first-failure queue, one of
    /// those jams every recording behind it forever, which is the whole reason
    /// a dead-letter path exists here.
    ///
    /// The exceptions are the 4xx that somebody's later action clears: signing
    /// in again (401), being granted access or paying (403), and simply waiting
    /// (408, 425, 429). Those stop the pass rather than end the entry. 5xx and
    /// transport failures are not this function's business — they fall through
    /// to `false` and stop the pass.
    private static func isTerminal(_ error: CloudError) -> Bool {
        switch error.status {
        case 401, 403, 408, 425, 429: return false
        case 400..<500: return true
        default: return false
        }
    }

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

        // The cloud now holds everything, so the *queue's* copy has done its job
        // — unless the transcript that went up does not account for the audio
        // that went with it, in which case the Ogg is the only thing that can
        // still fix it and is handed to the backfill queue instead.
        //
        // What happens to the file after that is `retireAudio`'s decision, not
        // this one's: a phone that keeps its audio moves it into the local
        // store so the meeting can be played back here, and only a phone that
        // does not deletes it.
        let coverage = TranscriptCoverage.report(
            segments: finals, totalMs: UInt64(max(0, pending.durationMs)))
        if coverage.needsBackfill() {
            enqueueBackfill(for: pending, folderId: personalFolderId)
        } else {
            retireAudio(id: pending.id, at: try? audioURL(for: pending.id))
            removePending(id: pending.id)
        }
        return outcome
    }

    /// The end of an Ogg's life on this phone, for every path that reaches it:
    /// a live meeting, an import, a queued upload that finally synced, and a
    /// backfill that has been transcribed.
    ///
    /// One function because the setting has to mean the same thing down all
    /// four — "keep audio on this phone" that only held live recordings would be
    /// a setting nobody could predict.
    ///
    /// A failed move deletes instead. The cloud already has the file, so the
    /// cost is a recording that has to be downloaded to play back; leaving it
    /// in a queue directory that nothing reads any more would cost the same
    /// bytes forever with no way to see or clear them.
    private static func retireAudio(id: String, at url: URL?) {
        guard let url, FileManager.default.fileExists(atPath: url.path) else { return }
        if LocalAudioStore.keepsAudioOnPhone,
            (try? LocalAudioStore.shared.put(id, from: url)) != nil
        {
            return
        }
        try? FileManager.default.removeItem(at: url)
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
            "segments": RecordingMeta.encode(finals),
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
        CloudRecordingSummary(
            id: pending.id, title: pending.displayTitle, source: pending.source,
            createdAt: pending.startedAt.timeIntervalSince1970 * 1_000,
            durationMs: pending.durationMs,
            speakerCount: CloudRecordingSummary.speakerCount(of: finals),
            findingsCount: 0, actionItemsCount: 0,
            hasAudio: true, snippet: CloudRecordingSummary.snippet(of: finals),
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

    // MARK: crash recovery

    /// Ogg files left in the temporary directory by a recording that never
    /// finished — the app was force-quit, ran out of memory, or crashed.
    ///
    /// `init` creates the file and the encoder writes pages to it continuously,
    /// so what survives is a playable recording up to the last flushed page.
    /// Until now nothing ever looked for these: iOS purges its temporary
    /// directory on its own schedule and does not include it in backups, so a
    /// meeting that ended in a crash was gone for good with no trace anywhere.
    ///
    /// Adopting one costs nothing and gains a meeting. It is filed with **no
    /// transcript at all**, which means the coverage check reads it as one
    /// whole-file gap and the backfill queue transcribes every second of it —
    /// the same machinery, with nothing special-cased for it.
    ///
    /// Only safe to call before any recording starts, which is why it runs at
    /// launch and nowhere else: a live meeting's Ogg is sitting in exactly this
    /// directory being written to, and adopting it would move the file out from
    /// under the encoder.
    static func adoptOrphanedRecordings(defaultSave: SaveDestination) -> Int {
        let temporary = FileManager.default.temporaryDirectory
        guard
            let files = try? FileManager.default.contentsOfDirectory(
                at: temporary, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey])
        else { return 0 }

        var adopted = 0
        for url in files where url.lastPathComponent.hasPrefix("parley-recording-")
            && url.pathExtension == "ogg"
        {
            let values = try? url.resourceValues(
                forKeys: [.fileSizeKey, .contentModificationDateKey])
            let bytes = values?.fileSize ?? 0
            // Constant bitrate, so bytes are a good enough clock for the
            // length gate. The transcription job reports the real duration and
            // `runBackfill` takes whichever is longer.
            let estimatedMs = Double(bytes) * 8_000 / Double(OggOpusEncoder.bitrate)
            guard estimatedMs >= minimumDurationMs else {
                try? FileManager.default.removeItem(at: url)
                continue
            }

            let id =
                url.deletingPathExtension().lastPathComponent
                .replacingOccurrences(of: "parley-recording-", with: "")
            guard !id.isEmpty else { continue }

            let pending = PendingUpload(
                id: id,
                startedAt: values?.contentModificationDate ?? Date(),
                durationMs: estimatedMs,
                segments: [],
                defaultSave: defaultSave,
                source: "live",
                title: nil)
            if (try? persist(pending, audioAt: url)) != nil {
                adopted += 1
            }
        }
        return adopted
    }

    // MARK: backfill

    /// A recording whose transcript does not account for its audio, waiting for
    /// the async transcription that will replace it.
    ///
    /// Its own queue rather than a flag on `PendingUpload`, because the two
    /// describe different debts. A pending upload owes the cloud a recording;
    /// a pending backfill owes an *uploaded* recording a transcript it can be
    /// trusted with. The upload has already succeeded here — the library shows
    /// the meeting, and it is readable — so this must never block it or be
    /// retried in the same breath.
    private struct BackfillRequest: Codable {
        var pending: PendingUpload
        /// The personal folder the recording landed in, so the re-push files it
        /// where the first push did rather than dropping it into the root.
        var folderId: String?
        /// Which hand-triggered attempt this is: 0 for the automatic backfill
        /// that queued itself, 1 for the first re-run somebody asked for.
        ///
        /// The *budget* those attempts come out of is `ManualRetryBudget`, not
        /// this number — a finished backfill deletes its manifest, so a count
        /// living here could never be read back after a successful run. What
        /// this is for is telling the two kinds of run apart when one finishes,
        /// because only a manual one is charged. Only a transcription that
        /// actually completed spends the budget: a run that dies on a flat
        /// network has cost nothing and stays queued for free.
        var manualRetries: Int = 0
        /// The recording's meta exactly as it already exists, JSON-encoded, so
        /// the re-push can put the new transcript *into* it instead of building
        /// a fresh entry over the top of somebody's speaker names and analysis.
        /// See `RecordingMeta.replaceTranscript`.
        ///
        /// Optional, and nil for every automatic backfill: that one is queued
        /// by the upload that created the recording seconds earlier, so there
        /// is nothing on it yet to capture. It is **not** a licence to rebuild
        /// the entry from this request — `runBackfill` re-reads the recording
        /// from the cloud in that case, because by the time an automatic
        /// backfill finally runs (a later launch, possibly days later) the user
        /// may well have renamed and filed it, and `request.pending.title` is
        /// still the clock name it was born with. A manifest written by an
        /// older build has no key here either and takes the same path.
        var existingMeta: Data?
        /// The summary the library is already showing, for the same reason:
        /// `findingsCount` and the title belong to the recording, not to the
        /// transcript being replaced. See `replacingTranscript`.
        var existingSummary: CloudRecordingSummary?
        /// When a run of this request last *started*, and how many have.
        ///
        /// Stamped before the work rather than after it, because what they are
        /// for is telling a request that is being worked on apart from one that
        /// was abandoned mid-flight. `UIBackgroundModes` here is `audio` only,
        /// so a multi-minute transcription dies the moment the phone is locked,
        /// and the manifest it leaves behind is byte-identical to one that is
        /// running right now. Only the process knows the difference (see
        /// `RunningBackfills`), and only until it is killed — after that this
        /// date is all anyone has, which is why the detail screen is given it
        /// rather than a bare "queued".
        var lastAttemptAt: Date?
        var attemptCount: Int = 0

        enum CodingKeys: String, CodingKey {
            case pending, folderId, manualRetries, existingMeta, existingSummary
            case lastAttemptAt, attemptCount
        }

        init(
            pending: PendingUpload,
            folderId: String?,
            manualRetries: Int = 0,
            existingMeta: Data? = nil,
            existingSummary: CloudRecordingSummary? = nil,
            lastAttemptAt: Date? = nil,
            attemptCount: Int = 0
        ) {
            self.pending = pending
            self.folderId = folderId
            self.manualRetries = manualRetries
            self.existingMeta = existingMeta
            self.existingSummary = existingSummary
            self.lastAttemptAt = lastAttemptAt
            self.attemptCount = attemptCount
        }

        /// Written to disk and read back by a later build, same as
        /// `PendingUpload` — a missing count reads as "none spent yet", missing
        /// carry-over state as "there was nothing to carry over", and a missing
        /// attempt stamp as "nothing has tried this yet", rather than dropping
        /// the entry. Someone can update Parley with a re-transcription still
        /// queued, and a manifest from the shipped build has neither of the two
        /// attempt keys.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            pending = try c.decode(PendingUpload.self, forKey: .pending)
            folderId = try c.decodeIfPresent(String.self, forKey: .folderId)
            manualRetries = try c.decodeIfPresent(Int.self, forKey: .manualRetries) ?? 0
            existingMeta = try c.decodeIfPresent(Data.self, forKey: .existingMeta)
            existingSummary = try c.decodeIfPresent(
                CloudRecordingSummary.self, forKey: .existingSummary)
            lastAttemptAt = try c.decodeIfPresent(Date.self, forKey: .lastAttemptAt)
            attemptCount = try c.decodeIfPresent(Int.self, forKey: .attemptCount) ?? 0
        }
    }

    private static func backfillDirectory() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("Parley/PendingBackfills", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private static func backfillAudioURL(for id: String) throws -> URL {
        try backfillDirectory().appendingPathComponent("\(id).ogg")
    }

    private static func backfillManifestURL(for id: String) throws -> URL {
        try backfillDirectory().appendingPathComponent("\(id).json")
    }

    /// Move the Ogg out of the upload queue and into the backfill queue.
    ///
    /// A move, not a copy: exactly one queue owns the file at a time, so a
    /// crash between the two can leave the recording waiting or done but never
    /// holding two copies of an hour of audio.
    private static func enqueueBackfill(for pending: PendingUpload, folderId: String?) {
        do {
            let source = try audioURL(for: pending.id)
            let destination = try backfillAudioURL(for: pending.id)
            if FileManager.default.fileExists(atPath: destination.path) {
                try FileManager.default.removeItem(at: destination)
            }
            try FileManager.default.moveItem(at: source, to: destination)
            let request = BackfillRequest(pending: pending, folderId: folderId)
            try JSONEncoder().encode(request).write(
                to: backfillManifestURL(for: pending.id), options: .atomic)
            // The upload manifest has served its purpose; the backfill one
            // carries everything the re-push needs.
            try? FileManager.default.removeItem(at: manifestURL(for: pending.id))
        } catch {
            // Nothing to escalate: the recording is safely in the cloud with the
            // transcript it has. Failing to queue a backfill costs quality, not
            // the meeting, so it must not surface as an upload failure.
            removePending(id: pending.id)
        }
    }

    private static func loadBackfills() -> [BackfillRequest] {
        guard let directory = try? backfillDirectory(),
            let files = try? FileManager.default.contentsOfDirectory(
                at: directory, includingPropertiesForKeys: nil)
        else { return [] }
        return files
            .filter { $0.pathExtension == "json" }
            .compactMap { url in
                guard let data = try? Data(contentsOf: url) else { return nil }
                return try? JSONDecoder().decode(BackfillRequest.self, from: data)
            }
            .sorted { $0.pending.startedAt < $1.pending.startedAt }
    }

    private static func removeBackfill(id: String) {
        [try? backfillAudioURL(for: id), try? backfillManifestURL(for: id)]
            .compactMap { $0 }
            .forEach { try? FileManager.default.removeItem(at: $0) }
    }

    /// A backfill that is over, whichever way it ended. The Ogg has been paid
    /// for twice by now — once live, once in the batch job — so this is the last
    /// chance to keep it, and it is taken on exactly the same terms as a plain
    /// upload's.
    private static func finishBackfill(id: String) {
        retireAudio(id: id, at: try? backfillAudioURL(for: id))
        removeBackfill(id: id)
    }

    static var pendingBackfillCount: Int { loadBackfills().count }

    /// What one pass over the backfill queue did. `@unchecked Sendable` for the
    /// same reason as `SyncResult`, and on the same terms.
    struct BackfillResult: @unchecked Sendable {
        let repaired: Int
        /// Entries that can never run and were dropped: a manifest whose Ogg is
        /// gone, or a request the server refuses permanently.
        let discarded: Int
        let remaining: Int
        /// Why the pass stopped short, or the last refusal it dead-lettered on
        /// the way through. Nil when nothing went wrong at all.
        ///
        /// Throwing this away is what made a stuck re-transcription silent: the
        /// queue knew perfectly well why it had stopped and discarded the
        /// reason inside a bare `catch`. Note that a non-nil failure does not
        /// mean *this* recording failed — ask `backfillState(for:)` for that.
        let failure: Error?

        /// The pass never ran, so nothing changed and the queue is whatever it
        /// already was.
        static var skipped: BackfillResult {
            BackfillResult(
                repaired: 0, discarded: 0, remaining: MeetingUploader.pendingBackfillCount,
                failure: nil)
        }
    }

    /// What a recording's re-transcription is actually doing, as opposed to
    /// what the queue directory happens to contain.
    ///
    /// The distinction is the bug this type exists for. The screen used to ask
    /// `hasQueuedBackfill(for:)`, which is a `fileExists` call, so a job that
    /// iOS killed on the lock screen read exactly like one that was
    /// mid-transcription: "Re-transcribing…" forever, with the menu item that
    /// would retry it disabled, until the app was force-quit.
    enum BackfillState: Equatable {
        /// Nothing queued for this recording.
        case none
        /// A run is alive in this process right now.
        case running
        /// A manifest is on disk and nothing is running it. `lastAttempt` is
        /// when a run last started — nil if none ever has, which is the state a
        /// freshly queued request and a manifest from an older build share.
        case queued(lastAttempt: Date?)
    }

    /// Whether this recording's re-transcription is running, merely waiting, or
    /// not queued at all.
    static func backfillState(for id: String) -> BackfillState {
        if RunningBackfills.shared.contains(id) { return .running }
        guard let url = try? backfillManifestURL(for: id),
            FileManager.default.fileExists(atPath: url.path)
        else { return .none }
        // Deliberately keyed off the file rather than off a successful decode:
        // a manifest this build cannot read is still work somebody is owed, and
        // reporting it as "nothing queued" would offer a second run beside it.
        return .queued(lastAttempt: backfillRequest(id: id)?.lastAttemptAt)
    }

    /// Transcribe the queued audio in full and replace the transcripts that
    /// came up short, oldest first.
    ///
    /// Whole-file rather than gap-filling on purpose: an async job costs less
    /// than the realtime leg that already ran, so the arithmetic never favours
    /// stitching. What stitching would cost instead is a seam — two models,
    /// two speaker numberings and two clocks meeting in the middle of a
    /// sentence — for a saving of a few cents.
    ///
    /// Safe to call from anywhere at any time: passes are serialized by
    /// `BackfillDrainGate`. `onRepaired` is called as each recording lands
    /// rather than at the end, because a pass can be several recordings and
    /// many minutes long and the screen the user has open should not have to
    /// wait for the last one to learn its own transcript changed.
    static func syncPendingBackfills(
        cloud: CloudClient,
        onRepaired: (@MainActor @Sendable (String) -> Void)? = nil
    ) async -> BackfillResult {
        await BackfillDrainGate.shared.drain(cloud: cloud, onRepaired: onRepaired)
    }

    /// One pass over the queue. Only ever called through the gate.
    fileprivate static func drainBackfills(
        cloud: CloudClient,
        onRepaired: (@MainActor @Sendable (String) -> Void)?
    ) async -> BackfillResult {
        var repaired = 0
        var discarded = 0
        var failure: Error?

        for request in loadBackfills() {
            if Task.isCancelled {
                failure = CancellationError()
                break
            }
            let id = request.pending.id
            switch await attemptBackfill(request, cloud: cloud) {
            case .repaired:
                repaired += 1
                // After `attemptBackfill` has returned, so the state this wakes
                // the screen up to read is already `.none` rather than
                // `.running`.
                await onRepaired?(id)
            case .discarded(let error):
                discarded += 1
                if let error { failure = error }
            case .stopped(let error):
                failure = error
                // A flat network fails the next one the same way, and a
                // backfill is never urgent. Everything still queued keeps its
                // place for the next pass.
                return BackfillResult(
                    repaired: repaired, discarded: discarded,
                    remaining: loadBackfills().count, failure: failure)
            }
        }
        return BackfillResult(
            repaired: repaired, discarded: discarded, remaining: loadBackfills().count,
            failure: failure)
    }

    /// How one queued request ended.
    private enum BackfillOutcome {
        case repaired
        /// Dropped for good. Carries the refusal when there was one; a manifest
        /// with no audio left has nobody to quote.
        case discarded(Error?)
        /// Left queued, and the pass should stop here.
        case stopped(Error)
    }

    private static func attemptBackfill(
        _ request: BackfillRequest, cloud: CloudClient
    ) async -> BackfillOutcome {
        let id = request.pending.id
        guard hasAudio(at: try? backfillAudioURL(for: id)) else {
            // The manifest outlived its blob: an interrupted enqueue, or the
            // user clearing app storage. It can never run, and `loadBackfills`
            // is oldest-first, so keeping it would block the head of the queue
            // forever — a fresh request the user just made would sit behind it
            // while the screen said "Re-transcribing…". Mirrors Android.
            removeBackfill(id: id)
            return .discarded(nil)
        }

        markAttempt(request)
        RunningBackfills.shared.begin(id)
        defer { RunningBackfills.shared.end(id) }

        do {
            try await runBackfill(request, cloud: cloud)
            return .repaired
        } catch is CancellationError {
            // Not this recording's failure: the task running the pass was torn
            // down. Reported as itself rather than folded into the generic
            // catch, where a cancelled launch task was indistinguishable from a
            // flat network. Nothing is charged and nothing is dropped.
            return .stopped(CancellationError())
        } catch let error as CloudError where isTerminal(error) {
            // `finishBackfill` rather than `removeBackfill`: this request is
            // over, and a request that is over gets its audio retired on the
            // same terms as any other — a phone set to keep audio keeps it.
            finishBackfill(id: id)
            return .discarded(error)
        } catch {
            return .stopped(error)
        }
    }

    /// Stamp a request as tried, in the manifest, before the work starts.
    ///
    /// Guarded on the manifest still being there so this can never write one
    /// back that something else has just finished and deleted.
    private static func markAttempt(_ request: BackfillRequest) {
        var updated = request
        updated.attemptCount += 1
        updated.lastAttemptAt = Date()
        guard let url = try? backfillManifestURL(for: request.pending.id),
            FileManager.default.fileExists(atPath: url.path),
            let data = try? JSONEncoder().encode(updated)
        else { return }
        try? data.write(to: url, options: .atomic)
    }

    private static func runBackfill(_ request: BackfillRequest, cloud: CloudClient) async throws {
        let id = request.pending.id
        let audio = try Data(contentsOf: backfillAudioURL(for: id))
        // Same call the import path makes: no language hints, so the cloud
        // auto-detects exactly as the desktop does with an empty list.
        let transcript = try await BatchTranscriber(service: cloud)
            .transcribe(audio: audio, diarization: true, languageHints: [])

        // The transcription has completed and been billed, so a hand-triggered
        // run is charged *here* — after the await that could have thrown, and
        // before the empty-transcript exit below. Everything above this line
        // can fail for free; nothing below it can fail in a way that gives the
        // hour back.
        if request.manualRetries > 0 { spendManualRetry(for: id) }

        // A job that came back with nothing is not an improvement on a thin
        // transcript — keep what the meeting already had rather than blanking
        // it, and stop retrying audio that has now been paid for once.
        guard !transcript.segments.isEmpty else {
            finishBackfill(id: id)
            return
        }

        let durationMs = max(request.pending.durationMs, Double(transcript.durationMs))
        let meta: RecordingMeta
        let summary: CloudRecordingSummary
        if var existing = request.existingMeta.flatMap(decodeMeta),
            let existingSummary = request.existingSummary
        {
            // A re-run of a recording that already has a life of its own: edit
            // the transcript inside what is there rather than replacing it.
            // `request.folderId` is not applied — the captured meta already
            // carries the recording's own folder, and writing the request's
            // copy over it would turn a re-transcription into a move.
            existing.replaceTranscript(segments: transcript.segments, durationMs: durationMs)
            meta = existing
            summary = existingSummary.replacingTranscript(
                segments: transcript.segments, durationMs: durationMs)
        } else {
            // The automatic path. It used to rebuild the entry out of
            // `request.pending`, on the reasoning that the recording had been
            // created seconds earlier by the upload that queued this and so had
            // nothing on it worth keeping. That reasoning holds at the moment
            // of queueing and stops holding immediately afterwards: this run
            // happens on a *later* launch, and between the two the user may
            // have renamed the recording, moved it, and had a filing suggestion
            // accepted on it. Pushing the rebuilt entry put the clock name —
            // "Meeting Sep 16, 3:20 PM" — back over the name they typed, along
            // with the folder and `filingSuggested`. A rename undone hours
            // later by a background job is silent data loss.
            //
            // So read the recording as it stands right now and edit the
            // transcript inside it, exactly as the manual path does.
            // `request.folderId` is not applied, for the same reason it is not
            // applied above: the recording's own folder is the current one.
            //
            // A hard `try`: a fetch that failed would leave us holding only the
            // stale copy, and quietly pushing that is the very thing this
            // branch exists to stop. Better to leave the request queued and
            // come back — the network that just failed here is the network the
            // push below needs anyway.
            var current = try await cloud.recordingMeta(id: id)
            current.replaceTranscript(segments: transcript.segments, durationMs: durationMs)
            meta = current
            summary = repushSummary(
                meta: current, fallback: request.pending, segments: transcript.segments)
        }

        // Audio is already in the cloud and unchanged, so this is a metadata
        // push only — the recording keeps its id, its folder and its sharing.
        try await cloud.pushRecording(id: id, summary: summary, meta: meta)
        finishBackfill(id: id)
    }

    /// The summary that goes up beside a re-pushed meta on the automatic path,
    /// derived from that meta rather than from the queued request.
    ///
    /// Every field here except the three the transcript speaks for is a fact
    /// the *recording* owns — its name, its folder, how much analysis is on it
    /// — and the request is out of date about all of them by the time an
    /// automatic backfill runs. `fallback` covers a meta so sparse it cannot
    /// name itself, which is not something the server should return but is
    /// cheap to survive.
    private static func repushSummary(
        meta: RecordingMeta, fallback: PendingUpload, segments: [TranscriptSegment]
    ) -> CloudRecordingSummary {
        CloudRecordingSummary(
            id: meta.id.isEmpty ? fallback.id : meta.id,
            title: meta.title.isEmpty ? fallback.displayTitle : meta.title,
            source: (meta.raw["source"] as? String) ?? fallback.source,
            createdAt: meta.createdAt > 0
                ? meta.createdAt : fallback.startedAt.timeIntervalSince1970 * 1_000,
            // `replaceTranscript` has already reconciled the two lengths.
            durationMs: meta.durationMs,
            speakerCount: CloudRecordingSummary.speakerCount(of: segments),
            findingsCount: (meta.raw["findings"] as? [Any])?.count ?? 0,
            actionItemsCount: (meta.raw["actionItems"] as? [Any])?.count ?? 0,
            hasAudio: true,
            snippet: CloudRecordingSummary.snippet(of: segments),
            folderId: meta.folderId,
            updatedAt: nil)
    }

    private static func decodeMeta(_ data: Data) -> RecordingMeta? {
        guard let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return RecordingMeta(raw: raw)
    }

    // MARK: re-transcribing on request

    enum ManualBackfillError: LocalizedError {
        /// The cap in `TranscriptCoverage.BackfillPolicy.maxManualRetries` is
        /// spent for this recording. The menu item is already disabled in that
        /// case; this is the backstop for a screen that was open while the last
        /// run finished elsewhere.
        case retryBudgetSpent

        var errorDescription: String? {
            switch self {
            case .retryBudgetSpent:
                return String(
                    localized: "This recording has been re-transcribed as many times as allowed.")
            }
        }
    }

    /// Queue a re-transcription somebody asked for, on a recording that is
    /// already in the cloud.
    ///
    /// The same queue the automatic backfill uses, and deliberately so: the
    /// work is identical — transcribe the whole file, push the metadata, leave
    /// the audio in the cloud alone — and a second mechanism would be a second
    /// set of retry, persistence and cap bugs. What is different is only how it
    /// got there, which is what `manualRetries` records.
    ///
    /// `audio` is **copied**, not moved, unlike `enqueueBackfill`. The file it
    /// points at is the one in `LocalAudioStore` that the player on screen is
    /// reading from — moving it out would stop playback mid-sentence and make
    /// the recording look un-downloaded while its own re-transcription ran.
    ///
    /// Personal scope only. The caller enforces that (the entry point is hidden
    /// in org scope) because only the personal endpoints can be re-pushed from
    /// the phone at all.
    static func enqueueManualBackfill(
        summary: CloudRecordingSummary, meta: RecordingMeta, audioAt audio: URL
    ) throws {
        let id = summary.id
        let budget = manualRetryBudget()
        guard budget.allowsRetry(for: id) else { throw ManualBackfillError.retryBudgetSpent }

        let folderId = meta.folderId ?? summary.folderId
        let createdAt = meta.createdAt > 0 ? meta.createdAt : summary.createdAt
        let pending = PendingUpload(
            id: id,
            startedAt: Date(timeIntervalSince1970: createdAt / 1_000),
            durationMs: max(meta.durationMs, summary.durationMs),
            // What the recording reads as today. It is only a fallback — the
            // new transcript replaces it — but a request that carried no
            // transcript at all would push a blank one if the job came back
            // empty and the fallback path were ever taken.
            segments: meta.segments.filter { $0.isFinal && !$0.id.hasSuffix("-tail") },
            defaultSave: SaveDestination(scope: "personal", orgId: nil, folderId: folderId),
            source: summary.source.isEmpty ? "live" : summary.source,
            title: meta.title.isEmpty ? (summary.title.isEmpty ? nil : summary.title) : meta.title)

        // Before the audio is touched, and with a hard `try` rather than a
        // `try?`: a request that reached the queue without the meta it is
        // preserving would fall through to the automatic path and rebuild the
        // entry from the new transcript alone — wiping the analysis this whole
        // detour exists to protect. Failing to queue is the better outcome.
        let existingMeta = try JSONSerialization.data(withJSONObject: meta.raw)

        let destination = try backfillAudioURL(for: id)
        if FileManager.default.fileExists(atPath: destination.path) {
            try FileManager.default.removeItem(at: destination)
        }
        try FileManager.default.copyItem(at: audio, to: destination)

        // Over any request already sitting in the queue for this recording —
        // an automatic backfill, or one of these whose run never landed. There
        // is one audio file and one manifest per id, so this replaces it rather
        // than racing it.
        let queued = backfillRequest(id: id)?.manualRetries ?? 0
        let request = BackfillRequest(
            pending: pending,
            folderId: folderId,
            manualRetries: max(queued + 1, budget.nextAttempt(for: id)),
            existingMeta: existingMeta,
            existingSummary: summary)
        do {
            try JSONEncoder().encode(request).write(
                to: backfillManifestURL(for: id), options: .atomic)
        } catch {
            // An Ogg with no manifest beside it is invisible to `loadBackfills`
            // and would sit in Application Support for the life of the install.
            try? FileManager.default.removeItem(at: destination)
            throw error
        }
    }

    /// Whether this recording has a re-transcription waiting or in flight, so a
    /// caller can decline to offer a second one.
    ///
    /// The coarse question, kept for callers that only need a yes/no. Anything
    /// that *shows* the answer should ask `backfillState(for:)` instead —
    /// "waiting" and "in flight" are the two this cannot tell apart, and
    /// conflating them is what left the spinner running forever.
    static func hasQueuedBackfill(for id: String) -> Bool {
        backfillState(for: id) != .none
    }

    static func manualRetriesRemaining(for id: String) -> Int {
        manualRetryBudget().remaining(for: id)
    }

    private static func backfillRequest(id: String) -> BackfillRequest? {
        guard let url = try? backfillManifestURL(for: id),
            let data = try? Data(contentsOf: url)
        else { return nil }
        return try? JSONDecoder().decode(BackfillRequest.self, from: data)
    }

    /// Beside the two queues rather than in `UserDefaults`: this is a record of
    /// money spent, and it belongs in the same container that survives the same
    /// events the queued audio does.
    private static func manualRetryLedgerURL() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("Parley", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent("ManualRetries.json")
    }

    /// An unreadable or absent ledger reads as an empty one. The failure mode
    /// that matters is the other direction: a ledger that could not be read
    /// must not lock somebody out of a recording they have never re-run.
    static func manualRetryBudget() -> ManualRetryBudget {
        guard let url = try? manualRetryLedgerURL(),
            let data = try? Data(contentsOf: url),
            let budget = try? JSONDecoder().decode(ManualRetryBudget.self, from: data)
        else { return ManualRetryBudget() }
        return budget
    }

    private static func spendManualRetry(for id: String) {
        var budget = manualRetryBudget()
        budget.spend(for: id)
        guard let url = try? manualRetryLedgerURL(),
            let data = try? JSONEncoder().encode(budget)
        else { return }
        try? data.write(to: url, options: .atomic)
    }
}

/// Which recordings have a backfill run alive **in this process, right now**.
///
/// The queue's own files cannot answer that. A manifest left behind by a job
/// iOS killed on the lock screen is byte-for-byte the same as one belonging to
/// a job that is mid-transcription, which is why "Re-transcribing…" used to
/// stick until a force-quit: the screen was reading `fileExists` and calling it
/// progress. So the fact lives in memory instead, where it dies with the
/// process that owned it — a run cannot outlive the thing running it, and a
/// relaunch therefore reads `.queued` and offers the retry.
///
/// A locked box rather than an actor because the detail screen asks while it is
/// laying out, and there is nowhere in a `View` to `await` an answer.
private final class RunningBackfills: @unchecked Sendable {
    static let shared = RunningBackfills()
    private let lock = NSLock()
    private var ids: Set<String> = []

    func contains(_ id: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return ids.contains(id)
    }

    func begin(_ id: String) {
        lock.lock()
        ids.insert(id)
        lock.unlock()
    }

    func end(_ id: String) {
        lock.lock()
        ids.remove(id)
        lock.unlock()
    }
}

/// Serializes passes over the backfill queue.
///
/// An actor on its own does not do this. A drain suspends on every network
/// call, and an actor lets the next caller in at every suspension point, so two
/// `drain` bodies would happily interleave inside one actor. The gate therefore
/// keeps a handle on the pass in flight and makes a later caller wait for it
/// before taking its own turn.
///
/// Without it, launch, sign-in, every foregrounding and the Re-transcribe tap
/// can all be walking the same directory at once: the same hour of audio
/// transcribed twice, pushed twice, and — worst — charged twice against
/// `ManualRetryBudget`, so one re-run the user asked for eats two of the three
/// they are allowed. Android has the same gate (`TranscriptBackfiller`'s
/// `drainMutex`); iOS had nothing.
///
/// Chained rather than coalesced, deliberately. A caller that has just written
/// a manifest needs a pass that *starts after* its write, and joining one that
/// took its snapshot of the directory earlier would silently not run it.
private actor BackfillDrainGate {
    static let shared = BackfillDrainGate()

    /// The last pass handed out. A new caller queues behind it rather than
    /// beside it, and the chain is released once nothing is waiting so the
    /// actor does not hold the final pass — and its result — alive for the
    /// life of the process.
    private var tail: Task<MeetingUploader.BackfillResult, Never>?

    func drain(
        cloud: CloudClient,
        onRepaired: (@MainActor @Sendable (String) -> Void)?
    ) async -> MeetingUploader.BackfillResult {
        let previous = tail
        let pass = Task {
            _ = await previous?.value
            return await MeetingUploader.drainBackfills(cloud: cloud, onRepaired: onRepaired)
        }
        tail = pass
        let result = await pass.value
        if tail == pass { tail = nil }
        return result
    }
}
