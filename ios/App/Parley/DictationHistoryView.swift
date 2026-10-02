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
///
/// **Each row says whether its text was AI-polished**, and when it was not, why
/// (1.25). The polish falls back to the raw words silently — by design, since
/// none of its failures is worth interrupting someone's typing for — and that
/// made "sometimes it looks unpolished" unanswerable. The label is the answer,
/// kept quiet: one caption line, accent for polished, secondary for the rest.
///
/// **The original of a polished entry is one tap away on the row**, as a
/// "Show original" / "Show polished" toggle beside that label, rather than in a
/// context menu. The row's design is "everything worth doing is visible and one
/// tap": copy is a button on the row, not a menu item, and the reason is the
/// same — the person comparing the two versions wants to *see* the difference,
/// and a long-press menu offering "Copy original" copies it blind. So the
/// toggle swaps the text in place, and every copy on the row (the button, the
/// swipe, the detail sheet it opens) takes whichever version is showing.
///
/// **A misheard word can be taught from here** ("Fix this word"): select it in
/// the detail sheet, or long-press a row. The keyboard only learns from fixes
/// made while it is still up in the same field, and most fixes are not —
/// they happen in the Apple keyboard, or after the message has gone. The pair
/// goes into the personal dictionary already confirmed, and the entry itself is
/// corrected (its original words are kept; see `DictationHistoryStore.correct`).
struct DictationHistoryList: View {
    /// The Library's search text, applied to the transcript.
    let search: String

    @ObservedObject private var history = DictationHistory.shared
    @AppStorage(DictationHistoryStore.enabledKey) private var keepHistory = true
    @State private var opened: DictationHistoryEntry?
    /// The row whose copy button just fired, for its brief "Copied".
    @State private var copiedID: UUID?
    @State private var revert: Task<Void, Never>?
    /// Polished rows currently showing their original. Per screen visit, not
    /// persisted: the polished text is what was inserted, so it is what a row
    /// should say when the list is next opened.
    @State private var showingOriginal: Set<UUID> = []
    /// "Fix a word" from a row's long-press menu.
    @State private var correction: LexiconCorrectionDraft?

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
                    // The row shows three lines at most, so nothing here is
                    // selected; the sheet opens empty. Selecting the word in
                    // the detail sheet is the path that prefills it.
                    .contextMenu {
                        Button("Fix a word", systemImage: "character.cursor.ibeam") {
                            correction = LexiconCorrectionDraft(heard: "", entryID: entry.id)
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
            DictationHistoryDetail(
                entry: entry, text: shownText(entry), showsOriginal: isShowingOriginal(entry)
            ) {
                history.delete(entry.id)
                opened = nil
            }
        }
        .sheet(item: $correction) { draft in
            LexiconCorrectionSheet(heard: draft.heard) { original, replacement in
                history.correct(draft.entryID, original: original, replacement: replacement)
            }
        }
    }

    /// The transcript matches whichever version holds the words: someone
    /// searching for what they *said* should find a polished entry that
    /// reworded it.
    private var items: [DictationHistoryEntry] {
        guard !search.isEmpty else { return history.entries }
        return history.entries.filter {
            $0.text.localizedCaseInsensitiveContains(search)
                || ($0.rawText?.localizedCaseInsensitiveContains(search) ?? false)
        }
    }

    /// The row is showing the original of a polished entry.
    private func isShowingOriginal(_ entry: DictationHistoryEntry) -> Bool {
        entry.rawText != nil && showingOriginal.contains(entry.id)
    }

    /// What the row shows, and so what every copy on it takes.
    private func shownText(_ entry: DictationHistoryEntry) -> String {
        isShowingOriginal(entry) ? entry.rawText ?? entry.text : entry.text
    }

    private func row(_ entry: DictationHistoryEntry) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 7) {
                Text(verbatim: shownText(entry))
                    .font(.parley.subheadline)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let outcome = entry.polish {
                    polishLine(entry, outcome: outcome)
                }
                if let ending = entry.ending {
                    // Quiet, like the polish line: it answers "why did this
                    // stop there", which is only a question once someone is
                    // looking.
                    Label(DictationHistory.endingLabel(ending), systemImage: "stop.circle")
                        .labelStyle(DictationMetaLabelStyle())
                        .font(.parley.caption)
                        .foregroundStyle(Color(.secondaryLabel))
                        .lineLimit(1)
                }
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

    /// "Polished" in the accent, or "Original · <why>" in secondary — and, on
    /// a polished entry that kept its original, the toggle between the two.
    /// The label describes the text above it: while the original is showing
    /// it reads "Original", so the words and the label never disagree. Entries
    /// from before 1.25 have no outcome and get no line at all.
    private func polishLine(_ entry: DictationHistoryEntry, outcome: PolishOutcome) -> some View {
        let original = isShowingOriginal(entry)
        return HStack(spacing: 10) {
            Group {
                if original {
                    Text("Original")
                        .foregroundStyle(Color(.secondaryLabel))
                } else {
                    Text(verbatim: DictationHistory.polishLabel(outcome))
                        .foregroundStyle(outcome.isPolished ? Theme.primary : Color(.secondaryLabel))
                }
            }
            .lineLimit(1)
            if entry.rawText != nil {
                // Borderless, for the same reason the copy button is: a tap on
                // it is the toggle's, not the row's.
                Button {
                    withAnimation(.snappy) {
                        if original {
                            showingOriginal.remove(entry.id)
                        } else {
                            showingOriginal.insert(entry.id)
                        }
                    }
                } label: {
                    Label(
                        original ? "Show polished" : "Show original",
                        systemImage: "arrow.left.arrow.right"
                    )
                    .labelStyle(DictationMetaLabelStyle())
                    .foregroundStyle(Theme.primary)
                }
                .buttonStyle(.borderless)
                .lineLimit(1)
            }
        }
        .font(.parley.caption)
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
        TranscriptClipboard.write(shownText(entry))
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

/// One entry in full: the whole text (selectable, with "Fix this word" on the
/// selection), when, how long, which app, and copy / share / delete.
private struct DictationHistoryDetail: View {
    let entry: DictationHistoryEntry
    /// The row was showing the original of a polished entry. A correction
    /// rewrites the entry's text and never its original, so the words on this
    /// sheet only change when they *are* that text.
    let showsOriginal: Bool
    let delete: () -> Void

    /// The version the row was showing when it was opened — the polished text,
    /// or its original — so the sheet's copy and share take what the user was
    /// just looking at. State rather than a constant so a correction made here
    /// shows at once.
    @State private var text: String
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false
    @State private var confirmDelete = false
    @State private var correction: LexiconCorrectionDraft?

    init(
        entry: DictationHistoryEntry, text: String, showsOriginal: Bool,
        delete: @escaping () -> Void
    ) {
        self.entry = entry
        self.showsOriginal = showsOriginal
        self.delete = delete
        _text = State(initialValue: text)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    SelectableTranscript(text: text) { selection in
                        correction = LexiconCorrectionDraft(heard: selection, entryID: entry.id)
                    }
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
            .sheet(item: $correction) { draft in
                LexiconCorrectionSheet(heard: draft.heard) { original, replacement in
                    let stored = DictationHistory.shared.correct(
                        draft.entryID, original: original, replacement: replacement)
                    if stored, !showsOriginal {
                        text = Lexicon.substitute(original, with: replacement, in: text).text
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var actions: some View {
        HStack(spacing: 12) {
            Button {
                TranscriptClipboard.write(text)
                withAnimation { copied = true }
            } label: {
                Label(
                    copied ? LocalizedStringKey("Copied") : LocalizedStringKey("Copy"),
                    systemImage: copied ? "checkmark" : "doc.on.doc"
                )
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)

            ShareLink(item: text) {
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

/// The detail sheet's transcript: selectable like `Text.textSelection`, plus
/// "Fix this word" in the menu that comes up over a selection.
///
/// A UIKit text view because SwiftUI's selectable `Text` has no way to add an
/// item to that menu, and the selection *is* the natural way to say "this
/// word": the user is looking at the misheard word when they decide to fix
/// it. Read-only, unscrolled (the sheet's `ScrollView` scrolls), and sized to
/// its text for the width it is offered.
private struct SelectableTranscript: UIViewRepresentable {
    let text: String
    let fix: (String) -> Void

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.adjustsFontForContentSizeCategory = true
        view.font = UIFontMetrics(forTextStyle: .body).scaledFont(
            for: UIFont(name: ParleyTypography.Face.regular, size: 17)
                ?? .preferredFont(forTextStyle: .body))
        view.textColor = .label
        view.delegate = context.coordinator
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.fix = fix
        if view.text != text { view.text = text }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite else { return nil }
        let fitted = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: ceil(fitted.height))
    }

    func makeCoordinator() -> Coordinator { Coordinator(fix: fix) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var fix: (String) -> Void

        init(fix: @escaping (String) -> Void) {
            self.fix = fix
        }

        /// First in the menu, ahead of Copy and Look Up: it is the one item
        /// here that is about this app rather than about text in general.
        func textView(
            _ textView: UITextView, editMenuForTextIn range: NSRange,
            suggestedActions: [UIMenuElement]
        ) -> UIMenu? {
            guard range.length > 0, let swiftRange = Range(range, in: textView.text) else {
                return UIMenu(children: suggestedActions)
            }
            let selection = String(textView.text[swiftRange])
            let action = UIAction(
                title: String(localized: "Fix this word"),
                image: UIImage(systemName: "character.cursor.ibeam")
            ) { [weak self] _ in
                self?.fix(selection)
            }
            return UIMenu(children: [action] + suggestedActions)
        }
    }
}
