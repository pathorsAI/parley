import ParleyKit
import SwiftUI

/// The filing suggestion: the name this recording could have, and the folder it
/// could live in. Shown on the record screen for the recording that just
/// landed, and on the recording screen above the Summary | Transcript switch
/// whenever the recording has a suggestion pending (the sample always starts
/// with one — see `SampleRecordingStore`).
///
/// It is a SUGGESTION, not a form, and it is drawn like one: a small secondary
/// heading, the proposed name in ink, the candidate folders as outlined chips,
/// and the actions as blue text. No card, no fill — the chips are the only
/// shapes, because they are the only things here that are choices.
///
/// ## The pieces
///
/// - **The name** is the proposal, and tapping it edits it in place. Return
///   renames the recording then and there (for a cloud recording, the same meta
///   re-push every rename and move on the phone uses; for the sample, its local
///   title) and leaves the folder half on offer.
/// - **The chips** are the folders: the pass's own candidates, best first — a
///   folder that does not exist yet is dashed, because tapping it creates it —
///   then, where there is room, folders the user already has. At most three.
///   Tapping one files into that folder and does nothing to the name.
/// - **Choose another…** opens the searchable folder picker with the chips'
///   existing folders at the top, for the recording none of them fits. It
///   files the same way a chip does.
/// - **Accept** (採用) takes the WHOLE suggestion: the name as the field shows
///   it and the first chip, in one tap. **Skip** answers the offer with no.
///
/// The same rule as the desktop: only filing — Accept, a chip, the picker —
/// ticks the checklist's `filed`; a rename on its own does not.
///
/// Every write is one read-modify-write through `FilingSuggestionModel.apply`,
/// so a rename followed by a chip is two pushes in order, never two racing.
struct FilingSuggestionCard: View {
    @EnvironmentObject private var app: AppState
    @ObservedObject var model: FilingSuggestionModel
    /// Washes the block in the tint for a moment — the guided lap's "look
    /// here". Owned by the screen, which knows when it asked.
    var highlighted = false

    @State private var draft = ""
    @State private var editing = false
    @FocusState private var titleFocused: Bool
    @State private var choosing = false
    #if DEBUG
        /// ScreenshotDemo's `adjust` route opens the picker with nobody
        /// tapping; `simctl` cannot tap.
        @ObservedObject private var demo = ScreenshotDemo.shared
    #endif

    var body: some View {
        Group {
            if model.hasSomethingToOffer {
                block
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .animation(.easeOut(duration: 0.25), value: model.hasSomethingToOffer)
        .onAppear { draft = model.editableTitle }
        .onChange(of: model.editableTitle) { _, title in
            if !editing { draft = title }
        }
        .sheet(isPresented: $choosing) { picker }
        #if DEBUG
            .onChange(of: demo.openFilingAdjust) {
                if demo.openFilingAdjust { choosing = true }
            }
        #endif
    }

    private var block: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Suggestion")
                    .font(.parley.footnote.weight(.semibold))
                    .foregroundStyle(Color(.secondaryLabel))
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                Button {
                    model.dismiss(app: app)
                } label: {
                    Text("Skip suggestion")
                        .font(.parley.footnote)
                        .foregroundStyle(Color(.secondaryLabel))
                }
                .buttonStyle(.plain)
            }
            title
            if !model.proposedFolders.isEmpty {
                chips
            }
            if model.writeFailed {
                Text("That didn't save. Try again.")
                    .font(.parley.caption2)
                    .foregroundStyle(Theme.destructive)
            }
        }
        .disabled(model.isWriting)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .background(Theme.primary.opacity(highlighted ? 0.12 : 0))
        .animation(.easeOut(duration: 0.6), value: highlighted)
    }

    // MARK: the name

    /// The proposed name, editable in place. Under it, while the proposal is
    /// still on offer, what the recording is called now — "Meeting May 14, 5:40
    /// PM" is most of the argument for the suggestion; once the name has been
    /// answered, a quiet "Renamed" instead.
    private var title: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if editing {
                    TextField("Title", text: $draft, axis: .vertical)
                        .font(.parley.title3)
                        .foregroundStyle(Color(.label))
                        .focused($titleFocused)
                        .submitLabel(.done)
                        .onSubmit(commitTitle)
                        // A vertical field turns Return into a newline; a
                        // title is one line, so Return is the rename.
                        .onChange(of: draft) { _, text in
                            if text.contains("\n") {
                                draft = text.replacingOccurrences(of: "\n", with: "")
                                commitTitle()
                            }
                        }
                } else {
                    Button {
                        editing = true
                        titleFocused = true
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            // The proposed name is the model's words, never a
                            // lookup key.
                            Text(verbatim: draft.isEmpty ? model.editableTitle : draft)
                                .font(.parley.title3)
                                .foregroundStyle(Color(.label))
                                .multilineTextAlignment(.leading)
                                .lineLimit(2)
                            Image(systemName: "pencil")
                                .font(.parley.footnote)
                                .foregroundStyle(Color(.tertiaryLabel))
                                .accessibilityHidden(true)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(Text("Edit the title"))
                }
                Spacer(minLength: 8)
                if model.isWriting {
                    ProgressView().controlSize(.mini)
                } else {
                    Button(action: accept) {
                        Text("Accept")
                            .font(.parley.bodyEmphasized)
                    }
                    .buttonStyle(.borderless)
                }
            }
            if model.proposedTitle != nil {
                Text("Was: \(model.currentTitle)")
                    .font(.parley.footnote)
                    .foregroundStyle(Color(.secondaryLabel))
                    .lineLimit(1)
            } else if model.titleWasAnswered {
                Label("Renamed", systemImage: "checkmark")
                    .font(.parley.footnote)
                    .foregroundStyle(Color(.secondaryLabel))
            }
        }
    }

    private func commitTitle() {
        editing = false
        titleFocused = false
        let typed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty else {
            draft = model.editableTitle
            return
        }
        Task { await model.rename(to: typed, app: app) }
    }

    // MARK: the folders

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(model.proposedFolders, id: \.name) { folder in
                    chip(folder)
                }
                Button {
                    choosing = true
                } label: {
                    chipLabel(
                        Text("Choose another…"), caption: nil, dashed: false,
                        tint: Color(.secondaryLabel))
                }
                .buttonStyle(.plain)
            }
            .padding(.vertical, 1)
        }
        // The chips scroll under the page's own gutter rather than being cut
        // at it, so the row reads as continuing.
        .padding(.horizontal, -20)
        .contentMargins(.horizontal, 20, for: .scrollContent)
    }

    private func chip(_ folder: FilingFolderSuggestion) -> some View {
        let isNew = folder.folderId == nil
        return Button {
            file(in: folder)
        } label: {
            chipLabel(
                Text(verbatim: folder.name),
                caption: isNew ? Text("New folder") : Text("Existing folder"),
                dashed: isNew, tint: Theme.primary)
        }
        .buttonStyle(.plain)
        .accessibilityHint(Text(verbatim: folder.reason))
    }

    /// An outlined chip: the name in the tint (it is a thing to tap), a
    /// caption saying what tapping it does to the folder list, and a dashed
    /// outline for the folder that does not exist yet.
    private func chipLabel(_ name: Text, caption: Text?, dashed: Bool, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 5) {
                Image(systemName: dashed ? "folder.badge.plus" : "folder")
                    .font(.parley.caption)
                    .accessibilityHidden(true)
                name
                    .font(.parley.subheadlineEmphasized)
                    .lineLimit(1)
            }
            .foregroundStyle(tint)
            if let caption {
                caption
                    .font(.parley.caption2)
                    .foregroundStyle(Color(.secondaryLabel))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .frame(minHeight: 44)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                .strokeBorder(
                    Color(.separator),
                    style: StrokeStyle(lineWidth: 1, dash: dashed ? [4, 3] : [])))
        .contentShape(Rectangle())
    }

    /// 採用: the name as the field shows it, and the first chip.
    private func accept() {
        commitDraftIfEditing()
        let title = currentDraft
        Task { await model.apply(title: title, folder: model.proposedFolder, app: app) }
    }

    /// A chip or the picker: file, and leave the name to its own answer.
    private func file(in folder: FilingFolderSuggestion) {
        commitDraftIfEditing()
        Task { await model.apply(title: nil, folder: folder, app: app) }
    }

    /// The name to write with a folder: what the field says, unless the name
    /// has already been answered and the field still shows that answer.
    private var currentDraft: String? {
        let typed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return typed.isEmpty ? model.proposedTitle : typed
    }

    private func commitDraftIfEditing() {
        guard editing else { return }
        editing = false
        titleFocused = false
    }

    // MARK: choose another

    /// The searchable picker, with the chips' real folders offered first.
    /// Choosing or creating there answers the offer exactly as a chip would.
    private var picker: some View {
        let live = Set(model.existingFolders.map(\.id))
        let suggested = model.proposedFolders.compactMap { folder -> CloudFolder? in
            guard let id = folder.folderId, live.contains(id) else { return nil }
            return model.existingFolders.first { $0.id == id }
        }
        return FolderPickerSheet(
            folders: model.existingFolders,
            currentFolderId: model.currentFolderId,
            suggested: suggested,
            onSelect: { folderId in
                guard let folderId,
                    let folder = model.existingFolders.first(where: { $0.id == folderId })
                else { return }
                file(
                    in: FilingFolderSuggestion(
                        folderId: folder.id, name: folder.name, reason: ""))
            },
            onCreate: { name in
                let landed = await model.apply(
                    title: nil,
                    folder: FilingFolderSuggestion(folderId: nil, name: name, reason: ""),
                    app: app)
                if !landed { throw FilingSuggestionCard.CreateFailed() }
            })
    }

    private struct CreateFailed: LocalizedError {
        var errorDescription: String? { String(localized: "That didn't save. Try again.") }
    }
}
