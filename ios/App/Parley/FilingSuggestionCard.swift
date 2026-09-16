import ParleyKit
import SwiftUI

/// The filing suggestion on the record screen: the name this recording could
/// have, and the folder it could live in — as **one decision**.
///
/// It is a SUGGESTION, not a control, and it is drawn like one: a small
/// secondary heading, the suggestion in plain ink, and the actions as blue text.
/// No card, no border, no fill — the one glyph is the folder, which says what
/// the line under the title is about. It used to be a violet-bordered panel
/// carrying the AI stars — the loudest block on a screen whose job is to stay
/// out of the way, coloured to advertise that a model wrote it rather than to
/// say what it was offering. Nothing here happens on its own and nothing here is
/// destructive, so nothing here needs to shout.
///
/// ## Why one decision and not three
///
/// This block used to lay the pass's whole answer out as a menu: a "use this
/// name" row plus a row per candidate folder, each with its own button, each
/// writing on its own. Three buttons meant three things to read and compare
/// before anything could be filed — on the screen a person reaches at the exact
/// moment they have stopped paying attention to their phone, having just
/// finished a meeting. The candidates it was asking them to weigh are the
/// model's 2nd and 3rd guesses, which are worth having but are not worth a
/// decision.
///
/// So the block states the answer — the proposed name, what the recording is
/// called now, and the best folder with its reason in full — and offers one
/// blue verb that takes it. `Adjust` is where the rest of the answer lives, for
/// the minority of recordings where the first guess is wrong, and `Skip
/// suggestion` is the way out. The reason stays on screen and wraps rather than
/// truncating: it is what makes a folder trustworthy without opening the
/// recording, and a clipped reason is a reason nobody can act on.
struct FilingSuggestionCard: View {
    @EnvironmentObject private var app: AppState
    @ObservedObject var model: FilingSuggestionModel
    @State private var adjusting = false
    #if DEBUG
        /// ScreenshotDemo's `adjust` route opens the sheet with nobody tapping;
        /// `simctl` cannot tap, and a frame nobody can reproduce is a frame that
        /// silently rots.
        @ObservedObject private var demo = ScreenshotDemo.shared
    #endif

    var body: some View {
        Group {
            if model.hasSomethingToOffer {
                block
            }
        }
        .sheet(isPresented: $adjusting) {
            FilingAdjustSheet(model: model)
        }
        #if DEBUG
            .onChange(of: demo.openFilingAdjust) {
                if demo.openFilingAdjust { adjusting = true }
            }
        #endif
    }

    private var block: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Suggestion")
                .font(.parley.footnote.weight(.semibold))
                .foregroundStyle(Color(.secondaryLabel))
                .accessibilityAddTraits(.isHeader)
            if let proposed = model.proposedTitle {
                title(proposed)
            }
            if let folder = model.proposedFolder {
                folderLine(folder)
            }
            if model.writeFailed {
                Text("That didn't save. Try again.")
                    .font(.parley.caption2)
                    .foregroundStyle(Theme.destructive)
            }
            actions
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        // Room above as well as below: the transcript scrolls to its last turn
        // rather than to the end of its own padding, so without this the section
        // label lands against the words of the meeting that just ended.
        .padding(.vertical, 12)
    }

    /// The proposed name, and under it the name the recording carries now. Both
    /// are needed: a title on its own gives nothing to judge it against, and
    /// "Meeting May 14, 5:40 PM" is exactly the thing the suggestion exists to
    /// replace — seeing it is most of the argument.
    private func title(_ proposed: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            // The proposed name is the model's words, never a lookup key.
            Text(verbatim: proposed)
                .font(.parley.title3)
                .foregroundStyle(Color(.label))
                .lineLimit(2)
            Text("Was: \(model.currentTitle)")
                .font(.parley.footnote)
                .foregroundStyle(Color(.secondaryLabel))
                .lineLimit(1)
        }
    }

    /// The folder, and why. A folder that does not exist yet has to read as one
    /// being created rather than one to move into — accepting is what brings it
    /// into being.
    private func folderLine(_ folder: FilingFolderSuggestion) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Image(systemName: "folder")
                    .font(.parley.footnote)
                    .foregroundStyle(Color(.secondaryLabel))
                    .accessibilityHidden(true)
                folderLabel(folder)
                    .font(.parley.subheadline)
                    .foregroundStyle(Color(.label))
                    .lineLimit(1)
            }
            if !folder.reason.isEmpty {
                // The model's prose, not a lookup key, and never truncated.
                Text(verbatim: folder.reason)
                    .font(.parley.footnote)
                    .foregroundStyle(Color(.secondaryLabel))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// The label, a real chevron, the name. `›` as a text character sits on the
    /// baseline of PingFang and reads as a comma; the SF Symbol is drawn to the
    /// cap height, which is the difference between "資料夾 › 續約" and
    /// "資料夾，續約".
    private func folderLabel(_ folder: FilingFolderSuggestion) -> some View {
        HStack(spacing: 4) {
            if folder.folderId == nil {
                Text("New folder")
            } else {
                Text("Folder")
            }
            Image(systemName: "chevron.right")
                .font(.parley.caption2.weight(.semibold))
                .foregroundStyle(Color(.tertiaryLabel))
                .accessibilityHidden(true)
            Text(verbatim: folder.name)
        }
    }

    /// One verb, then the two ways around it. `Skip suggestion` rather than an
    /// ✕ in the corner: declining is one of the two things you can do with a
    /// suggestion, so it reads as the pair to accepting it instead of as a way
    /// to close a window.
    private var actions: some View {
        HStack(spacing: 18) {
            Button {
                Task { await model.acceptSuggested(app: app) }
            } label: {
                if model.isWriting {
                    ProgressView().controlSize(.mini)
                } else {
                    Text("Save as suggested")
                        .font(.parley.bodyEmphasized)
                }
            }
            Button("Adjust") {
                adjusting = true
            }
            .font(.parley.footnote.weight(.semibold))
            Button {
                model.dismiss(app: app)
            } label: {
                Text("Skip suggestion")
                    .font(.parley.footnote)
                    .foregroundStyle(Color(.secondaryLabel))
            }
            .buttonStyle(.plain)
            Spacer(minLength: 0)
        }
        // Everything is inert while the push is in flight, the primary
        // included: it is the one write this screen makes, and a second tap
        // would push a copy of the meta read before the first landed.
        .disabled(model.isWriting)
        .padding(.top, 2)
    }
}

/// `Adjust`: the rest of the pass's answer, plus the name in a field.
///
/// Everything here was already fetched. The candidate folders are the ones the
/// block did not have room for, and the existing folders are the registry the
/// pass had to list anyway to give the model a menu — see
/// `FilingSuggestionModel.existingFolders`. A sheet that fetched the folders
/// again would be a second round trip that can fail on its own, and on a flaky
/// network it would show a different list than the one the suggestion was made
/// against.
///
/// Both edits are handed over together (`apply(title:folder:)`). Applying them
/// one at a time would be two read-modify-writes against the same meta, and the
/// second would carry a copy read before the first landed.
private struct FilingAdjustSheet: View {
    @EnvironmentObject private var app: AppState
    @ObservedObject var model: FilingSuggestionModel
    @Environment(\.dismiss) private var dismiss

    /// One row of the folder list, whether it came from the model or from the
    /// user's own registry. Identified by `FilingSuggestionModel.key(for:)`
    /// rather than by name: a proposed new folder and an existing one can carry
    /// the same name, and two rows sharing one identity is a list SwiftUI
    /// cannot draw.
    private struct Choice: Identifiable {
        let id: String
        let folder: FilingFolderSuggestion
        let isNew: Bool
    }

    @State private var title: String
    /// `Choice.id`, or nil for "leave it where it is". Tapping the ticked row
    /// unticks it, which is the only way to accept a rename without a move.
    @State private var chosen: String?

    init(model: FilingSuggestionModel) {
        self.model = model
        _title = State(initialValue: model.proposedTitle ?? model.currentTitle)
        _chosen = State(initialValue: model.proposedFolder.map(FilingSuggestionModel.key(for:)))
    }

    /// Proposed folders first, best-first as the model ordered them, then the
    /// user's own — minus any the model already named, so one folder is never
    /// two rows.
    private var choices: [Choice] {
        let proposed = model.proposedFolders.map { folder in
            Choice(
                id: FilingSuggestionModel.key(for: folder), folder: folder,
                isNew: folder.folderId == nil)
        }
        let named = Set(proposed.map(\.id))
        let rest = model.existingFolders.filter { !named.contains($0.id) }.map { folder in
            Choice(
                id: folder.id,
                folder: FilingFolderSuggestion(folderId: folder.id, name: folder.name, reason: ""),
                isNew: false)
        }
        return proposed + rest
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    titleField
                    folderList
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Theme.background)
            .navigationTitle("Adjust")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(model.isWriting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model.isWriting {
                        ProgressView().controlSize(.mini)
                    } else {
                        Button("Save") { save() }
                            .font(.parley.bodyEmphasized)
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var titleField: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Title")
                .font(.parley.footnote.weight(.semibold))
                .foregroundStyle(Color(.secondaryLabel))
            HStack(spacing: 8) {
                TextField("Title", text: $title, axis: .vertical)
                    .font(.parley.body)
                    .foregroundStyle(Color(.label))
                    .textInputAutocapitalization(.sentences)
                    .autocorrectionDisabled()
                if !title.isEmpty {
                    Button {
                        title = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(Color(.tertiaryLabel))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear")
                }
            }
            Divider()
        }
    }

    private var folderList: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Move to folder")
                .font(.parley.footnote.weight(.semibold))
                .foregroundStyle(Color(.secondaryLabel))
            // Whitespace between the rows and no hairline, like every other
            // list in the app.
            VStack(alignment: .leading, spacing: 0) {
                ForEach(choices) { choice in
                    row(choice)
                }
            }
        }
    }

    private func row(_ choice: Choice) -> some View {
        let isChosen = chosen == choice.id
        return Button {
            chosen = isChosen ? nil : choice.id
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(verbatim: choice.folder.name)
                            .font(.parley.body)
                            .foregroundStyle(Color(.label))
                            .lineLimit(1)
                        if choice.isNew {
                            Text("New")
                                .font(.parley.caption)
                                .foregroundStyle(Color(.secondaryLabel))
                        }
                    }
                    if !choice.folder.reason.isEmpty {
                        Text(verbatim: choice.folder.reason)
                            .font(.parley.footnote)
                            .foregroundStyle(Color(.secondaryLabel))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 8)
                // Blue, because it is the one thing on this list that is true
                // right now.
                Image(systemName: "checkmark")
                    .font(.parley.footnote.weight(.semibold))
                    .foregroundStyle(Theme.primary)
                    .opacity(isChosen ? 1 : 0)
            }
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isChosen ? [.isButton, .isSelected] : .isButton)
    }

    private func save() {
        let folder = choices.first { $0.id == chosen }?.folder
        Task {
            let pushed = await model.apply(title: title, folder: folder, app: app)
            // A failed push keeps the sheet up with the edits intact — the
            // block behind it carries the message, and dismissing would throw
            // away the only copy of what the user typed.
            guard !model.writeFailed else { return }
            // Saving here answers the offer outright, and answers it in the
            // user's own words, so the block behind the sheet has to be retired
            // rather than left to work it out: a name the user typed is neither
            // the model's nor the one the recording had, and a block still
            // holding the model's suggestion would redraw with it as the
            // headline, the name just saved demoted to "Was: …", and `Save as
            // suggested` still on screen offering to write over it.
            //
            // After the push and never before — `forget()` clears the recording
            // id, and a write ordered against no id is a silent no-op. A Save
            // that found nothing to change pushed nothing, so it leaves through
            // `dismiss`, which lands `filingSuggested` for the desktop.
            if pushed {
                model.forget()
            } else {
                model.dismiss(app: app)
            }
            dismiss()
        }
    }
}
