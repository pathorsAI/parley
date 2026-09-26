import ParleyKit
import SwiftUI

/// Library › Voice typing: what the user has dictated, newest first, one tap
/// from being copied again (pathorsAI/parley#290).
///
/// **Copy is the row's primary action**, on the row itself rather than behind
/// the detail sheet. Someone arriving here has just watched their words fail to
/// land in another app; the one thing they want is those words back on the
/// clipboard, and every extra tap is a tap between them and pasting. The sheet
/// is for reading a long entry in full, sharing it, or deleting it.
struct DictationHistoryList: View {
    /// The Library's search text, applied to the transcript.
    let search: String

    @ObservedObject private var history = DictationHistory.shared
    @AppStorage(DictationHistoryStore.enabledKey) private var keepHistory = true
    @State private var opened: DictationHistoryEntry?
    /// The row whose copy button just fired, for its brief "Copied".
    @State private var copiedID: UUID?
    @State private var revert: Task<Void, Never>?

    var body: some View {
        List {
            ForEach(items) { entry in
                row(entry)
                    .listRowInsets(EdgeInsets(top: 12, leading: 20, bottom: 12, trailing: 12))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                    // Leading, the same edge split the meeting rows use: nothing
                    // on this edge removes anything.
                    .swipeActions(edge: .leading) {
                        Button("Copy", systemImage: "doc.on.doc") { copy(entry) }
                            .tint(Theme.primary)
                    }
                    .swipeActions(edge: .trailing) {
                        Button("Delete", systemImage: "trash", role: .destructive) {
                            withAnimation { history.delete(entry.id) }
                        }
                    }
            }
            if items.isEmpty {
                emptyState
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        // Entries age out while the app is not looking; arriving here prunes.
        .onAppear { history.reload() }
        .sheet(item: $opened) { entry in
            DictationHistoryDetail(entry: entry) {
                history.delete(entry.id)
                opened = nil
            }
        }
    }

    private var items: [DictationHistoryEntry] {
        guard !search.isEmpty else { return history.entries }
        return history.entries.filter { $0.text.localizedCaseInsensitiveContains(search) }
    }

    private func row(_ entry: DictationHistoryEntry) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 7) {
                Text(verbatim: entry.text)
                    .font(.parley.subheadline)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                DictationHistoryMeta(entry: entry)
                    .font(.parley.caption2.monospacedDigit())
                    .foregroundStyle(Color(.secondaryLabel))
            }
            .contentShape(Rectangle())
            .onTapGesture { opened = entry }
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { opened = entry }

            copyButton(entry)
        }
    }

    /// Borderless, so a tap on it is the button's and not the row's.
    private func copyButton(_ entry: DictationHistoryEntry) -> some View {
        let copied = copiedID == entry.id
        return Button {
            copy(entry)
        } label: {
            VStack(spacing: 3) {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.parley.body)
                    .contentTransition(.symbolEffect(.replace))
                    .frame(width: 44, height: 28)
                Text("Copied")
                    .font(.parley.caption2)
                    .opacity(copied ? 1 : 0)
            }
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(copied ? Text("Copied") : Text("Copy"))
    }

    private func copy(_ entry: DictationHistoryEntry) {
        TranscriptClipboard.write(entry.text)
        withAnimation { copiedID = entry.id }
        revert?.cancel()
        revert = Task {
            try? await Task.sleep(for: .seconds(1.5))
            guard !Task.isCancelled else { return }
            withAnimation { copiedID = nil }
        }
    }

    /// Same shape as the meeting list's empty state: the glyph, the sentence,
    /// room around it. With the switch off it says so, because "nothing here"
    /// would otherwise read as dictations being lost.
    private var emptyState: some View {
        VStack(spacing: 18) {
            Image(systemName: search.isEmpty ? "mic" : "magnifyingglass")
                .font(.parley.title)
                .foregroundStyle(Color(.tertiaryLabel))
                .accessibilityHidden(true)
            Group {
                if !search.isEmpty {
                    Text("No matches.")
                } else if keepHistory {
                    Text("What you dictate with the Parley keyboard shows up here, so you can copy it again if it didn't land.")
                } else {
                    Text("Voice typing history is off. Turn it on in Settings › Voice typing history.")
                }
            }
            .font(.parley.subheadline)
            .foregroundStyle(Color(.secondaryLabel))
            .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 56)
        .padding(.horizontal, 12)
        .padding(.bottom, 24)
    }
}

/// When, how long, and where — the row's meta line.
private struct DictationHistoryMeta: View {
    let entry: DictationHistoryEntry

    var body: some View {
        HStack(spacing: 10) {
            Text(entry.startedAt, format: .relative(presentation: .named))
                .fixedSize()
            Label(DictationHistory.duration(entry.durationMs), systemImage: "clock")
                .fixedSize()
            if let app = DictationHistory.appName(for: entry.hostBundleID) {
                Label(app, systemImage: "arrow.turn.down.right")
                    .lineLimit(1)
            }
        }
        .lineLimit(1)
        .labelStyle(DictationMetaLabelStyle())
    }
}

private struct DictationMetaLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon
            configuration.title
        }
    }
}

/// One entry in full: the whole text (selectable), when, how long, which app,
/// and copy / share / delete.
private struct DictationHistoryDetail: View {
    let entry: DictationHistoryEntry
    let delete: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var copied = false
    @State private var confirmDelete = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(verbatim: entry.text)
                        .font(.parley.body)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    VStack(spacing: 10) {
                        LabeledContent("When") {
                            Text(entry.startedAt.formatted(
                                .dateTime.month(.abbreviated).day().hour().minute()))
                        }
                        LabeledContent("How long") {
                            Text(verbatim: DictationHistory.duration(entry.durationMs))
                                .monospacedDigit()
                        }
                        if let app = DictationHistory.appName(for: entry.hostBundleID) {
                            LabeledContent("Went to") { Text(verbatim: app) }
                        }
                        LabeledContent("Started from") {
                            entry.source == .actionButton
                                ? Text("Action Button") : Text("Parley keyboard")
                        }
                    }
                    .font(.parley.subheadline)
                    .foregroundStyle(Color(.secondaryLabel))
                }
                .padding(20)
            }
            .background(Theme.background)
            .navigationTitle("Voice typing")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom) { actions }
            .confirmationDialog(
                "Delete this entry?", isPresented: $confirmDelete, titleVisibility: .visible
            ) {
                Button("Delete", role: .destructive) { delete() }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var actions: some View {
        HStack(spacing: 12) {
            Button {
                TranscriptClipboard.write(entry.text)
                withAnimation { copied = true }
            } label: {
                Label(
                    copied ? LocalizedStringKey("Copied") : LocalizedStringKey("Copy"),
                    systemImage: copied ? "checkmark" : "doc.on.doc"
                )
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)

            ShareLink(item: entry.text) {
                Label("Share", systemImage: "square.and.arrow.up")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)

            Button(role: .destructive) {
                confirmDelete = true
            } label: {
                Image(systemName: "trash")
                    .padding(.horizontal, 4)
            }
            .buttonStyle(.bordered)
            .tint(Theme.destructive)
            .accessibilityLabel(Text("Delete"))
        }
        .font(.parley.bodyEmphasized)
        .controlSize(.large)
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .background(.bar)
    }
}
