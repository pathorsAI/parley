import ParleyKit
import SwiftUI

/// "Move to folder": the personal folders as a searchable list, in a sheet.
///
/// This replaced a `.confirmationDialog`. An action sheet is fine for four
/// choices and hopeless for forty — and a folder is a customer, so forty is
/// what a working account has. The dialog was a scrolling wall of pill buttons
/// with no way to type the name you already know, and a customer met for the
/// first time meant scrolling all the way down, past every other customer, to
/// "New folder…". Here the search field is the first thing under the title,
/// and a name that matches nothing turns the first row into "Create “…”" — so
/// filing a call with a new customer is: type the name, tap the top row, tap
/// Create.
///
/// Plain rows on the page, no cards and no fills (`ios-visual-language.md`).
/// Blue appears where it means something: the current folder's checkmark and
/// the create action.
///
/// The sheet decides nothing about *how* a recording moves. `onSelect` is the
/// caller's own move (a meta re-push for a personal recording, a PATCH for an
/// org one, a local write for the sample), and `onCreate` is the caller's
/// create-then-move — nil where there is no endpoint to create a folder with,
/// which hides the row rather than offering something that cannot work.
struct FolderPickerSheet: View {
    let folders: [CloudFolder]
    /// Where the recording is filed now; nil is Unfiled.
    let currentFolderId: String?
    /// Folders to offer above the full list — the filing suggestion's picks.
    /// Empty hides the section.
    var suggested: [CloudFolder] = []
    /// A folder was picked (nil = Unfiled). Not called for the folder the
    /// recording is already in. The sheet dismisses itself either way.
    let onSelect: (String?) -> Void
    /// Create a folder with this name and move the recording into it. A throw
    /// keeps the sheet up with the error under the field; a return dismisses.
    var onCreate: ((String) async throws -> Void)?

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @FocusState private var searchFocused: Bool
    /// The inline new-folder field is open.
    @State private var creating = false
    @State private var newName = ""
    @FocusState private var nameFocused: Bool
    @State private var busy = false
    @State private var createError: String?
    @State private var detent: PresentationDetent = .medium

    private var matches: [CloudFolder] { FolderSearch.filter(folders, query: query) }

    /// Suggestions that are real folders and match the search, so the section
    /// never offers something the list below could not.
    private var suggestedMatches: [CloudFolder] {
        let live = Set(folders.map(\.id))
        return FolderSearch.filter(suggested.filter { live.contains($0.id) }, query: query)
    }

    private var trimmedQuery: String { FolderSearch.normalized(query) }

    /// Unfiled is a place too; it answers to its own name like a folder does.
    private var showsUnfiled: Bool {
        FolderSearch.matches(String(localized: "Unfiled"), query: query)
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
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Move to folder")
                    .font(.parley.headline)
                    .foregroundStyle(Color(.label))
                Text("One customer, one folder.")
                    .font(.parley.footnote)
                    .foregroundStyle(Color(.secondaryLabel))
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            Button("Cancel") { dismiss() }
                .font(.parley.body)
        }
        .padding(.horizontal, 20)
        .padding(.top, 22)
        .padding(.bottom, 10)
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

    private var list: some View {
        List {
            if onCreate != nil {
                createRow
                    .modifier(PickerRow())
            }
            // Section labels are rows rather than `Section` headers: a plain
            // list pins its headers on a material fill, which is exactly the
            // tinted block this page does without.
            if !suggestedMatches.isEmpty {
                sectionLabel("Suggested")
                ForEach(suggestedMatches) { folderRow($0) }
                sectionLabel("All folders")
            }
            ForEach(matches) { folderRow($0) }
            if showsUnfiled {
                row(
                    title: String(localized: "Unfiled"), systemImage: "tray",
                    isCurrent: currentFolderId == nil
                ) { select(nil) }
            }
            if matches.isEmpty && !showsUnfiled && onCreate == nil {
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

    // MARK: rows

    private func folderRow(_ folder: CloudFolder) -> some View {
        row(title: folder.name, systemImage: "folder", isCurrent: folder.id == currentFolderId) {
            select(folder.id)
        }
    }

    /// `title` is a folder's own name or an already-localized label, so it is
    /// drawn verbatim either way.
    private func row(
        title: String, systemImage: String, isCurrent: Bool, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: systemImage)
                    .font(.parley.body)
                    .foregroundStyle(Color(.secondaryLabel))
                    .frame(width: 24)
                    .accessibilityHidden(true)
                Text(verbatim: title)
                    .font(.parley.body)
                    .foregroundStyle(Color(.label))
                    .lineLimit(2)
                Spacer(minLength: 8)
                if isCurrent {
                    Image(systemName: "checkmark")
                        .font(.parley.body.weight(.semibold))
                        .foregroundStyle(Theme.primary)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
        .modifier(PickerRow())
    }

    /// Closed: one blue row, "New folder…" — or, when the search found nothing,
    /// "Create “<the search>”", because that is what the user is about to ask for.
    /// Open: the name field, prefilled from the search, and Create.
    @ViewBuilder
    private var createRow: some View {
        if creating {
            VStack(alignment: .leading, spacing: 6) {
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
                        .onSubmit { create() }
                        .disabled(busy)
                    if busy {
                        ProgressView()
                    } else {
                        Button("Create") { create() }
                            .font(.parley.bodyEmphasized)
                            .buttonStyle(.borderless)
                            .disabled(FolderSearch.normalized(newName).isEmpty)
                    }
                }
                if let createError {
                    Text(verbatim: createError)
                        .font(.parley.footnote)
                        .foregroundStyle(Theme.destructive)
                        .fixedSize(horizontal: false, vertical: true)
                }
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
                        if !trimmedQuery.isEmpty && matches.isEmpty {
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
        }
    }

    /// A small `secondaryLabel` line above its rows — the app's section label.
    private func sectionLabel(_ title: LocalizedStringKey) -> some View {
        Text(title)
            .font(.parley.footnote)
            .foregroundStyle(Color(.secondaryLabel))
            .accessibilityAddTraits(.isHeader)
            .listRowInsets(EdgeInsets(top: 14, leading: 20, bottom: 2, trailing: 20))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }

    // MARK: actions

    private func select(_ folderId: String?) {
        guard !busy else { return }
        if folderId != currentFolderId { onSelect(folderId) }
        dismiss()
    }

    /// Return in the search field: one match is a pick, no match is the create
    /// row opened with the name already in it.
    private func submitSearch() {
        guard !trimmedQuery.isEmpty else { return }
        if matches.count == 1, let only = matches.first {
            select(only.id)
        } else if matches.isEmpty, onCreate != nil {
            openCreate()
        }
    }

    private func openCreate() {
        newName = trimmedQuery
        createError = nil
        creating = true
        nameFocused = true
    }

    /// A name that already exists is a pick, not a second folder with the same
    /// customer in it.
    private func create() {
        let name = FolderSearch.normalized(newName)
        guard !name.isEmpty, !busy, let onCreate else { return }
        if let existing = FolderSearch.exactMatch(folders, query: name) {
            select(existing.id)
            return
        }
        busy = true
        createError = nil
        Task { @MainActor in
            do {
                try await onCreate(name)
                dismiss()
            } catch {
                createError = String(
                    localized: "Couldn't create the folder: \(error.localizedDescription)")
                busy = false
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
                folders: ScreenshotDemo.pickerFolders,
                currentFolderId: ScreenshotDemo.pickerFolders[0].id,
                suggested: Array(ScreenshotDemo.pickerFolders.prefix(2)),
                onSelect: { _ in },
                onCreate: { _ in })
        }
    }
#endif
