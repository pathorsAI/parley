import Foundation
import ParleyKit
import SwiftUI

/// Import an audio file the user already has and turn it into a recording —
/// the phone's answer to the desktop History window's "+ Import"
/// (`src/lib/replay/ingest.ts`).
///
/// Four moves, in this order, because each one needs the previous one's output:
/// copy the picked file somewhere we are allowed to keep reading it, decode it
/// to the 16 kHz mono Ogg/Opus the cloud stores, batch-transcribe those bytes,
/// then hand the result to `MeetingUploader` — which files it through the same
/// durable queue a live meeting uses, so a network failure at the last step
/// leaves the recording safe on the phone rather than lost.
///
/// A file longer than one hosted transcription (6 h on the server) is cut
/// into `ImportSplit.partCount` equal parts during that same decode, after the
/// library has asked; each part then goes through transcription and filing
/// on its own, in order, as its own recording titled `<name>（k/n）`. A part
/// that fails stops the run there and leaves the parts before it filed.
///
/// One import at a time. Transcribing an hour of audio is minutes of waiting,
/// and a second import stacked on top of the first would race for the same
/// stage — so `run` refuses while one is in flight and the UI disables its
/// doors from `isRunning`.
@MainActor
final class RecordingImporter: ObservableObject {
    /// Where the import has got to. Mirrors the desktop's `IngestStage`
    /// (decoding → uploading/transcribing), plus the filing step the phone has
    /// and the desktop's replay window does not.
    enum Stage: Equatable {
        case idle
        /// 0…1 of the source file decoded so far.
        case decoding(Double)
        case transcribing
        case filing

        /// What the library says the import is doing right now. Empty when
        /// idle, which the UI never renders.
        var label: String {
            switch self {
            case .idle:
                return ""
            case .decoding:
                return String(localized: "Reading the audio file…")
            case .transcribing:
                return String(
                    localized: "Transcribing — a long recording can take a few minutes.")
            case .filing:
                return String(localized: "Saving it to your library…")
            }
        }
    }

    /// How one import ended. Returned rather than published, because the
    /// library already owns the two places a result belongs on screen: the
    /// error row, and a notice above the list.
    enum Completion: Equatable {
        case landed(title: String, sharedToOrgName: String?)
        /// A split import: every one of `count` parts was filed.
        case landedParts(name: String, count: Int, sharedToOrgName: String?)
        /// User-facing text, ready to show. Never a raw `localizedDescription`.
        case failed(String)
        /// A split import stopped at a part after earlier parts were filed —
        /// user-facing text naming the part, and the library has new rows.
        case partFailed(String)
        /// Nothing was picked — no result to report either way.
        case cancelled
    }

    /// A file the user picked, probed but not yet read. The library holds on
    /// to it while it asks whether to split a long one.
    struct Picked: Identifiable, Equatable {
        let id = UUID()
        let url: URL
        /// The name the user recognises: the file's, minus the extension.
        let name: String
        /// From the container's metadata; nil when it would not say.
        let durationSeconds: Double?

        /// How many recordings this file becomes (`ImportSplit.partCount`).
        var parts: Int { ImportSplit.partCount(durationSeconds: durationSeconds) }

        /// The title part `index` (1-based) of `count` lands under — the
        /// file's name, suffixed only when there is more than one part.
        func title(part index: Int, of count: Int) -> String {
            ImportSplit.partTitle(
                name, part: index, of: count, chinese: RecordingImporter.isChinese)
        }
    }

    /// What `prepare` found.
    enum Preparation: Equatable {
        case ready(Picked)
        case failed(String)
        case cancelled
    }

    /// Which part of a split import is in flight. Nil for an import of one.
    struct PartProgress: Equatable {
        let index: Int
        let count: Int
    }

    @Published private(set) var stage: Stage = .idle
    @Published private(set) var part: PartProgress?

    var isRunning: Bool { stage != .idle }

    /// What the library shows under the progress bar or spinner: the stage,
    /// prefixed with "Part k of n" while a split import works through its
    /// parts one at a time.
    var statusLabel: String {
        guard let part, !isDecoding else { return stage.label }
        return Self.partLabel(part.index, of: part.count) + " · " + stage.label
    }

    private var isDecoding: Bool {
        if case .decoding = stage { return true }
        return false
    }

    /// Take what the picker returned, check it can be imported at all, and
    /// read how long it runs — from the container's metadata, without
    /// decoding, so the library can ask about splitting before anything
    /// expensive starts.
    func prepare(_ result: Result<[URL], Error>, app: AppState) async -> Preparation {
        guard !isRunning else { return .cancelled }

        let picked: URL
        switch result {
        case .success(let urls):
            guard let first = urls.first else { return .cancelled }
            picked = first
        case .failure(let error):
            // Dismissing the picker surfaces as a cancellation, not a fault.
            if (error as? CocoaError)?.code == .userCancelled { return .cancelled }
            return .failed(String(localized: "Parley couldn't open that file."))
        }

        // Batch transcription rides the cloud session, so there is nothing to
        // attempt while signed out — say where to fix it rather than failing at
        // the network a minute of decoding later.
        guard app.signedIn else {
            return .failed(
                String(
                    localized:
                        "Sign in under Settings → Account to transcribe an imported recording."))
        }

        let duration = await Self.probeDuration(picked)
        return .ready(
            Picked(
                url: picked, name: picked.deletingPathExtension().lastPathComponent,
                durationSeconds: duration))
    }

    /// Run one import end to end: one recording, or — for a file longer than
    /// one hosted transcription — `picked.parts` equal recordings, each
    /// transcribed and filed in turn.
    ///
    /// Everything expensive — the copy, the decode, reading the encoded bytes —
    /// happens off the main actor; only the stage transitions and the cloud
    /// calls run here. Temp files are removed on every exit path.
    func run(_ picked: Picked, app: AppState) async -> Completion {
        guard !isRunning else { return .cancelled }

        let workDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(
                "parley-import-\(UUID().uuidString.lowercased())", isDirectory: true)
        // Whatever survives here — the copied source, and the encoded Ogg if it
        // was never filed — goes with the directory, success or failure.
        defer { try? FileManager.default.removeItem(at: workDirectory) }

        stage = .decoding(0)
        part = nil
        defer {
            stage = .idle
            part = nil
        }

        let progress: @Sendable (Double) -> Void = { [weak self] fraction in
            Task { @MainActor in self?.reportDecoding(fraction) }
        }

        // One decode pass cuts every part, so the source is read exactly once.
        let requested = picked.parts
        let partURL: @Sendable (Int) -> URL = { index in
            workDirectory.appendingPathComponent("import-\(index + 1).ogg")
        }
        let durations: [UInt64]
        do {
            let local = try await Self.copyIn(picked: picked.url, workDirectory: workDirectory)
            durations = try await Self.decode(
                source: local, parts: requested, destination: partURL, onProgress: progress)
        } catch let error as AudioFileDecoderError {
            return .failed(Self.message(for: error))
        } catch {
            // Failing to copy is the same story to the user as failing to
            // decode: this file did not open.
            return .failed(Self.unreadableMessage)
        }

        // A source shorter than its container claimed can yield fewer parts;
        // the titles count what was really cut.
        let count = durations.count
        var lastOutcome: MeetingUploader.Outcome?
        for (offset, durationMs) in durations.enumerated() {
            let index = offset + 1
            if count > 1 { part = PartProgress(index: index, count: count) }
            let result = await transcribeAndFile(
                ogg: partURL(offset),
                durationMs: durationMs,
                title: picked.title(part: index, of: count),
                resumeKey: Self.resumeKey(for: picked.url, part: index, of: count),
                app: app)
            switch result {
            case .success(let outcome):
                lastOutcome = outcome
            case .failure(let failure):
                guard count > 1 else { return .failed(failure.message) }
                let message = String(
                    localized: "Part \(index) of \(count) failed: \(failure.message)")
                // Parts already filed stay filed; the library reloads to show them.
                return offset > 0 ? .partFailed(message) : .failed(message)
            }
        }

        guard let lastOutcome else { return .failed(Self.unreadableMessage) }
        if count > 1 {
            return .landedParts(
                name: picked.name, count: count, sharedToOrgName: lastOutcome.sharedToOrgName)
        }
        return .landed(title: lastOutcome.title, sharedToOrgName: lastOutcome.sharedToOrgName)
    }

    /// A step's user-facing failure text, carried through `Result`.
    struct Failure: Error {
        let message: String
    }

    /// Transcribe one encoded Ogg and file it as one recording — everything an
    /// import of one did after decoding, now run once per part.
    private func transcribeAndFile(
        ogg: URL, durationMs: UInt64, title: String, resumeKey: String, app: AppState
    ) async -> Result<MeetingUploader.Outcome, Failure> {
        // The same bar the live path holds a recording to, so importing a
        // two-second voice memo cannot sneak past what recording one cannot.
        guard Double(durationMs) >= MeetingUploader.minimumDurationMs else {
            return .failure(Failure(message: Self.tooShortMessage))
        }

        stage = .transcribing
        let transcript: BatchTranscriptionResult
        do {
            let bytes = try await Self.read(ogg)
            transcript = try await Self.transcribe(bytes, resumeKey: resumeKey, cloud: app.cloud)
        } catch let error as CloudError {
            return .failure(Failure(message: error.batchTranscriptionMessage))
        } catch let error as BatchTranscriptionError {
            // The job itself failed or never settled — a different story from
            // the HTTP call failing, and it carries its own localized wording.
            return .failure(Failure(message: error.message))
        } catch {
            return .failure(
                Failure(
                    message: String(
                        localized:
                            "Transcription didn't finish. Check your network and try the import again."
                    )))
        }

        stage = .filing
        do {
            let outcome = try await MeetingUploader.fileImported(
                oggAt: ogg,
                durationMs: Double(durationMs),
                segments: transcript.segments,
                title: title,
                cloud: app.cloud,
                defaultSave: app.defaultSave,
                orgs: app.orgs)
            app.refreshUploadCounts()
            guard let outcome else { return .failure(Failure(message: Self.tooShortMessage)) }
            return .success(outcome)
        } catch let error as CloudError where error.status == 402 {
            app.refreshUploadCounts()
            return .failure(
                Failure(
                    message: String(
                        localized:
                            "You're out of quota. The recording is safe on this phone and will sync once the quota resets."
                    )))
        } catch {
            // Past `fileImported`'s persist step the audio and its transcript
            // are in the durable queue; the next foregrounding or network change retries them.
            app.refreshUploadCounts()
            return .failure(
                Failure(
                    message: String(
                        localized:
                            "Sync failed for now. The recording is safe on this phone and will retry automatically."
                    )))
        }
    }

    // MARK: split wording

    /// Whether the app is running in Chinese — decides the title suffix's
    /// brackets, the same check the rest of the app makes.
    nonisolated static var isChinese: Bool {
        (Bundle.main.preferredLocalizations.first ?? "en").hasPrefix("zh")
    }

    /// "Part 2 of 3" / 「第 2/3 段」.
    static func partLabel(_ index: Int, of count: Int) -> String {
        String(localized: "Part \(index) of \(count)")
    }

    /// A length the way the split confirmation says it: 「7 小時 12 分」,
    /// "7 hr 12 min".
    static func durationText(_ seconds: Double) -> String {
        let (hours, minutes) = ImportSplit.hoursAndMinutes(seconds)
        switch (hours, minutes) {
        case (0, let m): return String(localized: "\(m) min")
        case (let h, 0): return String(localized: "\(h) hr")
        case (let h, let m): return String(localized: "\(h) hr \(m) min")
        }
    }

    /// Decoding reports continuously; SwiftUI only needs the steps a person can
    /// see. Anything smaller than a percent, or arriving after the stage has
    /// moved on, is dropped.
    private func reportDecoding(_ fraction: Double) {
        guard case .decoding(let shown) = stage else { return }
        let clamped = min(max(fraction, 0), 1)
        guard clamped >= shown + 0.01 || clamped >= 1 else { return }
        stage = .decoding(clamped)
    }

    // MARK: off the main actor

    /// A URL from the Files picker is a loan, not a handle: it is readable only
    /// between `startAccessingSecurityScopedResource` and its stop, and a file
    /// living in iCloud Drive or another app's container may stop being vended
    /// the moment the picker closes. So take a copy inside our own temp
    /// directory and do every later step against that.
    ///
    /// The copy keeps the original file name, extension included —
    /// `AVAudioFile` uses it to pick a reader.
    private nonisolated static func copyIn(picked: URL, workDirectory: URL) async throws -> URL {
        try await Task.detached(priority: .userInitiated) {
            try FileManager.default.createDirectory(
                at: workDirectory, withIntermediateDirectories: true)

            let scoped = picked.startAccessingSecurityScopedResource()
            defer { if scoped { picked.stopAccessingSecurityScopedResource() } }

            let name = picked.lastPathComponent.isEmpty ? "import" : picked.lastPathComponent
            let local = workDirectory.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: local.path) {
                try FileManager.default.removeItem(at: local)
            }
            try FileManager.default.copyItem(at: picked, to: local)
            return local
        }.value
    }

    private nonisolated static func decode(
        source: URL, parts: Int, destination: @escaping @Sendable (Int) -> URL,
        onProgress: @escaping @Sendable (Double) -> Void
    ) async throws -> [UInt64] {
        try await Task.detached(priority: .userInitiated) {
            try AudioFileDecoder.encodeToOggOpusParts(
                source: source, parts: parts, destination: destination, onProgress: onProgress)
        }.value
    }

    /// The picked file's length from its metadata, read under the picker's
    /// security scope. Nil when the container will not say — the import then
    /// goes ahead as one recording, as it always has.
    private nonisolated static func probeDuration(_ picked: URL) async -> Double? {
        await Task.detached(priority: .userInitiated) {
            let scoped = picked.startAccessingSecurityScopedResource()
            defer { if scoped { picked.stopAccessingSecurityScopedResource() } }
            return AudioFileDecoder.durationSeconds(of: picked)
        }.value
    }

    /// Upload and transcribe under a background task, remembering the job so
    /// an import the user walked away from can be picked up again: importing
    /// the same file a second time resumes the job instead of paying for a
    /// second one. No language hints — the phone has no STT language setting,
    /// so the cloud auto-detects, exactly as the desktop does with an empty
    /// list.
    private nonisolated static func transcribe(
        _ bytes: Data, resumeKey: String, cloud: CloudClient
    ) async throws -> BatchTranscriptionResult {
        let terms = LexiconStore.recognitionTerms()
        return try await BackgroundGrace.run("import-transcription") {
            try await BatchTranscriber(service: cloud)
                .transcribe(
                    audio: bytes, diarization: true, languages: [], terms: terms,
                    resume: BatchResume(store: MeetingUploader.batchJobStore, key: resumeKey))
        }
    }

    /// An import has no recording id until it is filed, so the job is keyed by
    /// the file's name — and, for a split import, the part; the Ogg's byte
    /// count, checked by `BatchJobRecord`, keeps a different file under the
    /// same name from inheriting it.
    private nonisolated static func resumeKey(for picked: URL, part: Int, of count: Int) -> String {
        let key = "import:" + picked.lastPathComponent
        return count > 1 ? key + "#\(part)/\(count)" : key
    }

    private nonisolated static func read(_ url: URL) async throws -> Data {
        try await Task.detached(priority: .userInitiated) {
            try Data(contentsOf: url)
        }.value
    }

    // MARK: failure copy

    private nonisolated static var tooShortMessage: String {
        String(
            localized: "That file is too short to keep — a recording needs at least 2 seconds.")
    }

    /// Deliberately does not repeat the decoder's own `unreadable(_:)` payload:
    /// that string is a CoreAudio status for the log, not something to read.
    private nonisolated static var unreadableMessage: String {
        String(
            localized: "Parley couldn't read that audio file. Try converting it to m4a or wav first."
        )
    }

    private nonisolated static func message(for error: AudioFileDecoderError) -> String {
        switch error {
        case .unreadable:
            return unreadableMessage
        case .empty:
            return String(localized: "That file has no audio in it.")
        }
    }
}
