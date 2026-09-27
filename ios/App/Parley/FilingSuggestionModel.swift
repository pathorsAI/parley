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
/// ## An answered offer is retired, not compared away
///
/// Both halves used to be derived purely by comparison against what the
/// recording currently is, and neither comparison can express "the user has
/// already answered this".
///
/// `proposedTitle` compared the suggestion against `currentTitle` and retired
/// itself when they matched, which is only an answer for the user who takes the
/// proposed name verbatim. Someone who answers with a THIRD string — their own,
/// typed in the Adjust sheet — leaves the two names unequal forever, so the
/// block redrew with the model's name over the top of the one they had just
/// saved, and offered to write it for them.
///
/// `proposedFolders` drops the chip pointing at the folder the recording is
/// already in, which retires the accepted candidate and nothing else. The
/// runners-up the pass also proposed outlive the accept, so the block redrew as
/// a bare folder line for a question already answered — and a candidate with no
/// id, meaning "create a folder called X", is deliberately not compared away at
/// all, because `nil` is also "the personal root". Accepting a new folder left
/// that same candidate on offer, and a second `Save as suggested` created a
/// SECOND folder under the same name.
///
/// So each half records what the user did — `titleAnswered`, `folderAnswered` —
/// instead of inferring it from what the recording ended up being. Both are set
/// by `apply`, which every accept route goes through, and only once its push
/// has returned: a write that threw leaves the offer open, because it is still
/// worth taking. `forget()` clears them with the rest of the offer, because the
/// next recording gets its own to answer.
///
/// ## Two screens, two kinds of recording
///
/// The record screen runs the pass itself (`consider`) for the recording that
/// just landed. The recording screen shows a suggestion that is already
/// *pending* on the recording (`present`): a desktop pass leaves one in the
/// synced meta's `filingSuggestion`, and the bundled sample ships with one. The
/// writes differ only in where they land — `Target` — and both answer the
/// offer the same way: a cloud recording's meta gets `filingSuggestion: null`
/// and `filingSuggested: true` (the desktop's "resolved"), the sample's local
/// entry gets `suggestionPending = false`.
@MainActor
final class FilingSuggestionModel: ObservableObject {

    /// Where an accepted suggestion is written.
    enum Target: Equatable {
        /// A personal cloud recording: one read-modify-write of its meta.
        case cloud(id: String)
        /// The bundled sample: `SampleRecordingStore`, on this phone only. A
        /// new folder is still created in the cloud — it is a real folder the
        /// user now has — and only the filing itself stays local.
        case sample
    }

    @Published private(set) var suggestion: FilingSuggestion?
    /// What the recording carries in the cloud right now. Written by the pass
    /// from the upload's own outcome, then by each accepted push — this is the
    /// live state the block is derived against.
    @Published private(set) var currentTitle = ""
    @Published private(set) var currentFolderId: String?
    /// The folders the user already has, as the pass listed them. Kept so the
    /// Adjust sheet can offer them without a second `listFolders()` — the pass
    /// has to fetch the registry anyway to give the model a menu to choose
    /// from, and a sheet that fetched it again would show a different list on a
    /// flaky network than the one the suggestion was made against.
    @Published private(set) var existingFolders: [CloudFolder] = []
    /// A push is in flight. One at a time, and not one flag per action: every
    /// accept read-modify-writes the same meta, so two together let the slower
    /// one push a copy it read before the faster one landed — silently undoing
    /// it.
    @Published private(set) var isWriting = false
    /// A push the user asked for did not land. Deliberately not raised for the
    /// pass itself: nobody asked for that one, so its failure is silence.
    @Published private(set) var writeFailed = false

    /// Where the visible suggestion's answer is written. nil = nothing on offer.
    private var target: Target?
    /// Told after each write that landed: the new title (if it changed), the
    /// folder filed into (if it changed), and a folder created for it (if one
    /// was). The recording screen keeps its title, its folder and its folder
    /// list in step with this.
    var onApplied: ((_ title: String?, _ folderId: String?, _ created: CloudFolder?) -> Void)?
    /// Told once the offer is fully answered — accepted in full, or skipped —
    /// so a screen that presented it from the recording's own data stops
    /// presenting it.
    var onRetired: (() -> Void)?
    /// The recording the pass has already been spent on. Kept separately from
    /// `target`, and NOT cleared by `forget()`: a dismissed card must stay
    /// dismissed, and this view is re-entered every time the tab comes back.
    private var consideredId: String?
    /// The user has answered the name half of this offer — with the proposed
    /// name or with one of their own, it makes no difference. Set by `apply`,
    /// which every accept route goes through, and cleared by `forget()` with
    /// the rest of the offer.
    private var titleAnswered = false
    /// The user has answered the home half of this offer — by taking the
    /// proposed folder, by picking a different one in the Adjust sheet, or by
    /// having a new one created for them. Set by `apply` alongside its twin,
    /// and cleared by `forget()` with the rest of the offer.
    private var folderAnswered = false
    private var pass: Task<Void, Never>?

    // MARK: what is left to offer

    /// The proposed name, or nil when there is nothing left to propose — an
    /// offer the user has already answered, an empty suggestion (the model had
    /// nothing better), or a recording that is already called that.
    var proposedTitle: String? {
        guard !titleAnswered else { return nil }
        guard let suggestion else { return nil }
        let proposed = suggestion.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !proposed.isEmpty else { return nil }
        guard proposed != currentTitle.trimmingCharacters(in: .whitespacesAndNewlines) else {
            return nil
        }
        return proposed
    }

    /// The folders still worth offering, or none at all once the user has said
    /// where this recording lives — every candidate goes, runners-up included,
    /// because they were alternative answers to a question that now has one.
    ///
    /// The comparison below still runs, for the recording that is already in a
    /// proposed folder before anyone has answered anything: the chip pointing at
    /// the folder it is in is dropped, but a `nil` id is compared out explicitly
    /// rather than by equality, because `nil` is also "the personal root", and
    /// an unfiled recording is exactly the case a brand-new folder gets proposed
    /// for. What that same `nil` cannot do is retire itself once accepted —
    /// which is `folderAnswered`'s job, and why creating the folder twice is no
    /// longer a double tap away.
    var proposedFolders: [FilingFolderSuggestion] {
        guard !folderAnswered else { return [] }
        guard let suggestion else { return [] }
        let live = suggestion.folders.filter { folder in
            folder.folderId == nil || folder.folderId != currentFolderId
        }
        return Array(live.prefix(3))
    }

    /// The block draws nothing once neither half is still on offer. Asking the
    /// two halves is the whole test now that both can retire themselves: each
    /// already answers nil for a suggestion that never arrived, so a separate
    /// `suggestion != nil` would only be a second place for the rule to live.
    var hasSomethingToOffer: Bool {
        proposedTitle != nil || !proposedFolders.isEmpty
    }

    /// The folder the one-tap accept files into: the model's best answer, which
    /// is the only one the block shows. The rest are in the Adjust sheet.
    var proposedFolder: FilingFolderSuggestion? { proposedFolders.first }

    /// What the title field starts with: the proposed name while it is still on
    /// offer, the recording's own once it has been answered.
    var editableTitle: String { proposedTitle ?? currentTitle }

    /// Whether the name half has been answered, so the card can say "renamed"
    /// instead of offering it again.
    var titleWasAnswered: Bool { titleAnswered }

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
    /// starts — the card belongs to the recording that just ended, and leaving
    /// it up over the next one would offer a rename for a recording the user
    /// has moved on from — and by the routes that have finished with the offer
    /// AFTER their own write landed (`dismiss`, the Adjust sheet's Save).
    ///
    /// It clears `target`, so a write ordered after this one is a no-op:
    /// retire the offer once the push it was answered with has returned, never
    /// before.
    func forget() {
        pass?.cancel()
        pass = nil
        suggestion = nil
        target = nil
        currentTitle = ""
        currentFolderId = nil
        existingFolders = []
        titleAnswered = false
        folderAnswered = false
        isWriting = false
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
            target = .cloud(id: settled.id)
            currentTitle = settled.title
            currentFolderId = settled.folderId
            existingFolders = folders
            writeFailed = false
            suggestion = proposal
        } catch {
            // Best-effort by design: the recording is already safely in the
            // cloud under its clock name, and a suggestion nobody asked for is
            // not worth an error on the record screen.
        }
    }

    // MARK: a suggestion that is already pending

    /// Offer a suggestion the recording already carries — the recording
    /// screen's route in. Safe to call again with a fuller folder list (the
    /// folders arrive after the meta): an offer the user has started to answer
    /// is left alone.
    func present(
        _ suggestion: FilingSuggestion, currentTitle: String, currentFolderId: String?,
        folders: [CloudFolder], target: Target
    ) {
        guard !isWriting, !titleAnswered, !folderAnswered else { return }
        self.target = target
        self.suggestion = suggestion
        self.currentTitle = currentTitle
        self.currentFolderId = currentFolderId
        existingFolders = folders
        writeFailed = false
    }

    // MARK: accepting

    /// The inline title field's Return: rename, and leave the folder half on
    /// offer.
    func rename(to title: String, app: AppState) async {
        await apply(title: title, folder: nil, app: app)
    }

    /// Take the suggestion as offered: the proposed name and the best proposed
    /// folder, in one go. Whichever of the two the pass had nothing to say
    /// about is simply left alone.
    func acceptSuggested(app: AppState) async {
        await apply(title: proposedTitle, folder: proposedFolder, app: app)
    }

    /// Rename the recording and file it, either or both. `nil` means "leave
    /// that one as it is"; a title that matches what the recording is already
    /// called, or a folder it is already in, is dropped the same way.
    ///
    /// ONE read-modify-write for both, rather than a rename followed by a move:
    /// the two would each read the meta and push it back, and the second push
    /// would carry a copy read before the first landed — undoing it. That is
    /// also why this is the only accept path, and why the Adjust sheet hands
    /// its two edits over together instead of applying them one at a time.
    ///
    /// A folder that does not exist yet is created HERE and nowhere earlier.
    /// Merely offering a candidate must not bring it into being — the user
    /// would end up with an empty folder for every candidate the pass ever
    /// proposed and never accepted.
    ///
    /// - Returns: whether a push landed. The Adjust sheet needs to tell a Save
    ///   that wrote — and so carried `filingSuggested` with it — apart from a
    ///   Save that found nothing to change.
    @discardableResult
    func apply(title: String?, folder: FilingFolderSuggestion?, app: AppState) async -> Bool {
        guard !isWriting, let target else { return false }
        var newTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        if newTitle?.isEmpty == true || newTitle == currentTitle { newTitle = nil }
        var newFolder = folder
        if let alreadyThere = folder?.folderId, alreadyThere == currentFolderId { newFolder = nil }
        guard newTitle != nil || newFolder != nil else { return false }
        isWriting = true
        writeFailed = false
        defer { isWriting = false }
        do {
            var targetId: String?
            var created: CloudFolder?
            if let newFolder {
                if let existing = newFolder.folderId {
                    targetId = existing
                } else {
                    let folder = try await app.cloud.createFolder(name: newFolder.name)
                    created = folder
                    targetId = folder.id
                    existingFolders.append(folder)
                }
            }
            switch target {
            case .cloud(let id):
                try await Self.write(id: id, cloud: app.cloud) { meta in
                    if let newTitle { meta.title = newTitle }
                    if let targetId { meta.folderId = targetId }
                }
            case .sample:
                let store = SampleRecordingStore.shared
                if let newTitle { store.setTitle(newTitle) }
                if let targetId { store.setFolder(targetId) }
            }
            if let newTitle {
                currentTitle = newTitle
                // The name half is settled, whatever name it settled on. Only
                // once the push is back: a write that threw leaves the offer
                // open, because it is still worth taking.
                titleAnswered = true
            }
            if let targetId {
                GettingStartedStore.shared.mark(.filed)
                currentFolderId = targetId
                // The home half is settled, wherever it settled — including the
                // folder created a moment ago, whose id came back from
                // `createFolder`. Retiring it here is what stops a second tap
                // creating a second folder under that same name. After the
                // push, like the name: a write that threw is still worth
                // retrying.
                folderAnswered = true
            }
            onApplied?(newTitle, targetId, created)
            if !hasSomethingToOffer {
                if target == .sample { SampleRecordingStore.shared.answerSuggestion() }
                onRetired?()
            }
            return true
        } catch {
            writeFailed = true
            return false
        }
    }

    /// The user said no. The card goes at once — a dismiss that waits on the
    /// network reads as a broken button — and the flag is written behind it.
    func dismiss(app: AppState) {
        let target = self.target
        let cloud = app.cloud
        forget()
        onRetired?()
        guard case .cloud(let id) = target else {
            if target == .sample { SampleRecordingStore.shared.answerSuggestion() }
            return
        }
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
        // Answered, whichever way: the desktop reads a non-null suggestion as
        // still waiting, and would offer it again on the Mac.
        meta.filingSuggestion = nil
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

    #if DEBUG
        /// ScreenshotDemo: the state the block is worth capturing in — a
        /// recording that has landed under its clock name, with a better name
        /// and a home on offer. `target` is deliberately left nil, so a
        /// tap on the demo build's own buttons writes nothing: there is no
        /// account behind the fixtures to write to.
        func seedDemo(
            suggestion: FilingSuggestion, currentTitle: String, folders: [CloudFolder]
        ) {
            self.suggestion = suggestion
            self.currentTitle = currentTitle
            currentFolderId = nil
            existingFolders = folders
        }
    #endif
}
