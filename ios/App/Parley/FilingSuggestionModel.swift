import Foundation
import ParleyKit
import SwiftUI

/// The post-transcription filing suggestion for the recording that just
/// finished: what it should be CALLED, and where it should LIVE.
///
/// The phone names every recording after the clock — "Meeting Sep 7, 3:20 PM" —
/// and offered no way to change it, so a library of rows nobody can tell apart
/// was a dead end rather than an annoyance. Neither answer can be produced any
/// earlier than this: a name worth having needs a transcript to read, and the
/// right folder needs somebody to know what the meeting was about. So the offer
/// arrives at the end of the recording, on the screen the user is still looking
/// at.
///
/// It waits for the UPLOAD to settle, not for the microphone to stop. A rename
/// or a re-file is a write against a recording the server has to already hold;
/// running the pass on a recording that has not landed yet would produce an
/// answer with nothing to apply it to.
///
/// Every part of it is best-effort. A failed folder listing, a failed pass, a
/// failed push: each leaves the recording exactly as the upload left it, and
/// only a write the user explicitly asked for ever says so. Finishing a meeting
/// must not get worse because this feature exists.
///
/// ## Acceptance is derived, never stored
///
/// `proposedTitle` and `proposedFolders` compare the suggestion against the
/// name and folder the recording currently carries, and each retires itself
/// once it has nothing left to offer. An "applied" flag would be a second copy
/// of that same fact, free to drift — a title accepted here and then changed
/// elsewhere would leave a row still claiming there is something to accept.
/// Deriving it means every route to the same outcome retires the same row.
@MainActor
final class FilingSuggestionModel: ObservableObject {

    /// Which row is mid-push. One at a time, and not a `Bool` per row: both
    /// rows read-modify-write the same meta, so two in flight together let the
    /// slower one push a copy it read before the faster one landed — silently
    /// undoing it.
    enum Writing: Equatable {
        case nothing
        case title
        /// Keyed by `key(for:)` rather than by the value, so the row knows
        /// which of its own chips is busy.
        case folder(String)
    }

    @Published private(set) var suggestion: FilingSuggestion?
    /// What the recording carries in the cloud right now. Written by the pass
    /// from the upload's own outcome, then by each accepted push — this is the
    /// live state the rows are derived against.
    @Published private(set) var currentTitle = ""
    @Published private(set) var currentFolderId: String?
    @Published private(set) var writing: Writing = .nothing
    /// A push the user asked for did not land. Deliberately not raised for the
    /// pass itself: nobody asked for that one, so its failure is silence.
    @Published private(set) var writeFailed = false

    /// The recording the visible suggestion belongs to.
    private var recordingId: String?
    /// The recording the pass has already been spent on. Kept separately from
    /// `recordingId`, and NOT cleared by `forget()`: a dismissed card must stay
    /// dismissed, and this view is re-entered every time the tab comes back.
    private var consideredId: String?
    private var pass: Task<Void, Never>?

    // MARK: what is left to offer

    /// The proposed name, or nil when there is nothing left to propose — an
    /// empty suggestion (the model had nothing better), or a recording that is
    /// already called that.
    var proposedTitle: String? {
        guard let suggestion else { return nil }
        let proposed = suggestion.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !proposed.isEmpty else { return nil }
        guard proposed != currentTitle.trimmingCharacters(in: .whitespacesAndNewlines) else {
            return nil
        }
        return proposed
    }

    /// The folders still worth offering. The chip pointing at the folder the
    /// recording is already in is dropped — but a `nil` id is compared out
    /// explicitly rather than by equality, because `nil` is also "the personal
    /// root", and an unfiled recording is exactly the case a brand-new folder
    /// gets proposed for.
    var proposedFolders: [FilingFolderSuggestion] {
        guard let suggestion else { return [] }
        let live = suggestion.folders.filter { folder in
            folder.folderId == nil || folder.folderId != currentFolderId
        }
        return Array(live.prefix(3))
    }

    /// The card draws nothing once both rows are spent.
    var hasSomethingToOffer: Bool {
        suggestion != nil && (proposedTitle != nil || !proposedFolders.isEmpty)
    }

    var isWriting: Bool { writing != .nothing }

    var isWritingTitle: Bool { writing == .title }

    func isWritingFolder(_ folder: FilingFolderSuggestion) -> Bool {
        writing == .folder(Self.key(for: folder))
    }

    /// Identity for a candidate folder. A folder that does not exist yet has no
    /// id, so it is keyed by the name it would be created under.
    static func key(for folder: FilingFolderSuggestion) -> String {
        folder.folderId ?? "new:\(folder.name)"
    }

    // MARK: the pass

    /// Run the filing pass for a recording whose upload has settled. Safe to
    /// call more than once for the same recording: only the first call spends
    /// the pass.
    ///
    /// The work is owned by this object rather than by the view's `task`, so
    /// switching tabs mid-pass does not cancel it and land the user back on a
    /// screen with nothing to show.
    func consider(_ settled: MeetingRecorder.Settled, app: AppState) {
        guard consideredId != settled.id else { return }
        consideredId = settled.id
        pass = Task { [weak self] in
            await self?.run(settled, app: app)
        }
    }

    /// Drop the suggestion without writing anything. Used when a new meeting
    /// starts: the card belongs to the recording that just ended, and leaving
    /// it up over the next one would offer a rename for a recording the user
    /// has moved on from.
    func forget() {
        pass?.cancel()
        pass = nil
        suggestion = nil
        recordingId = nil
        currentTitle = ""
        currentFolderId = nil
        writing = .nothing
        writeFailed = false
    }

    private func run(_ settled: MeetingRecorder.Settled, app: AppState) async {
        guard app.signedIn else { return }
        // Skip a recording that was auto-shared to an organization. The copy
        // the user will actually open is the org one, and the phone has no org
        // rename endpoint at all — a read-only org replay can be neither
        // renamed nor re-filed, so the suggestion would be spent on something
        // nobody can act on. The desktop skips the same case for the same
        // reason.
        guard !app.defaultSave.isOrg else { return }

        // Only what was actually said. A recording that produced no final
        // transcript has nothing for the pass to read, and asking anyway spends
        // quota to be told so.
        let spoken = settled.segments.filter { segment in
            segment.isFinal
                && !segment.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        guard !spoken.isEmpty else { return }

        do {
            // Personal folders only: an org folder is not somewhere this
            // recording can be moved to from here.
            let all = try await app.cloud.listFolders()
            let folders = all.filter { $0.orgId == nil }
            let proposal = try await FilingSuggester.suggest(
                segments: spoken,
                // A live meeting on the phone carries no speaker names — the
                // uploader writes an empty map — so there is nothing to hand
                // the pass beyond the transcript itself.
                speakerNames: [:],
                currentTitle: settled.title,
                folders: folders,
                cloud: app.cloud)
            guard let proposal else { return }
            // A new meeting cancels the pass through `forget()`. Nothing after
            // an await is guaranteed to still be wanted, and a card that
            // reappeared over the recording that replaced it would be offering
            // a rename for the wrong meeting.
            guard !Task.isCancelled else { return }
            recordingId = settled.id
            currentTitle = settled.title
            currentFolderId = settled.folderId
            writeFailed = false
            suggestion = proposal
        } catch {
            // Best-effort by design: the recording is already safely in the
            // cloud under its clock name, and a suggestion nobody asked for is
            // not worth an error on the record screen.
        }
    }

    // MARK: accepting

    /// Rename the recording to the proposed name. The card is not dismissed:
    /// the title row retires itself once the name matches, and the folder rows
    /// are still worth a tap.
    func acceptTitle(app: AppState) async {
        guard !isWriting, let id = recordingId, let proposed = proposedTitle else { return }
        writing = .title
        writeFailed = false
        defer { writing = .nothing }
        do {
            try await Self.write(id: id, cloud: app.cloud) { meta in
                meta.title = proposed
            }
            currentTitle = proposed
        } catch {
            writeFailed = true
        }
    }

    /// File the recording into a candidate folder, creating that folder first
    /// when it does not exist yet.
    ///
    /// The creation happens HERE and nowhere earlier. Merely showing a chip for
    /// a folder that does not exist must not bring it into being — the user
    /// would end up with an empty folder for every candidate the pass ever
    /// proposed and never accepted.
    func acceptFolder(_ folder: FilingFolderSuggestion, app: AppState) async {
        guard !isWriting, let id = recordingId else { return }
        writing = .folder(Self.key(for: folder))
        writeFailed = false
        defer { writing = .nothing }
        do {
            let targetId: String
            if let existing = folder.folderId {
                targetId = existing
            } else {
                let created = try await app.cloud.createFolder(name: folder.name)
                targetId = created.id
            }
            try await Self.write(id: id, cloud: app.cloud) { meta in
                meta.folderId = targetId
            }
            currentFolderId = targetId
        } catch {
            writeFailed = true
        }
    }

    /// The user said no. The card goes at once — a dismiss that waits on the
    /// network reads as a broken button — and the flag is written behind it.
    func dismiss(app: AppState) {
        let id = recordingId
        let cloud = app.cloud
        forget()
        guard let id else { return }
        Task {
            // Nothing is accepted here, but `filingSuggested` still has to
            // land: see `write(id:cloud:apply:)`. Failure is ignored, because
            // the worst case is the desktop asking once more about a recording
            // that was already dealt with on the phone.
            try? await Self.write(id: id, cloud: cloud) { _ in }
        }
    }

    /// One read-modify-write against the recording's meta, then a push of the
    /// meta and the summary together — the idiom `LibraryView.moveToFolder`
    /// uses, for the same reason: the library lists the summary and the report
    /// reads the meta, so a change written to only one of them is a recording
    /// that disagrees with itself.
    ///
    /// Every write through here sets `filingSuggested`, whatever it was called
    /// for. The desktop reads that flag to decide whether its own filing pass
    /// has already been spent on a recording; without it, a recording renamed
    /// or dismissed on the phone would be asked about all over again the next
    /// time it is opened on a Mac.
    private static func write(
        id: String,
        cloud: CloudClient,
        apply: (inout RecordingMeta) -> Void
    ) async throws {
        var meta = try await cloud.recordingMeta(id: id)
        apply(&meta)
        meta.filingSuggested = true
        try await cloud.pushRecording(id: id, summary: summary(from: meta), meta: meta)
    }

    /// Rebuild the library row from the meta being pushed, the way the desktop
    /// derives its summary from the entry on every save. The summary is a
    /// projection of the meta and nothing else — fetching one separately and
    /// re-sending it is what lets a title land in the report and not in the
    /// list.
    private static func summary(from meta: RecordingMeta) -> CloudRecordingSummary {
        let finals = meta.segments.filter { $0.isFinal }
        let speakers = Set(finals.map { "\($0.source)-\($0.speaker)" }).count
        let snippet = finals.prefix(3).map { $0.text }.joined(separator: " ").prefix(120)
        let audio = meta.raw["audio"] as? String
        return CloudRecordingSummary(
            id: meta.id,
            title: meta.title,
            source: meta.raw["source"] as? String ?? "live",
            createdAt: meta.createdAt,
            durationMs: meta.durationMs,
            speakerCount: max(speakers, finals.isEmpty ? 0 : 1),
            findingsCount: (meta.raw["findings"] as? [Any])?.count ?? 0,
            actionItemsCount: (meta.raw["actionItems"] as? [Any])?.count ?? 0,
            hasAudio: !(audio ?? "").isEmpty,
            snippet: String(snippet),
            folderId: meta.folderId,
            // Server push time is the server's to set, exactly as the upload
            // leaves it.
            updatedAt: nil)
    }
}
