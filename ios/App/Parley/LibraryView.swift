import ParleyKit
import SwiftUI
import UniformTypeIdentifiers

/// Library — phone mirror of the desktop History window: personal + org
/// scopes, one-level folders, and the same move semantics:
/// - share to org  = server-side COPY (original untouched)
/// - move to org   = share, then delete the personal original (that order —
///                   a mid-way failure must leave the original intact)
/// - personal folder move = meta re-push (POST full upsert)
/// - org folder move      = dedicated PATCH …/folder
struct LibraryView: View {
    @EnvironmentObject private var app: AppState

    /// nil = personal scope; else an org id.
    @State private var scope: String?
    @State private var folderFilter: String?
    @State private var recordings: [CloudRecordingSummary] = []
    @State private var folders: [CloudFolder] = []
    @State private var loading = false
    @State private var error: String?
    @State private var busyId: String?
    @State private var search = ""
    /// One importer for the whole screen, so every door — the toolbar button
    /// and the empty state — drives the same single in-flight import.
    @StateObject private var importer = RecordingImporter()
    @State private var importing = false
    /// What the last finished import landed, shown above the list until the
    /// user moves on. Failures go to `error` instead, with everything else.
    @State private var importNotice: String?
    #if DEBUG
        @ObservedObject private var demo = ScreenshotDemo.shared
    #endif

    var body: some View {
        NavigationStack {
            Group {
                if !app.signedIn {
                    unavailable
                } else {
                    list
                }
            }
            .background(Theme.background)
            .navigationTitle("Library")
            .toolbar {
                importButton
                scopeMenu
            }
            // `.audio` is the whole family — mp3, m4a, wav, aac, caf and the
            // rest — which is what the desktop's extension list adds up to.
            // Single selection: a transcription run takes one file, the same
            // arbitration the desktop settled on.
            .fileImporter(
                isPresented: $importing,
                allowedContentTypes: [.audio],
                allowsMultipleSelection: false
            ) { result in
                Task { await runImport(result) }
            }
            .searchable(text: $search, prompt: Text("Search titles and snippets"))
            .refreshable { await load() }
            .task(id: "\(scope ?? "personal")-\(app.signedIn)") { await load() }
            // `parley://demo/transcript` pushes the demo recording, so the
            // transcript frame is captured through the real navigation stack
            // (back chevron and all) rather than as a detached view.
            #if DEBUG
                .navigationDestination(isPresented: $demo.showTranscript) {
                    RecordingDetailView(summary: ScreenshotDemo.featured, orgId: nil)
                }
            #endif
        }
    }

    /// The library is the account's cloud recordings, so it needs a confirmed
    /// session — not just a stored token. Holding a token but failing `me()`
    /// means offline, which is a different message from being signed out.
    private var unavailable: some View {
        let title: String =
            app.hasAccount
            ? String(localized: "Can't reach the cloud right now")
            : String(localized: "Not signed in")
        let detail: String =
            app.hasAccount
            ? String(localized: "Your recordings load automatically once the network is back.")
            : String(localized: "Sign in under Settings → Account and your cloud recordings show up here.")
        return ContentUnavailableView(
            title, systemImage: "icloud.slash", description: Text(detail))
    }

    // MARK: import (desktop History "+ Import", phone-sized)

    /// Personal scope only. An org library is a different container, and the
    /// upload path files into the personal library first and shares from there
    /// — offering the button under an org would promise a destination the flow
    /// does not have.
    ///
    /// Icon-only, and declared before the scope menu so the scope switcher
    /// stays where it has always been: last, at the trailing edge, with room
    /// for an org name beside it on a small phone.
    @ToolbarContentBuilder
    private var importButton: some ToolbarContent {
        if scope == nil {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    importing = true
                } label: {
                    Label("Import audio", systemImage: "square.and.arrow.down")
                }
                .disabled(importer.isRunning)
            }
        }
    }

    // MARK: scope switcher (desktop sidebar, phone-sized)

    private var scopeMenu: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button {
                    scope = nil
                    folderFilter = nil
                    importNotice = nil
                } label: {
                    Label("Personal", systemImage: scope == nil ? "checkmark" : "folder")
                }
                ForEach(app.orgs) { org in
                    Button {
                        scope = org.id
                        folderFilter = nil
                        importNotice = nil
                    } label: {
                        Label(
                            org.name,
                            systemImage: scope == org.id ? "checkmark" : "person.2")
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: scope == nil ? "folder" : "person.2")
                    Text(verbatim: scopeName)
                }
                .font(.parley.subheadlineEmphasized)
            }
        }
    }

    private var scopeName: String {
        scope.flatMap { id in app.orgs.first { $0.id == id }?.name }
            ?? String(localized: "Personal")
    }

    // MARK: list

    private var list: some View {
        List {
            if !folders.isEmpty {
                folderChips
            }
            if importer.isRunning || importNotice != nil {
                importStatus
                    .listRowInsets(EdgeInsets(top: 10, leading: 20, bottom: 10, trailing: 20))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
            if let error {
                Text(error)
                    .font(.parley.caption)
                    .foregroundStyle(Theme.destructive)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
            ForEach(filtered) { rec in
                NavigationLink {
                    RecordingDetailView(summary: rec, orgId: scope)
                } label: {
                    RecordingCard(summary: rec, folders: folders)
                }
                .modifier(RecordingRow())
                .swipeActions(edge: .trailing) {
                    Button("Delete", systemImage: "trash", role: .destructive) {
                        Task { await remove(rec) }
                    }
                }
                .contextMenu { actions(for: rec) }
                .disabled(busyId == rec.id)
                .opacity(busyId == rec.id ? 0.5 : 1)
            }
            if !loading && filtered.isEmpty && error == nil {
                emptyState
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .overlay { if loading && recordings.isEmpty { ProgressView() } }
    }

    /// An import in flight, or the one that just landed.
    ///
    /// Decoding knows how far along it is, so it gets a real bar. Transcription
    /// does not — the cloud is polled until the job finishes, and on an hour of
    /// audio that is minutes — so it gets a spinner, which is the one thing on
    /// screen that visibly keeps moving while nothing else changes.
    @ViewBuilder
    private var importStatus: some View {
        switch importer.stage {
        case .decoding(let fraction):
            VStack(alignment: .leading, spacing: 8) {
                Text(verbatim: importer.stage.label)
                    .font(.parley.caption)
                    .foregroundStyle(Color(.secondaryLabel))
                // No tint named: the bar inherits the app's, which is the
                // signal blue, and this is a thing happening right now.
                ProgressView(value: fraction)
            }
        case .transcribing, .filing:
            HStack(spacing: 10) {
                ProgressView()
                Text(verbatim: importer.stage.label)
                    .font(.parley.caption)
                    .foregroundStyle(Color(.secondaryLabel))
            }
        case .idle:
            if let importNotice {
                Text(verbatim: importNotice)
                    .font(.parley.caption)
                    .foregroundStyle(Theme.success)
            }
        }
    }

    /// Same shape as the live screen's empty state: the glyph, the sentence, and
    /// enough room around it that "nothing here" reads as a deliberate state
    /// rather than a failed load. The glyph is a quiet mark on the page — it used
    /// to be brand blue on a tinted disc, which made the emptiest screen in the
    /// app the most decorated one.
    ///
    /// A library with nothing in it is also the second natural door into
    /// import, so it opens the very same `.fileImporter` the toolbar button
    /// does — one flow, two doors, the way the desktop routes every import
    /// affordance through one function.
    private var emptyState: some View {
        VStack(spacing: 18) {
            Image(systemName: search.isEmpty ? "rectangle.stack" : "magnifyingglass")
                .font(.parley.title)
                .foregroundStyle(Color(.tertiaryLabel))
                .accessibilityHidden(true)
            Text(search.isEmpty ? "No recordings here yet." : "No matches.")
                .font(.parley.subheadline)
                .foregroundStyle(Color(.secondaryLabel))
                .multilineTextAlignment(.center)
            if scope == nil && search.isEmpty {
                // A tappable thing, so it is blue — and nothing more than that:
                // it inherits the app's tint rather than carrying a fill.
                Button {
                    importing = true
                } label: {
                    Label("Import an audio file", systemImage: "square.and.arrow.down")
                        .font(.parley.subheadlineEmphasized)
                }
                .disabled(importer.isRunning)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 56)
        .padding(.bottom, 24)
    }

    private var folderChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip(String(localized: "All"), selected: folderFilter == nil) { folderFilter = nil }
                chip(String(localized: "Unfiled"), selected: folderFilter == "root") {
                    folderFilter = "root"
                }
                ForEach(folders) { f in
                    chip(f.name, selected: folderFilter == f.id) { folderFilter = f.id }
                }
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 2)
        }
        .listRowInsets(EdgeInsets(top: 8, leading: 20, bottom: 4, trailing: 20))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    /// `label` is either an already-localized chip name or a user-created folder
    /// name, so it renders verbatim either way.
    ///
    /// Selection is a blue label over a 1pt blue rule, not a filled pill. The
    /// pill was a fill behind content and it made the folder row the loudest
    /// thing above the list; an underline says "this one" using the same signal
    /// colour and no area at all. The rule is always laid out, transparent when
    /// unselected, so a chip does not change height on tap.
    private func chip(_ label: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 5) {
                Text(verbatim: label)
                    .font(.parley.caption.weight(selected ? .semibold : .regular))
                    .foregroundStyle(selected ? Theme.primary : Color(.secondaryLabel))
                Rectangle()
                    .fill(selected ? Theme.primary : Color.clear)
                    .frame(height: 1)
            }
            .padding(.horizontal, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var filtered: [CloudRecordingSummary] {
        var items = recordings
        if let folderFilter {
            // Desktop orphan→root rule: an id not in the live folder list
            // renders at root.
            let live = Set(folders.map(\.id))
            items = items.filter { rec in
                let fid = rec.folderId.flatMap { live.contains($0) ? $0 : nil }
                return folderFilter == "root" ? fid == nil : fid == folderFilter
            }
        }
        if !search.isEmpty {
            items = items.filter {
                $0.title.localizedCaseInsensitiveContains(search)
                    || ($0.snippet ?? "").localizedCaseInsensitiveContains(search)
            }
        }
        return items.sorted { $0.createdAt > $1.createdAt }
    }

    // MARK: actions (mirror of the desktop MoveMenu / ShareMenu / MoveDialog)

    @ViewBuilder
    private func actions(for rec: CloudRecordingSummary) -> some View {
        if !folders.isEmpty {
            Menu("Move to folder") {
                Button("Unfiled (top level)") { Task { await moveToFolder(rec, folderId: nil) } }
                ForEach(folders) { f in
                    Button(f.name) { Task { await moveToFolder(rec, folderId: f.id) } }
                }
            }
        }
        if scope == nil && !app.orgs.isEmpty {
            Menu("Share to organization (copy)") {
                ForEach(app.orgs) { org in
                    Button(org.name) { Task { await shareToOrg(rec, org: org, thenDelete: false) } }
                }
            }
            Menu("Move to organization") {
                ForEach(app.orgs) { org in
                    Button(org.name) { Task { await shareToOrg(rec, org: org, thenDelete: true) } }
                }
            }
        }
        Button("Delete", systemImage: "trash", role: .destructive) {
            Task { await remove(rec) }
        }
    }

    // MARK: data ops

    /// THE import door. Both affordances call this and nothing else, so the
    /// accepted formats, the one-at-a-time rule, and what happens afterwards
    /// cannot drift between them.
    ///
    /// The list is reloaded rather than patched: the recording that landed
    /// carries a server-side `updatedAt` and may have been auto-shared to an
    /// org, and re-reading is the only way to show what is actually there.
    private func runImport(_ result: Result<[URL], Error>) async {
        importNotice = nil
        error = nil
        let completion = await importer.run(result, app: app)
        switch completion {
        case .cancelled:
            break
        case .failed(let message):
            error = message
        case .landed(let title, let sharedToOrgName):
            await load()
            importNotice =
                sharedToOrgName.map { org in
                    String(localized: "Imported “\(title)” and shared to “\(org)”")
                } ?? String(localized: "Imported “\(title)”")
        }
    }

    private func load() async {
        guard app.signedIn else { return }
        #if DEBUG
            if ScreenshotDemo.servesFixtures {
                recordings = ScreenshotDemo.recordings
                folders = ScreenshotDemo.folders
                loading = false
                return
            }
        #endif
        loading = true
        error = nil
        do {
            if let orgId = scope {
                async let r = app.cloud.orgRecordings(orgId: orgId)
                async let f = app.cloud.orgFolders(orgId: orgId)
                recordings = try await r
                folders = try await f
            } else {
                async let r = app.cloud.listRecordings()
                async let f = app.cloud.listFolders()
                recordings = try await r
                folders = try await f.filter { $0.orgId == nil }
            }
        } catch let e as CloudError {
            error =
                e.isAuthExpired
                ? String(localized: "Your session expired. Please sign in again.")
                : String(localized: "Couldn't load (\(e.status))")
        } catch {
            self.error = String(localized: "Couldn't load — offline or the server isn't responding")
        }
        loading = false
    }

    /// Personal: meta re-push (full POST upsert). Org: dedicated PATCH.
    private func moveToFolder(_ rec: CloudRecordingSummary, folderId: String?) async {
        busyId = rec.id
        defer { busyId = nil }
        do {
            if let orgId = scope {
                try await app.cloud.moveOrgRecordingToFolder(
                    orgId: orgId, id: rec.id, folderId: folderId)
            } else {
                var meta = try await app.cloud.recordingMeta(id: rec.id)
                meta.folderId = folderId
                var summary = rec
                summary.folderId = folderId
                try await app.cloud.pushRecording(id: rec.id, summary: summary, meta: meta)
            }
            await load()
        } catch {
            self.error = String(localized: "Move failed: \(error.localizedDescription)")
        }
    }

    /// Copy first; delete the original only after the copy succeeded.
    private func shareToOrg(_ rec: CloudRecordingSummary, org: CloudOrg, thenDelete: Bool) async {
        busyId = rec.id
        defer { busyId = nil }
        do {
            try await app.cloud.shareRecording(id: rec.id, orgId: org.id, folderId: nil)
            if thenDelete {
                try await app.cloud.deleteRecording(id: rec.id)
            }
            await load()
        } catch let e as CloudError where e.status == 403 {
            error = String(localized: "You don't have permission to share to “\(org.name)”")
        } catch {
            self.error = String(localized: "Share failed: \(error.localizedDescription)")
        }
    }

    private func remove(_ rec: CloudRecordingSummary) async {
        busyId = rec.id
        defer { busyId = nil }
        do {
            if let orgId = scope {
                try await app.cloud.deleteOrgRecording(orgId: orgId, id: rec.id)
            } else {
                try await app.cloud.deleteRecording(id: rec.id)
            }
            recordings.removeAll { $0.id == rec.id }
        } catch let e as CloudError where e.status == 403 {
            error = String(localized: "Only the uploader or an admin can delete this recording")
        } catch {
            self.error = String(localized: "Delete failed: \(error.localizedDescription)")
        }
    }
}

/// A recording is separated from the next one by **whitespace and nothing else**
/// — no hairline, no card, no fill. Both of the things that used to be here were
/// a way of drawing a boundary the eye does not need: a row is already a title
/// over a snippet over a meta line, and the gap between two of them says where
/// one stops.
///
/// So all this modifier does is set the gutter and take the system furniture
/// away. The vertical inset is the gap; the horizontal one lines the row up with
/// the folder chips and the navigation title above it.
private struct RecordingRow: ViewModifier {
    func body(content: Content) -> some View {
        content
            .listRowInsets(EdgeInsets(top: 14, leading: 20, bottom: 14, trailing: 20))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }
}

/// Glyph and value as one unit, with a gap narrow enough that the eye groups
/// them and wide enough that they don't touch. `Label`'s own spacing follows
/// the text style, so at caption2 it still leaves roughly a body-text gap; the
/// meta row carries four labels, and that adds up to more width than the one
/// value on the row that actually needs it. Always rendering both halves also
/// keeps `Label`'s icon-only fallback from kicking in under pressure, which is
/// what `.titleAndIcon` used to be here for.
private struct MetaLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon
            configuration.title
        }
    }
}

/// Desktop HistoryCard, phone-sized: type badge, title, date, snippet,
/// duration/speakers/findings meta row.
private struct RecordingCard: View {
    let summary: CloudRecordingSummary
    let folders: [CloudFolder]

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                badge
                Text(
                    verbatim: summary.title.isEmpty
                        ? String(localized: "Untitled recording") : summary.title)
                    .font(.parley.subheadlineEmphasized)
                    .lineLimit(2)
            }
            if let snippet = summary.snippet, !snippet.isEmpty {
                Text(verbatim: snippet)
                    .font(.parley.caption)
                    .foregroundStyle(Color(.secondaryLabel))
                    .lineLimit(2)
            }
            // Everything here is short and fixed except the folder name, so the
            // fixed parts are pinned and only the folder is allowed to
            // truncate. Without this the row wraps mid-value — "18:4 / 2" for a
            // duration, "New busi- / ness" for a folder — which it did in both
            // languages, worst in Chinese where the labels are widest.
            //
            // Pinning the rest is not enough on its own, though: the folder
            // Label and the Spacer are then the only two children with any give,
            // and an HStack hands each flexible child an equal share of what is
            // left. Half the slack went to the gap in front of the date and the
            // folder came out as "R…" / "新…" with visible room beside it. The
            // layout priority below serves the folder first, so the Spacer gets
            // only what the folder does not want — see `.layoutPriority(1)`.
            HStack(spacing: 10) {
                Label(
                    RecordingDetailView.duration(summary.durationMs), systemImage: "clock"
                )
                .fixedSize()
                if let n = summary.speakerCount, n > 0 {
                    Label("\(n)", systemImage: "person.2").fixedSize()
                }
                if let n = summary.findingsCount, n > 0 {
                    // `lightbulb`, the same glyph the detail screen puts on the
                    // findings section. The glyph here used to be the AI stars,
                    // which said "a model wrote this" rather than "findings" —
                    // and the count is only ever about the latter.
                    Label("\(n)", systemImage: "lightbulb").fixedSize()
                }
                if let fid = summary.folderId, let f = folders.first(where: { $0.id == fid }) {
                    Label(f.name, systemImage: "folder")
                        .truncationMode(.tail)
                        // First claim on whatever the pinned values leave over.
                        // A long name still degrades — it just does so after
                        // the row is actually full, not at one character.
                        .layoutPriority(1)
                }
                Spacer(minLength: 4)
                Text(verbatim: Self.dateLabel(summary.createdAt)).fixedSize()
                if summary.hasAudio {
                    Image(systemName: "speaker.wave.2")
                }
            }
            // Durations, counts and a clock time: tabular figures so the row
            // doesn't reflow a digit at a time as a meeting ticks over.
            .font(.parley.caption2.monospacedDigit())
            .lineLimit(1)
            // Under pressure `Label` quietly falls back to icon-only, which
            // leaves a row of glyphs with no values at all — worse than the
            // wrapping it replaced. Pin the style so the numbers always show —
            // and, while we are here, pin the gap between glyph and value too:
            // the built-in one is sized for body text, and four of them at
            // caption2 ate more of the row than the folder name did.
            .labelStyle(MetaLabelStyle())
            .foregroundStyle(Color(.secondaryLabel))
        }
    }

    /// Where the recording came from, as small caps text rather than a tinted
    /// chip. `LIVE` keeps the recording red — it is the one word on this screen
    /// that says "a microphone was open" — and `UPLOAD` is secondary, because a
    /// file someone imported is the unremarkable case.
    private var badge: some View {
        let live = summary.source == "live"
        return Text(live ? "LIVE" : "UPLOAD")
            .font(.parley.caption2.weight(.semibold))
            .foregroundStyle(live ? Theme.recording : Color(.secondaryLabel))
    }

    /// Locale-formatted rather than one hard-coded `M/d HH:mm`: an English phone
    /// expects Aug 9, 3:20 PM where a Chinese one expects 8月9日 下午3:20.
    static func dateLabel(_ epochMs: Double) -> String {
        Date(timeIntervalSince1970: epochMs / 1000)
            .formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }
}

#if DEBUG
    /// The list the fixtures would produce. `LibraryView` itself only answers
    /// from `ScreenshotDemo` when the app is launched with `-ParleyDemo`, which
    /// a preview can't do, so the cards are rendered here through the same
    /// `RecordingRow` treatment the real list uses.
    #Preview("Library — cards") {
        NavigationStack {
            List {
                ForEach(ScreenshotDemo.recordings) { rec in
                    NavigationLink {
                        EmptyView()
                    } label: {
                        RecordingCard(summary: rec, folders: ScreenshotDemo.folders)
                    }
                    .modifier(RecordingRow())
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("Library")
        }
    }

    #Preview("Library — cards, dark") {
        NavigationStack {
            List {
                ForEach(ScreenshotDemo.recordings) { rec in
                    RecordingCard(summary: rec, folders: ScreenshotDemo.folders)
                        .modifier(RecordingRow())
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.background)
        }
        .preferredColorScheme(.dark)
    }

    /// Signed out, which is where a bare `AppState()` lands: the unavailable
    /// state and the toolbar, live.
    #Preview("Library — signed out") {
        LibraryView().environmentObject(AppState())
    }
#endif
