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
        /// User-facing text, ready to show. Never a raw `localizedDescription`.
        case failed(String)
        /// Nothing was picked — no result to report either way.
        case cancelled
    }

    @Published private(set) var stage: Stage = .idle

    var isRunning: Bool { stage != .idle }

    /// Run one import end to end.
    ///
    /// Everything expensive — the copy, the decode, reading the encoded bytes —
    /// happens off the main actor; only the stage transitions and the cloud
    /// calls run here. Temp files are removed on every exit path.
    func run(_ result: Result<[URL], Error>, app: AppState) async -> Completion {
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

        // The name the user recognises: the file's, minus the extension.
        let title = picked.deletingPathExtension().lastPathComponent

        let workDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(
                "parley-import-\(UUID().uuidString.lowercased())", isDirectory: true)
        // Whatever survives here — the copied source, and the encoded Ogg if it
        // was never filed — goes with the directory, success or failure.
        defer { try? FileManager.default.removeItem(at: workDirectory) }

        stage = .decoding(0)
        defer { stage = .idle }

        let progress: @Sendable (Double) -> Void = { [weak self] fraction in
            Task { @MainActor in self?.reportDecoding(fraction) }
        }

        let ogg = workDirectory.appendingPathComponent("import.ogg")
        let durationMs: UInt64
        do {
            let local = try await Self.copyIn(picked: picked, workDirectory: workDirectory)
            durationMs = try await Self.decode(
                source: local, destination: ogg, onProgress: progress)
        } catch let error as AudioFileDecoderError {
            return .failed(Self.message(for: error))
        } catch {
            // Failing to copy is the same story to the user as failing to
            // decode: this file did not open.
            return .failed(Self.unreadableMessage)
        }

        // The same bar the live path holds a recording to, so importing a
        // two-second voice memo cannot sneak past what recording one cannot.
        guard Double(durationMs) >= MeetingUploader.minimumDurationMs else {
            return .failed(Self.tooShortMessage)
        }

        stage = .transcribing
        let transcript: BatchTranscriptionResult
        do {
            let bytes = try await Self.read(ogg)
            // No language hints: the phone has no STT language setting, so the
            // cloud auto-detects, exactly as the desktop does with an empty list.
            transcript = try await BatchTranscriber(service: app.cloud)
                .transcribe(audio: bytes, diarization: true, languageHints: [])
        } catch let error as CloudError {
            return .failed(error.batchTranscriptionMessage)
        } catch let error as BatchTranscriptionError {
            // The job itself failed or never settled — a different story from
            // the HTTP call failing, and it carries its own localized wording.
            return .failed(error.message)
        } catch {
            return .failed(
                String(
                    localized:
                        "Transcription didn't finish. Check your network and try the import again."))
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
            app.pendingUploadCount = MeetingUploader.pendingCount
            guard let outcome else { return .failed(Self.tooShortMessage) }
            return .landed(title: outcome.title, sharedToOrgName: outcome.sharedToOrgName)
        } catch let error as CloudError where error.status == 402 {
            app.pendingUploadCount = MeetingUploader.pendingCount
            return .failed(
                String(
                    localized:
                        "You're out of quota. The recording is safe on this phone and will sync once the quota resets."
                ))
        } catch {
            // Past `fileImported`'s persist step the audio and its transcript
            // are in the durable queue; the next foreground launch retries them.
            app.pendingUploadCount = MeetingUploader.pendingCount
            return .failed(
                String(
                    localized:
                        "Sync failed for now. The recording is safe on this phone and will retry automatically."
                ))
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
        source: URL, destination: URL, onProgress: @escaping @Sendable (Double) -> Void
    ) async throws -> UInt64 {
        try await Task.detached(priority: .userInitiated) {
            try AudioFileDecoder.encodeToOggOpus(
                source: source, destination: destination, onProgress: onProgress)
        }.value
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
