import ParleyKit
import SwiftUI

/// The filing suggestion on the record screen: the name this recording could
/// have, and the folders it could live in.
///
/// It is a SUGGESTION, not a control, and it is drawn like one: a small
/// secondary heading, the suggestion in plain ink, and the actions as blue text.
/// No card, no border, no glyph. It used to be a violet-bordered panel carrying
/// the AI stars — the loudest block on a screen whose job is to stay out of the
/// way, coloured to advertise that a model wrote it rather than to say what it
/// was offering. Nothing here happens on its own and nothing here is
/// destructive, so nothing here needs to shout.
///
/// A row disappears the moment it has nothing left to offer (see
/// `FilingSuggestionModel`, which derives that rather than remembering it), and
/// the block goes with the last row.
///
/// The desktop lays the folder candidates out as chips across one line. Here
/// they are stacked rows instead: three chips carrying a reason do not fit
/// across a phone, and a horizontal scroller would hide candidates behind a
/// gesture nobody knows to make. The reason is what makes a folder pickable
/// without opening the recording, so it stays on screen and the layout gives
/// way instead.
struct FilingSuggestionCard: View {
    @EnvironmentObject private var app: AppState
    @ObservedObject var model: FilingSuggestionModel

    var body: some View {
        Group {
            if model.hasSomethingToOffer {
                block
            }
        }
    }

    private var block: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Suggested name and folder")
                .font(.parley.footnote.weight(.semibold))
                .foregroundStyle(Color(.secondaryLabel))
                .accessibilityAddTraits(.isHeader)
            if let proposed = model.proposedTitle {
                titleRow(proposed)
            }
            if !model.proposedFolders.isEmpty {
                folderRows
            }
            if model.writeFailed {
                Text("That didn't save. Try again.")
                    .font(.parley.caption2)
                    .foregroundStyle(Theme.destructive)
            }
            // "Not now" rather than an ✕ in the corner: the dismiss is one of the
            // two things you can do with a suggestion, so it reads as the pair to
            // accepting it instead of as a way to close a window.
            Button("Not now") {
                model.dismiss(app: app)
            }
            .font(.parley.footnote.weight(.semibold))
            .disabled(model.isWriting)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .padding(.bottom, 12)
    }

    private func titleRow(_ proposed: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            // The proposed name is the model's words, never a lookup key.
            Text(verbatim: proposed)
                .font(.parley.subheadlineEmphasized)
                .foregroundStyle(Color(.label))
                .lineLimit(2)
            Spacer(minLength: 8)
            Button {
                Task { await model.acceptTitle(app: app) }
            } label: {
                if model.isWritingTitle {
                    ProgressView().controlSize(.mini)
                } else {
                    Text("Use this name")
                        .font(.parley.footnote.weight(.semibold))
                }
            }
            // Every row is inert while any push is in flight: two writes
            // against the same meta race, and the loser wins.
            .disabled(model.isWriting)
        }
    }

    private var folderRows: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Indexed rather than keyed by name: two candidates could carry the
            // same name — one existing folder and one to be created — and two
            // rows sharing one identity is a list SwiftUI cannot draw.
            ForEach(model.proposedFolders.indices, id: \.self) { index in
                folderRow(model.proposedFolders[index])
            }
        }
    }

    private func folderRow(_ folder: FilingFolderSuggestion) -> some View {
        let isNew = folder.folderId == nil
        let busy = model.isWritingFolder(folder)
        return HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                // A folder that does not exist yet has to read as one being
                // created, not as one to move into — the tap is what brings
                // it into being.
                if isNew {
                    Text("New folder “\(folder.name)”")
                        .font(.parley.footnote.weight(.semibold))
                        .foregroundStyle(Color(.label))
                        .lineLimit(1)
                } else {
                    Text(verbatim: folder.name)
                        .font(.parley.footnote.weight(.semibold))
                        .foregroundStyle(Color(.label))
                        .lineLimit(1)
                }
                // The reason is there to make the folder pickable at a
                // glance, so it gets one line and no more. It is the
                // model's prose, not a lookup key.
                if !folder.reason.isEmpty {
                    Text(verbatim: folder.reason)
                        .font(.parley.caption2)
                        .foregroundStyle(Color(.secondaryLabel))
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            Button {
                Task { await model.acceptFolder(folder, app: app) }
            } label: {
                if busy {
                    ProgressView().controlSize(.mini)
                } else {
                    actionLabel(isNew: isNew)
                        .font(.parley.footnote.weight(.semibold))
                        .lineLimit(1)
                        .fixedSize()
                }
            }
            .disabled(model.isWriting)
        }
    }

    /// What the tap will do, spelled out rather than assembled from a ternary:
    /// each branch is its own literal, so both land in the string catalogue as
    /// their own key and neither depends on how Swift resolves a conditional
    /// between two `Text` initializers.
    @ViewBuilder
    private func actionLabel(isNew: Bool) -> some View {
        if isNew {
            Text("Create and file here")
        } else {
            Text("File here")
        }
    }
}
