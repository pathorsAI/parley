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
///   only closes the field: nothing is written until Save.
/// - **The chips** are the folders: the pass's own candidates, best first — a
///   folder that does not exist yet is dashed, because saving into it creates
///   it — then, where there is room, folders the user already has. At most
///   three. A chip is a CHOICE, not an action: tapping one selects it (filled,
///   with a checkmark), tapping it again clears it, and the best candidate
///   starts out selected. Chips used to file on the tap, and a tester who
///   tapped one to see what it was found the meeting already filed there.
/// - **Choose another…** opens the folder picker, personal and organization
///   folders both, for the recording none of the chips fits. Its pick becomes
///   the selection here, shown as a chip of its own.
/// - **Save** (儲存) writes the name as the field shows it and the selected
///   folder, in one push. **Skip** answers the offer with no.
///
/// The same rule as the desktop: only filing ticks the checklist's `filed`; a
/// rename on its own does not.
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
    /// The folder Save files into, once the user has touched the choice. Until
    /// then it is the best candidate (`selected`).
    @State private var chosen: FolderDestination?
    @State private var choiceTouched = false
    /// A pick from the picker that is not one of the chips, with its label.
    @State private var picked: (destination: FolderDestination, label: String)?
    /// How much of the proposed title has typed itself in, the first time the
    /// card shows it. nil = all of it.
    @State private var typedCount: Int?
    /// The accept in flight: which chip the card is flying into, and which one
    /// is popping. See `fly(into:then:)`.
    @State private var flight: String?
    @State private var flying = false
    @State private var popping: String?
    @Namespace private var motion
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #if DEBUG
        /// ScreenshotDemo's `adjust` route opens the picker with nobody
        /// tapping; `simctl` cannot tap.
        @ObservedObject private var demo = ScreenshotDemo.shared
    #endif

    var body: some View {
        Group {
            if model.hasSomethingToOffer {
                block
                    .transition(
                        reduceMotion
                            ? .opacity
                            : .asymmetric(
                                insertion: .modifier(
                                    active: Arrival(progress: 0), identity: Arrival(progress: 1)),
                                removal: .opacity))
                    .onAppear(perform: typeTitleOnce)
            }
        }
        .animation(reduceMotion ? nil : LapMotion.spring, value: model.hasSomethingToOffer)
        .onAppear { draft = model.editableTitle }
        .onChange(of: model.editableTitle) { _, title in
            if !editing { draft = title }
        }
        // A new offer (the next recording's) starts from its own best guess.
        .onChange(of: model.proposedFolders.map(FilingSuggestionModel.key(for:))) { _, _ in
            chosen = nil
            choiceTouched = false
            picked = nil
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
        .overlay { flightGhost }
    }

    /// The card, in miniature, on its way into a folder chip: a tinted slip
    /// with the title on it, matched first to the title and then to the chip,
    /// so the spring carries it from one to the other.
    @ViewBuilder
    private var flightGhost: some View {
        if let flight {
            RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                .fill(Theme.primary.opacity(0.12))
                .overlay(
                    Text(verbatim: model.editableTitle)
                        .font(.parley.caption)
                        .foregroundStyle(Color(.label))
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                        .padding(.horizontal, 6))
                .matchedGeometryEffect(
                    id: flying ? "chip-\(flight)" : "title", in: motion, isSource: false)
                .opacity(flying ? 0.35 : 1)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }

    /// The title types itself in once per session per suggestion — the moment
    /// the lap is about is Parley *writing* a name, and a name that is simply
    /// there reads as a fixture.
    private func typeTitleOnce() {
        let title = model.editableTitle
        guard !reduceMotion, !title.isEmpty, !LapMotion.typedTitles.contains(title) else { return }
        LapMotion.typedTitles.insert(title)
        typedCount = 0
        Task { @MainActor in
            for count in 1...title.count {
                try? await Task.sleep(for: .seconds(LapMotion.perCharacter))
                typedCount = count
            }
            typedCount = nil
        }
    }

    /// Fly the card into a chip, pop the chip, then write. With Reduce Motion
    /// the write happens at once.
    private func fly(into key: String, then write: @escaping () async -> Void) {
        guard !reduceMotion else {
            Task { await write() }
            return
        }
        flight = key
        flying = false
        Task { @MainActor in
            // A frame at the title, so the match has somewhere to start from.
            try? await Task.sleep(for: .milliseconds(16))
            withAnimation(LapMotion.spring) { flying = true }
            try? await Task.sleep(for: .seconds(0.4))
            withAnimation(.spring(response: 0.2, dampingFraction: 0.5)) { popping = key }
            LapMotion.success()
            try? await Task.sleep(for: .seconds(0.18))
            withAnimation(LapMotion.spring) { popping = nil }
            flight = nil
            flying = false
            await write()
        }
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
                        .onSubmit(endEditing)
                        // A vertical field turns Return into a newline; a
                        // title is one line, so Return closes the field.
                        // It does not save: Save does.
                        .onChange(of: draft) { _, text in
                            if text.contains("\n") {
                                draft = text.replacingOccurrences(of: "\n", with: "")
                                endEditing()
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
                            Text(verbatim: shownTitle)
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
                    .matchedGeometryEffect(id: "title", in: motion, isSource: true)
                    .accessibilityLabel(Text(verbatim: draft.isEmpty ? model.editableTitle : draft))
                    .accessibilityHint(Text("Edit the title"))
                }
                Spacer(minLength: 8)
                if model.isWriting {
                    ProgressView().controlSize(.mini)
                } else {
                    Button(action: save) {
                        Text("Save")
                            .font(.parley.bodyEmphasized)
                    }
                    .buttonStyle(.borderless)
                    .disabled(!hasSomethingToSave)
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

    /// The title as drawn: typed in part while it is typing itself in.
    private var shownTitle: String {
        let full = draft.isEmpty ? model.editableTitle : draft
        guard let typedCount else { return full }
        return LapMotion.typed(full, count: typedCount)
    }

    /// Close the title field and keep what was typed for Save. An emptied
    /// field goes back to the proposal rather than saving a blank name.
    private func endEditing() {
        editing = false
        titleFocused = false
        if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            draft = model.editableTitle
        }
    }

    // MARK: the folders

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(model.proposedFolders, id: \.name) { folder in
                    chip(folder)
                }
                if let picked, !chipDestinations.contains(picked.destination) {
                    pickedChip(picked.destination, label: picked.label)
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
        let destination = FilingSuggestionModel.destination(for: folder)
        let isSelected = selected == destination
        return Button {
            toggle(destination)
        } label: {
            chipLabel(
                Text(verbatim: folder.name),
                caption: isNew ? Text("New folder") : Text("Existing folder"),
                dashed: isNew, tint: Theme.primary, selected: isSelected)
        }
        .buttonStyle(.plain)
        .matchedGeometryEffect(id: "chip-\(FilingSuggestionModel.key(for: folder))", in: motion, isSource: true)
        .scaleEffect(popping == FilingSuggestionModel.key(for: folder) ? 1.06 : 1)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityHint(Text(verbatim: folder.reason))
    }

    /// The picker's pick, when it is none of the candidates: selected, and
    /// saying when it is an organization's folder, because Save then shares a
    /// copy rather than moving the recording.
    private func pickedChip(_ destination: FolderDestination, label: String) -> some View {
        let isSelected = selected == destination
        var isNew = false
        if case .newFolder = destination { isNew = true }
        let caption: Text =
            isNew
            ? Text("New folder")
            : destination.orgId != nil ? Text("Copy to organization") : Text("Existing folder")
        return Button {
            toggle(destination)
        } label: {
            chipLabel(
                Text(verbatim: label), caption: caption, dashed: isNew,
                tint: Theme.primary, selected: isSelected)
        }
        .buttonStyle(.plain)
        .matchedGeometryEffect(id: "chip-picked", in: motion, isSource: true)
        .scaleEffect(popping == "picked" ? 1.06 : 1)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    /// An outlined chip: the name in the tint (it is a thing to tap), a
    /// caption saying what saving into it does to the folder list, and a dashed
    /// outline for the folder that does not exist yet. Selected, it takes the
    /// tint as a wash and a checkmark in place of its folder glyph: the one
    /// fill on the card, because it is the one answer the card is holding.
    private func chipLabel(
        _ name: Text, caption: Text?, dashed: Bool, tint: Color, selected: Bool = false
    ) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 5) {
                Image(
                    systemName: selected
                        ? "checkmark.circle.fill" : dashed ? "folder.badge.plus" : "folder"
                )
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
        .background(
            RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                .fill(selected ? Theme.primary.opacity(0.12) : Color.clear))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                .strokeBorder(
                    selected ? Theme.primary : Color(.separator),
                    style: StrokeStyle(lineWidth: selected ? 1.5 : 1, dash: dashed ? [4, 3] : [])))
        .contentShape(Rectangle())
    }

    /// The chips' own destinations, so a picker pick that is already a chip
    /// selects that chip instead of drawing a second one.
    private var chipDestinations: [FolderDestination] {
        model.proposedFolders.map(FilingSuggestionModel.destination(for:))
    }

    /// What Save files into: the user's choice once they have made one, the
    /// best candidate until then. nil = leave the folder alone.
    private var selected: FolderDestination? {
        choiceTouched ? chosen : model.proposedFolder.map(FilingSuggestionModel.destination(for:))
    }

    private func toggle(_ destination: FolderDestination) {
        commitDraftIfEditing()
        let next: FolderDestination? = selected == destination ? nil : destination
        choiceTouched = true
        chosen = next
    }

    private var hasSomethingToSave: Bool {
        if selected != nil { return true }
        guard let title = currentDraft else { return false }
        return title != model.currentTitle
    }

    /// 儲存: the name as the field shows it and the selected folder, in one
    /// write. The flight goes into the selected chip.
    private func save() {
        commitDraftIfEditing()
        let title = currentDraft
        let destination = selected
        guard let destination else {
            Task { await model.apply(title: title, destination: nil, app: app) }
            return
        }
        let key =
            model.proposedFolders.first {
                FilingSuggestionModel.destination(for: $0) == destination
            }.map(FilingSuggestionModel.key(for:)) ?? "picked"
        fly(into: key) {
            await model.apply(title: title, destination: destination, app: app)
        }
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

    /// The folder picker, with the chips' real folders offered first and the
    /// user's organizations under their own headings. Its confirm is a choice,
    /// not a write: the pick becomes this card's selection, and Save writes it
    /// with the name.
    private var picker: some View {
        let live = Set(model.existingFolders.map(\.id))
        let suggested = model.proposedFolders.compactMap { folder -> CloudFolder? in
            guard let id = folder.folderId, live.contains(id) else { return nil }
            return model.existingFolders.first { $0.id == id }
        }
        let orgGroups: (() async -> [FolderGroup])? =
            model.canShareToOrganizations && !app.orgs.isEmpty
            ? { await FolderGroup.organizations(app: app) } : nil
        return FolderPickerSheet(
            groups: [.personal(model.existingFolders)],
            loadMoreGroups: orgGroups,
            current: .current(orgId: nil, folderId: model.currentFolderId),
            suggested: suggested,
            canCreate: true,
            title: "Choose a folder",
            confirm: .choose,
            onConfirm: { destination, label in
                if !chipDestinations.contains(destination) {
                    picked = (destination, label)
                }
                choiceTouched = true
                chosen = destination
            })
    }
}

/// The card's entrance: from 16pt low, 98% and transparent to where it sits —
/// driven by `LapMotion.spring` through the transition.
private struct Arrival: ViewModifier {
    let progress: Double

    func body(content: Content) -> some View {
        content
            .offset(y: 16 * (1 - progress))
            .scaleEffect(0.98 + 0.02 * progress)
            .opacity(progress)
    }
}
