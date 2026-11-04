import ParleyKit
import SwiftUI

/// A place a recording can be filed. Personal and organization folders are
/// different containers with different endpoints, so the scope is part of the
/// value rather than something the caller re-derives from a bare folder id.
enum FolderDestination: Hashable {
    /// A scope's top level: Unfiled for personal (`orgId` nil), the org's own
    /// root otherwise.
    case root(orgId: String?)
    case folder(id: String, orgId: String?)
    /// A personal folder that does not exist yet. Created by whoever confirms
    /// the pick, never by the picker: choosing a name and backing out must not
    /// leave an empty folder behind.
    case newFolder(name: String)

    var orgId: String? {
        switch self {
        case .root(let orgId), .folder(_, let orgId): return orgId
        case .newFolder: return nil
        }
    }

    /// The existing folder this names, in whichever scope; nil for a scope's
    /// top level and for a folder still to be created.
    var folderId: String? {
        if case .folder(let id, _) = self { return id }
        return nil
    }

    /// Where a recording with this scope and folder id is filed now.
    static func current(orgId: String?, folderId: String?) -> FolderDestination {
        folderId.map { .folder(id: $0, orgId: orgId) } ?? .root(orgId: orgId)
    }
}

/// A failed confirm, worded for the picker's error line.
struct FilingError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// One scope's folders, as the picker lists them under one heading.
struct FolderGroup: Identifiable {
    /// nil = the personal library.
    let orgId: String?
    let name: String
    let folders: [CloudFolder]

    var id: String { orgId ?? "personal" }

    static func personal(_ folders: [CloudFolder]) -> FolderGroup {
        FolderGroup(
            orgId: nil, name: String(localized: "Personal"),
            folders: folders.filter { $0.orgId == nil })
    }

    /// Every organization the user belongs to, with its folders. An org whose
    /// folder list fails to load still offers its top level: sharing a copy
    /// there does not need the list.
    @MainActor static func organizations(app: AppState) async -> [FolderGroup] {
        #if DEBUG
            if ScreenshotDemo.servesFixtures {
                return ScreenshotDemo.orgs.map {
                    FolderGroup(orgId: $0.id, name: $0.name, folders: ScreenshotDemo.orgFolders)
                }
            }
        #endif
        let orgs = app.orgs
        let cloud = app.cloud
        return await withTaskGroup(of: (Int, FolderGroup).self) { group in
            for (index, org) in orgs.enumerated() {
                group.addTask {
                    let folders = (try? await cloud.orgFolders(orgId: org.id)) ?? []
                    return (index, FolderGroup(orgId: org.id, name: org.name, folders: folders))
                }
            }
            var loaded: [(Int, FolderGroup)] = []
            for await item in group { loaded.append(item) }
            return loaded.sorted { $0.0 < $1.0 }.map(\.1)
        }
    }
}

/// "Move to folder": every place the recording can go, personal and
/// organization, as a searchable list in a sheet.
///
/// A tap SELECTS a row; nothing moves until the confirm button in the header
/// is pressed. The sheet used to file on the first tap, and on a list of forty
/// customers a tap meant to scroll, or one row off, filed the meeting with the
/// wrong customer before the user could see which row had taken it. The same
/// goes for Return: in the search field it selects the single match, in the
/// new-folder field it selects the name typed, and neither commits.
///
/// Personal folders and each organization's folders are listed under their
/// own heading, because they are different places: filing a personal
/// recording into an org folder shares a COPY there (the server's
/// `POST /recordings/:id/share`) and leaves the original where it is, the
/// desktop's rule for org destinations. The subtitle says so whenever such a
/// row is selected.
///
/// Plain rows on the page, no cards and no fills (`ios-visual-language.md`).
/// Blue appears where it means something: the selection's checkmark, the
/// create action and the confirm button.
///
/// The sheet decides nothing about *how* a recording moves. `onConfirm` is the
/// caller's own move: a meta re-push for a personal recording, a PATCH for an
/// org one, a share for a personal recording going to an org, a local write
/// for the sample. A throw keeps the sheet up with the error under the header;
/// a return dismisses.
struct FolderPickerSheet: View {
    let groups: [FolderGroup]
    /// More groups to add once the sheet is up: the organizations' folders,
    /// which are a network round trip per org away. nil = none.
    var loadMoreGroups: (() async -> [FolderGroup])?
    /// Where the recording is filed now.
    let current: FolderDestination
    /// Personal folders to offer above the full list: the filing suggestion's
    /// picks. Empty hides the section.
    var suggested: [CloudFolder] = []
    /// Whether "New folder…" is offered. Only personal folders can be created
    /// from here.
    var canCreate = false
    var title: LocalizedStringKey = "Move to folder"
    /// What the header's confirm button does: move the recording now, or hand
    /// the pick back to a screen that saves it with something else (the
    /// filing suggestion saves the name and the folder together).
    var confirm: ConfirmAction = .move
    /// The pick, with the label the sheet drew it under. Not called for the
    /// place the recording already is.
    let onConfirm: (FolderDestination, _ label: String) async throws -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var loadedGroups: [FolderGroup] = []
    @State private var selection: FolderDestination?
    @State private var query = ""
    @FocusState private var searchFocused: Bool
    /// The inline new-folder field is open.
    @State private var creating = false
    @State private var newName = ""
    @FocusState private var nameFocused: Bool
    @State private var busy = false
    @State private var confirmError: String?
    @State private var detent: PresentationDetent = .medium

    private var allGroups: [FolderGroup] { groups + loadedGroups }

    private var trimmedQuery: String { FolderSearch.normalized(query) }

    /// Headings only once there is more than one scope to tell apart.
    private var showsHeadings: Bool { allGroups.count > 1 }

    private var personalFolders: [CloudFolder] {
        allGroups.first { $0.orgId == nil }?.folders ?? []
    }

    /// Suggestions that are real personal folders and match the search, so
    /// the section never offers something the list below could not.
    private var suggestedMatches: [CloudFolder] {
        let live = Set(personalFolders.map(\.id))
        return FolderSearch.filter(suggested.filter { live.contains($0.id) }, query: query)
    }

    private func matches(_ group: FolderGroup) -> [CloudFolder] {
        FolderSearch.filter(group.folders, query: query)
    }

    /// A scope's top level answers to its own label like a folder does.
    private func showsRoot(_ group: FolderGroup) -> Bool {
        FolderSearch.matches(rootLabel(group), query: query)
    }

    private var nothingMatches: Bool {
        allGroups.allSatisfy { matches($0).isEmpty && !showsRoot($0) }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            searchField
            Rectangle()
                .fill(Color(.separator))
                .frame(height: 0.5)
            list
        }
        .background(Theme.background)
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
        // Typing at the medium detent puts the keyboard over most of the list;
        // someone who reached for the field wants the room.
        .onChange(of: searchFocused) { _, focused in
            if focused { detent = .large }
        }
        .onChange(of: nameFocused) { _, focused in
            if focused { detent = .large }
        }
        .task {
            guard let loadMoreGroups else { return }
            loadedGroups = await loadMoreGroups()
        }
    }

    // MARK: header

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Button("Cancel") { dismiss() }
                    .font(.parley.body)
                Spacer(minLength: 8)
                Text(title)
                    .font(.parley.headline)
                    .foregroundStyle(Color(.label))
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                if busy {
                    ProgressView()
                } else {
                    Button(confirm.title) { commit() }
                        .font(.parley.bodyEmphasized)
                        .disabled(selection == nil)
                }
            }
            Text(verbatim: subtitle)
                .font(.parley.footnote)
                .foregroundStyle(Color(.secondaryLabel))
                .frame(maxWidth: .infinity)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if let confirmError {
                Text(verbatim: confirmError)
                    .font(.parley.footnote)
                    .foregroundStyle(Theme.destructive)
                    .frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 22)
        .padding(.bottom, 10)
    }

    /// What confirming will do, in a sentence. A personal recording going to an
    /// organization is a copy, and that is the one outcome a user could not
    /// guess from the row they tapped.
    private var subtitle: String {
        guard let selection else { return String(localized: "Tap a folder to select it.") }
        let label = label(for: selection)
        if current.orgId == nil, selection.orgId != nil {
            return String(
                localized: "Shares a copy to “\(label)”. The original stays in Personal.")
        }
        return String(localized: "Into “\(label)”.")
    }

    /// Hand-built rather than `.searchable`, for the reason `RecordingDetailView`
    /// gives for its own: this sheet has no navigation bar to put a search
    /// drawer in, and it does not need one. Page-coloured with a hairline under
    /// it, the same chrome as the transcript's search field.
    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(Color(.tertiaryLabel))
                .accessibilityHidden(true)
            TextField("Search folders", text: $query)
                .focused($searchFocused)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .submitLabel(.search)
                .onSubmit { submitSearch() }
            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Color(.tertiaryLabel))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear")
            }
        }
        .font(.parley.body)
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
    }

    // MARK: list

    private var list: some View {
        List {
            if canCreate {
                createRow
                    .modifier(PickerRow())
            }
            if case .newFolder(let name) = selection {
                row(
                    title: name, caption: String(localized: "New folder"),
                    systemImage: "folder.badge.plus", destination: .newFolder(name: name))
            }
            // Section labels are rows rather than `Section` headers: a plain
            // list pins its headers on a material fill, which is exactly the
            // tinted block this page does without.
            if !suggestedMatches.isEmpty {
                sectionLabel(String(localized: "Suggested"), systemImage: nil, caption: nil)
                ForEach(suggestedMatches) { folderRow($0, orgId: nil) }
            }
            ForEach(allGroups) { group in
                groupRows(group)
            }
            if nothingMatches && !canCreate {
                Text("No folders match.")
                    .font(.parley.subheadline)
                    .foregroundStyle(Color(.secondaryLabel))
                    .modifier(PickerRow())
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .environment(\.defaultMinListRowHeight, 44)
    }

    @ViewBuilder
    private func groupRows(_ group: FolderGroup) -> some View {
        let folders = matches(group)
        let root = showsRoot(group)
        if folders.isEmpty && !root {
            EmptyView()
        } else {
            if showsHeadings || !suggestedMatches.isEmpty {
                if group.orgId == nil {
                    sectionLabel(group.name, systemImage: "person", caption: nil)
                } else {
                    sectionLabel(
                        group.name, systemImage: "person.2",
                        caption: String(localized: "Organization"))
                }
            }
            ForEach(folders) { folderRow($0, orgId: group.orgId) }
            if root {
                row(
                    title: rootLabel(group), caption: nil,
                    systemImage: group.orgId == nil ? "tray" : "tray.full",
                    destination: .root(orgId: group.orgId))
            }
        }
    }

    // MARK: rows

    private func folderRow(_ folder: CloudFolder, orgId: String?) -> some View {
        row(
            title: folder.name, caption: nil, systemImage: "folder",
            destination: .folder(id: folder.id, orgId: orgId))
    }

    /// `title` is a folder's own name or an already-localized label, so it is
    /// drawn verbatim either way.
    private func row(
        title: String, caption: String?, systemImage: String, destination: FolderDestination
    ) -> some View {
        let isCurrent = destination == current
        let isSelected = destination == selection
        return Button {
            select(destination)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: systemImage)
                    .font(.parley.body)
                    .foregroundStyle(isSelected ? Theme.primary : Color(.secondaryLabel))
                    .frame(width: 24)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: title)
                        .font(isSelected ? .parley.bodyEmphasized : .parley.body)
                        .foregroundStyle(Color(.label))
                        .lineLimit(2)
                    if let caption = isCurrent ? String(localized: "Here now") : caption {
                        Text(verbatim: caption)
                            .font(.parley.caption)
                            .foregroundStyle(Color(.secondaryLabel))
                    }
                }
                Spacer(minLength: 8)
                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.parley.body.weight(.semibold))
                        .foregroundStyle(Theme.primary)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy || isCurrent)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .modifier(PickerRow())
    }

    /// Closed: one blue row, "New folder…", or "Create “<the search>”" when the
    /// search found nothing. Open: the name field, prefilled from the search,
    /// and Add, which selects the new name. The folder itself is made on
    /// confirm.
    @ViewBuilder
    private var createRow: some View {
        if creating {
            HStack(spacing: 12) {
                Image(systemName: "folder.badge.plus")
                    .font(.parley.body)
                    .foregroundStyle(Color(.secondaryLabel))
                    .frame(width: 24)
                    .accessibilityHidden(true)
                TextField("Folder name", text: $newName)
                    .font(.parley.body)
                    .focused($nameFocused)
                    .submitLabel(.done)
                    .onSubmit { selectNewName() }
                    .disabled(busy)
                Button("Add") { selectNewName() }
                    .font(.parley.bodyEmphasized)
                    .buttonStyle(.borderless)
                    .disabled(FolderSearch.normalized(newName).isEmpty || busy)
            }
        } else {
            Button {
                openCreate()
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "folder.badge.plus")
                        .font(.parley.body)
                        .frame(width: 24)
                        .accessibilityHidden(true)
                    Group {
                        if !trimmedQuery.isEmpty && nothingMatches {
                            Text("Create “\(trimmedQuery)”")
                        } else {
                            Text("New folder…")
                        }
                    }
                    .font(.parley.body)
                    .lineLimit(2)
                    Spacer(minLength: 0)
                }
                .foregroundStyle(Theme.primary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(busy)
        }
    }

    /// A small `secondaryLabel` line above its rows: the app's section label,
    /// with the scope's glyph and, for an organization, the word saying so.
    private func sectionLabel(_ title: String, systemImage: String?, caption: String?)
        -> some View
    {
        HStack(spacing: 6) {
            if let systemImage {
                Image(systemName: systemImage)
                    .accessibilityHidden(true)
            }
            Text(verbatim: title)
                .lineLimit(1)
            if let caption {
                Text(verbatim: caption)
                    .font(.parley.caption2)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .overlay(
                        Capsule().strokeBorder(Color(.separator), lineWidth: 1))
            }
        }
        .font(.parley.footnote)
        .foregroundStyle(Color(.secondaryLabel))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .listRowInsets(EdgeInsets(top: 14, leading: 20, bottom: 2, trailing: 20))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    // MARK: labels

    private func rootLabel(_ group: FolderGroup) -> String {
        group.orgId == nil ? String(localized: "Unfiled") : String(localized: "Not in a folder")
    }

    /// The pick as one line: the folder for a personal one, the organization
    /// and the folder for an org one.
    private func label(for destination: FolderDestination) -> String {
        switch destination {
        case .newFolder(let name):
            return name
        case .root(let orgId):
            guard let orgId else { return String(localized: "Unfiled") }
            return allGroups.first { $0.orgId == orgId }?.name ?? ""
        case .folder(let id, let orgId):
            let group = allGroups.first { $0.orgId == orgId }
            let name = group?.folders.first { $0.id == id }?.name ?? ""
            guard orgId != nil, let group else { return name }
            return "\(group.name) · \(name)"
        }
    }

    // MARK: actions

    private func select(_ destination: FolderDestination) {
        guard !busy, destination != current else { return }
        confirmError = nil
        selection = destination
    }

    /// Return in the search field: one match is selected, no match opens the
    /// create row with the name already in it. Never a move.
    private func submitSearch() {
        guard !trimmedQuery.isEmpty else { return }
        let candidates = allGroups.flatMap { group in
            matches(group).map { FolderDestination.folder(id: $0.id, orgId: group.orgId) }
        }
        if candidates.count == 1, let only = candidates.first {
            select(only)
        } else if candidates.isEmpty, canCreate {
            openCreate()
        }
    }

    private func openCreate() {
        newName = trimmedQuery
        creating = true
        nameFocused = true
    }

    /// A name that already exists is that folder, not a second folder with the
    /// same customer in it.
    private func selectNewName() {
        let name = FolderSearch.normalized(newName)
        guard !name.isEmpty else { return }
        creating = false
        nameFocused = false
        if let existing = FolderSearch.exactMatch(personalFolders, query: name) {
            select(.folder(id: existing.id, orgId: nil))
        } else {
            select(.newFolder(name: name))
        }
    }

    private func commit() {
        guard let selection, !busy else { return }
        busy = true
        confirmError = nil
        let label = label(for: selection)
        Task { @MainActor in
            do {
                try await onConfirm(selection, label)
                dismiss()
            } catch {
                confirmError =
                    (error as? FilingError)?.message
                    ?? String(localized: "Move failed: \(error.localizedDescription)")
                busy = false
            }
        }
    }
}

extension FolderPickerSheet {
    enum ConfirmAction {
        case move
        case choose

        var title: LocalizedStringKey {
            switch self {
            case .move: return "Move"
            case .choose: return "Choose"
            }
        }
    }
}

/// Plain system rows on the page: the gutter the rest of the app uses, no
/// separators and no row fill (`ios-visual-language.md`, rule 3).
private struct PickerRow: ViewModifier {
    func body(content: Content) -> some View {
        content
            .listRowInsets(EdgeInsets(top: 10, leading: 20, bottom: 10, trailing: 20))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }
}

#if DEBUG
    #Preview("Folder picker") {
        Color.clear.sheet(isPresented: .constant(true)) {
            FolderPickerSheet(
                groups: [
                    .personal(ScreenshotDemo.pickerFolders),
                    FolderGroup(
                        orgId: ScreenshotDemo.orgs[0].id, name: ScreenshotDemo.orgs[0].name,
                        folders: ScreenshotDemo.orgFolders),
                ],
                current: .folder(id: ScreenshotDemo.pickerFolders[0].id, orgId: nil),
                suggested: Array(ScreenshotDemo.pickerFolders.prefix(2)),
                canCreate: true,
                onConfirm: { _, _ in })
        }
    }
#endif
