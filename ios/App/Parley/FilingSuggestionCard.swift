import ParleyKit
import SwiftUI

/// The card that carries the filing suggestion on the record screen: the name
/// this recording could have, and the folders it could live in.
///
/// It is a SUGGESTION, not a control. Soft study-violet on a tinted surface,
/// one action per row, and a dismiss — nothing here happens on its own, and
/// nothing here is destructive. A row disappears the moment it has nothing left
/// to offer (see `FilingSuggestionModel`, which derives that rather than
/// remembering it), and the card goes with the last row.
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
                card
            }
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
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
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            Theme.study.opacity(0.07), in: RoundedRectangle(cornerRadius: Theme.radius)
        )
        .overlay {
            RoundedRectangle(cornerRadius: Theme.radius)
                .strokeBorder(Theme.study.opacity(0.3), lineWidth: 1)
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 12)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "sparkles")
                .font(.parley.caption)
                .foregroundStyle(Theme.study)
                .accessibilityHidden(true)
            Text("Suggested name and folder")
                .font(.parley.caption.weight(.semibold))
                .foregroundStyle(Theme.study)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            Button {
                model.dismiss(app: app)
            } label: {
                Image(systemName: "xmark")
                    .font(.parley.caption2.weight(.semibold))
                    .foregroundStyle(Theme.mutedForeground)
                    // A 24pt target rather than the glyph's own few points:
                    // the dismiss sits beside the accept actions and must not
                    // be the one that is hard to hit.
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Dismiss"))
        }
    }

    private func titleRow(_ proposed: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Suggested name")
                .font(.parley.caption2)
                .foregroundStyle(Theme.mutedForeground)
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                // The proposed name is the model's words, never a lookup key.
                Text(verbatim: proposed)
                    .font(.parley.subheadlineEmphasized)
                    .foregroundStyle(Theme.foreground)
                    .lineLimit(2)
                Spacer(minLength: 8)
                Button {
                    Task { await model.acceptTitle(app: app) }
                } label: {
                    if model.isWritingTitle {
                        ProgressView().controlSize(.mini)
                    } else {
                        Text("Use this name")
                            .font(.parley.caption.weight(.semibold))
                            .foregroundStyle(Theme.primary)
                    }
                }
                .buttonStyle(.plain)
                // Every row is inert while any push is in flight: two writes
                // against the same meta race, and the loser wins.
                .disabled(model.isWriting)
            }
        }
    }

    private var folderRows: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Suggested folder")
                .font(.parley.caption2)
                .foregroundStyle(Theme.mutedForeground)
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
        return Button {
            Task { await model.acceptFolder(folder, app: app) }
        } label: {
            HStack(spacing: 8) {
                if busy {
                    ProgressView()
                        .controlSize(.mini)
                        .frame(width: 16)
                } else {
                    Image(systemName: isNew ? "folder.badge.plus" : "folder")
                        .font(.parley.caption)
                        .foregroundStyle(isNew ? Theme.mutedForeground : Theme.study)
                        .frame(width: 16)
                }
                VStack(alignment: .leading, spacing: 2) {
                    // A folder that does not exist yet has to read as one being
                    // created, not as one to move into — the tap is what brings
                    // it into being.
                    if isNew {
                        Text("New folder “\(folder.name)”")
                            .font(.parley.caption.weight(.semibold))
                            .foregroundStyle(Theme.foreground)
                            .lineLimit(1)
                    } else {
                        Text(verbatim: folder.name)
                            .font(.parley.caption.weight(.semibold))
                            .foregroundStyle(Theme.foreground)
                            .lineLimit(1)
                    }
                    // The reason is there to make the folder pickable at a
                    // glance, so it gets one line and no more. It is the
                    // model's prose, not a lookup key.
                    if !folder.reason.isEmpty {
                        Text(verbatim: folder.reason)
                            .font(.parley.caption2)
                            .foregroundStyle(Theme.mutedForeground)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                actionLabel(isNew: isNew)
                    .font(.parley.caption.weight(.semibold))
                    .foregroundStyle(Theme.primary)
                    .lineLimit(1)
                    .fixedSize()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.tintedSurface, in: RoundedRectangle(cornerRadius: 10))
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .disabled(model.isWriting)
        .accessibilityElement(children: .combine)
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
