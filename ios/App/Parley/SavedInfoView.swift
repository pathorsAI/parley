import ParleyKit
import SwiftUI

/// Settings › 常用資訊: the name, phone numbers, addresses and IDs the Parley
/// keyboard offers on its strip and in its 📋 panel.
///
/// Editing lives here rather than on the keyboard because a keyboard is the
/// wrong place to type a form — it is the thing doing the typing. The keyboard
/// only reads these (and adds one when the user saves a copied phone number,
/// address or email from the panel).
///
/// Stored in the App Group (`SnippetStore`), on this phone only. 身分證字號 and
/// 統一編號 are drawn masked on the keyboard and never copied to the clipboard,
/// the polish, the dictionary or a log; here, on the user's own screen behind
/// their own unlock, they are shown as typed so they can be checked.
struct SavedInfoView: View {
    /// Read once per appearance: the keyboard may have added one from another
    /// process, and there is nothing to observe across that boundary.
    @State private var snippets: [Snippet] = []
    @State private var editing: Draft?

    /// The sheet's subject: a snippet, and whether it is a new one.
    struct Draft: Identifiable {
        var snippet: Snippet
        var isNew: Bool
        var id: UUID { snippet.id }
    }

    var body: some View {
        Form {
            Section {
                if snippets.isEmpty {
                    Text("Nothing saved yet.")
                        .font(.parley.subheadline)
                        .foregroundStyle(Color(.secondaryLabel))
                }
                ForEach(snippets) { snippet in
                    Button {
                        editing = Draft(snippet: snippet, isNew: false)
                    } label: {
                        row(snippet)
                    }
                    .buttonStyle(.plain)
                }
                .onDelete(perform: delete)
                .onMove(perform: move)
                Button {
                    editing = Draft(
                        snippet: Snippet(kind: .mobile, label: "", value: ""), isNew: true)
                } label: {
                    Label("Add", systemImage: "plus")
                }
            } footer: {
                SettingsSection.footer("Tap one on the Parley keyboard's 📋 panel to type it. Email, phone and address fields also suggest the matching one on the keyboard's top row. Everything here stays on this phone.")
            }
        }
        // Pushed from Settings, so it keeps Settings' surfaces — see
        // `SettingsSection`.
        .font(.parley.body)
        .environment(\.defaultMinListRowHeight, 48)
        .navigationTitle("Saved info")
        .toolbar {
            if snippets.count > 1 { EditButton() }
        }
        .onAppear(perform: reload)
        .sheet(item: $editing) { draft in
            SavedInfoEditor(
                draft: draft.snippet, isNew: draft.isNew,
                save: { save($0, isNew: draft.isNew) },
                delete: draft.isNew ? nil : { remove(draft.snippet.id) })
        }
    }

    private func row(_ snippet: Snippet) -> some View {
        HStack(spacing: 12) {
            Image(systemName: snippet.kind.symbolName)
                .foregroundStyle(Color(.secondaryLabel))
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: snippet.label.isEmpty ? snippet.kind.displayName : snippet.label)
                    .font(.parley.caption)
                    .foregroundStyle(Color(.secondaryLabel))
                Text(verbatim: snippet.value)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .padding(.vertical, 2)
    }

    // MARK: editing

    private var store: SnippetStore? { SnippetStore.shared() }

    private func reload() {
        snippets = store?.load() ?? []
    }

    private func persist() {
        store?.save(snippets)
        // A sensitive value just saved may already sit in the clipboard
        // history as plain text — copied before it was saved here. It goes now,
        // and the history refuses it from here on (`ClipboardRules`).
        ClipboardHistoryStore.shared()?.remove(
            matching: SnippetStore.sensitiveValues(in: snippets))
    }

    private func save(_ snippet: Snippet, isNew: Bool) {
        if let i = snippets.firstIndex(where: { $0.id == snippet.id }) {
            snippets[i] = snippet
        } else {
            snippets.append(snippet)
        }
        persist()
    }

    private func remove(_ id: UUID) {
        snippets.removeAll { $0.id == id }
        persist()
    }

    private func delete(_ offsets: IndexSet) {
        snippets.remove(atOffsets: offsets)
        persist()
    }

    private func move(_ from: IndexSet, _ to: Int) {
        snippets.move(fromOffsets: from, toOffset: to)
        persist()
    }
}

/// One snippet's form, with an explicit Save: a half-typed phone number must
/// not reach the keyboard because the user switched fields.
struct SavedInfoEditor: View {
    @State var draft: Snippet
    let isNew: Bool
    let save: (Snippet) -> Void
    let delete: (() -> Void)?
    @Environment(\.dismiss) private var dismiss
    @State private var showDeleteConfirmation = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Kind", selection: $draft.kind) {
                        ForEach(SnippetKind.allCases) { kind in
                            Label(kind.displayName, systemImage: kind.symbolName).tag(kind)
                        }
                    }
                    TextField(
                        "Label", text: $draft.label,
                        prompt: draft.kind == .custom
                            ? Text("Label (required)") : Text(verbatim: draft.kind.displayName))
                    TextField("Value", text: $draft.value, axis: .vertical)
                        .lineLimit(1...4)
                        .keyboardType(keyboardType)
                        .textInputAutocapitalization(capitalization)
                        .autocorrectionDisabled()
                    if let hint {
                        Label(hint, systemImage: "exclamationmark.triangle")
                            .font(.parley.caption)
                            .foregroundStyle(Theme.warning)
                    }
                } footer: {
                    if draft.kind.isSensitive {
                        SettingsSection.footer("The keyboard shows this masked, like A1••••••89, and types the whole number when you tap it. It is never copied to the clipboard.")
                    }
                }
                if let delete {
                    Section {
                        Button("Delete", role: .destructive) { showDeleteConfirmation = true }
                            .confirmationDialog(
                                "Delete this saved info?", isPresented: $showDeleteConfirmation,
                                titleVisibility: .visible
                            ) {
                                Button("Delete", role: .destructive) {
                                    delete()
                                    dismiss()
                                }
                            }
                    }
                }
            }
            .font(.parley.body)
            .navigationTitle(isNew ? Text("New saved info") : Text("Edit saved info"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        save(finished)
                        dismiss()
                    }
                    .font(.parley.bodyEmphasized)
                    .disabled(!canSave)
                }
            }
        }
    }

    /// A value, and for 自訂 a label — every other kind falls back to its own
    /// name.
    private var canSave: Bool {
        let value = draft.value.trimmingCharacters(in: .whitespacesAndNewlines)
        let label = draft.label.trimmingCharacters(in: .whitespacesAndNewlines)
        return !value.isEmpty && (draft.kind != .custom || !label.isEmpty)
    }

    private var finished: Snippet {
        var out = draft
        out.value = draft.value.trimmingCharacters(in: .whitespacesAndNewlines)
        let label = draft.label.trimmingCharacters(in: .whitespacesAndNewlines)
        out.label = label.isEmpty ? draft.kind.displayName : label
        out.updatedAt = Date()
        return out
    }

    /// A hint, never a refusal — see `SnippetValidation`.
    private var hint: LocalizedStringKey? {
        switch SnippetValidation.hint(for: draft.kind, value: draft.value) {
        case .nationalIDFormat?:
            return "This doesn't look like a Taiwan ID number (one letter and nine digits). You can still save it."
        case .taxIDFormat?:
            return "A tax ID number is usually eight digits. You can still save it."
        case .emailFormat?:
            return "This doesn't look like an email address. You can still save it."
        case .mobileFormat?:
            return "This doesn't look like a mobile number, such as 0912-345-678. You can still save it."
        case .phoneFormat?:
            return "This doesn't look like a phone number. You can still save it."
        case nil:
            return nil
        }
    }

    private var keyboardType: UIKeyboardType {
        switch draft.kind {
        case .mobile, .phone: return .phonePad
        case .email: return .emailAddress
        case .taxID: return .numberPad
        default: return .default
        }
    }

    private var capitalization: TextInputAutocapitalization {
        switch draft.kind {
        case .email: return .never
        case .nationalID: return .characters
        default: return .sentences
        }
    }
}
