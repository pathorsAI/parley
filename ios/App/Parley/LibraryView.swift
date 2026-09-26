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
    /// Shared with the recording screen, so a download started from a row is the
    /// same download the detail toolbar is showing.
    @EnvironmentObject private var downloads: AudioDownloadModel
    /// Settings sends the user here to see the getting-started list it just
    /// brought back; see `takeChecklistRequest`.
    @EnvironmentObject private var router: TabRouter

    /// nil = personal scope; else an org id.
    @State private var scope: String?
    /// nil = every folder; `Self.unfiledPage` = the personal root; else a folder
    /// id. Written by a chip tap and by the folder swipe, which move through
    /// `folderPages` in order.
    @State private var folderFilter: String?
    @State private var recordings: [CloudRecordingSummary] = []
    @State private var folders: [CloudFolder] = []
    @State private var loading = false
    @State private var error: String?
    @State private var busyId: String?
    @State private var search = ""
    /// Whether the search field is active, so a request to show the checklist
    /// can close it — the checklist is not drawn while searching.
    @State private var searchPresented = false
    /// One importer for the whole screen, so every door — the toolbar button
    /// and the empty state — drives the same single in-flight import.
    @StateObject private var importer = RecordingImporter()
    @State private var importing = false
    /// What the last finished import landed, shown above the list until the
    /// user moves on. Failures go to `error` instead, with everything else.
    @State private var importNotice: String?
    /// The getting-started checklist above the list, and the sample recording
    /// it can put in it. Both are local to this phone.
    @ObservedObject private var gettingStarted = GettingStartedStore.shared
    @ObservedObject private var sample = SampleRecordingStore.shared
    /// Whether the personal library has loaded at least once. The checklist
    /// waits for it, so it never flashes up over a library still on its way
    /// from the cloud — and so the existing-user check has run first.
    @State private var personalLoaded = false
    /// What is pushed on the Library's stack: the recording a row or the
    /// checklist opened, and what for. A path rather than destination-closure
    /// links, so the stack can be popped from here — the checklist request has
    /// to land on the list, not on whatever recording was left open.
    @State private var path: [OpenedRecording] = []
    /// The last `TabRouter.checklistRequest` acted on.
    @State private var handledChecklistRequest = 0
    /// The recording the folder picker is moving, while it is up.
    @State private var moving: CloudRecordingSummary?
    /// Meetings (the cloud library, everything below) or Voice typing (what was
    /// dictated on this phone, `DictationHistoryList`).
    @State private var section: LibrarySection = .meetings
    #if DEBUG
        @ObservedObject private var demo = ScreenshotDemo.shared
    #endif

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                sectionPicker
                switch section {
                case .meetings:
                    Group {
                        if !app.signedIn {
                            unavailable
                        } else {
                            list
                        }
                    }
                    // Here rather than on the stack: pulling the voice-typing
                    // list must not reload the cloud library behind it.
                    .refreshable { await load() }
                case .voiceTyping:
                    // Local to this phone, so it needs no account and no
                    // network — it is drawn signed out and offline too.
                    DictationHistoryList(search: search)
                }
            }
            .background(Theme.background)
            // Settings' "Show the getting-started list again" lands on the
            // checklist, which lives in Meetings; the list itself then takes
            // the request on appearing (`takeChecklistRequest`).
            .onChange(of: router.checklistRequest) { _, _ in section = .meetings }
            .navigationTitle("Library")
            .toolbar {
                if section == .meetings {
                    importButton
                    scopeMenu
                }
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
            .navigationDestination(for: OpenedRecording.self) { target in
                if let rec = allRecordings.first(where: { $0.id == target.id }) {
                    RecordingDetailView(
                        summary: rec, orgId: target.orgId, intent: target.intent,
                        onFolderChange: folderChanged(rec.id))
                }
            }
            .sheet(item: $moving) { rec in folderPicker(for: rec) }
            .searchable(
                text: $search, isPresented: $searchPresented,
                prompt: section == .meetings
                    ? Text("Search titles and snippets") : Text("Search voice typing"))
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

    /// Meetings / Voice typing, above everything else on the page. Segmented
    /// rather than a tab of its own: both are "what I said, kept", and the
    /// Library is where someone goes looking for either.
    private var sectionPicker: some View {
        Picker("Library", selection: $section) {
            Text("Meetings").tag(LibrarySection.meetings)
            Text("Voice typing").tag(LibrarySection.voiceTyping)
        }
        .pickerStyle(.segmented)
        .padding(.horizontal, 20)
        .padding(.top, 4)
        .padding(.bottom, 6)
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

    // MARK: getting started

    /// The personal scope's list with the sample merged in. The sample is
    /// local-only and belongs to no organization, so an org scope never shows
    /// it. See `SampleRecordingStore`.
    private var allRecordings: [CloudRecordingSummary] {
        guard scope == nil, let entry = sample.summary else { return recordings }
        return recordings + [entry]
    }

    /// Personal scope, not searching — and then the checklist's own rule
    /// (`GettingStartedState.showsInLibrary`, unit-tested in ParleyKit).
    ///
    /// The list used to wait for the personal library to come back from the
    /// cloud every time the screen was built, so after "Show the
    /// getting-started list again" the Library came up with a spinner and the
    /// list arrived a network round trip later — or never, offline. It now
    /// waits only while the once-per-install existing-user check is pending;
    /// after that it is local state, drawn at once, and the recordings fill in
    /// underneath.
    private var showsChecklist: Bool {
        #if DEBUG
            if ScreenshotDemo.servesFixtures && !demo.allowsChecklist { return false }
        #endif
        guard scope == nil, search.isEmpty else { return false }
        return gettingStarted.state.showsInLibrary(
            libraryLoaded: personalLoaded,
            existingUserChecked: gettingStarted.existingUserChecked,
            libraryIsEmpty: allRecordings.isEmpty)
    }

    private static let checklistID = "getting-started"

    /// Settings asked for the checklist ("Show the getting-started list
    /// again"). Everything that would keep it off screen goes: a pushed
    /// recording, an org scope, a folder page, a search. Then the list is
    /// scrolled to the top of the page.
    ///
    /// Called from the list's `onAppear` as well as on the change, because the
    /// Library may not have been built when the request was made — a tab is
    /// built on its first visit — and the counter is compared rather than
    /// consumed, so neither path can act twice.
    private func takeChecklistRequest(_ proxy: ScrollViewProxy) {
        guard router.checklistRequest != handledChecklistRequest else { return }
        handledChecklistRequest = router.checklistRequest
        path = []
        searchPresented = false
        search = ""
        if scope != nil {
            scope = nil
            importNotice = nil
        }
        folderFilter = nil
        // A beat for the pop and the tab switch to settle: a scroll issued
        // mid-transition is dropped.
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(350))
            withAnimation { proxy.scrollTo(Self.checklistID, anchor: .top) }
        }
    }

    /// What rows 2–4 open: the newest recording, the sample included.
    private var latestRecording: CloudRecordingSummary? {
        allRecordings.max { $0.createdAt < $1.createdAt }
    }

    private func loadSample() {
        guard sample.load() != nil else { return }
        // Back to "All", so the row that just appeared is on screen.
        select(nil)
    }

    private func openLatest(_ step: GettingStartedStep) {
        guard let latest = latestRecording else { return }
        let intent: RecordingDetailView.Intent =
            switch step {
            case .filed: .file
            case .sharedToAI: .share
            case .recorded, .replayed: .read
            }
        path.append(OpenedRecording(id: latest.id, orgId: nil, intent: intent))
    }

    /// Keeps a row's folder in step with a move made inside the recording, so
    /// going back does not show where it used to be. The sample needs nothing:
    /// its folder lives in `SampleRecordingStore`, which this view observes.
    private func folderChanged(_ id: String) -> (String?) -> Void {
        { folderId in
            guard let index = recordings.firstIndex(where: { $0.id == id }) else { return }
            recordings[index].folderId = folderId
        }
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
    ///
    /// `doc.badge.plus`, not `square.and.arrow.down`. The arrow into a tray is
    /// the platform's download mark, and this action brings a file *in* — it was
    /// pointing the wrong way even before the library had a real download to
    /// offer, and now that it does (see `downloadAction`) the two would have been
    /// the same glyph for opposite directions.
    @ToolbarContentBuilder
    private var importButton: some ToolbarContent {
        if scope == nil {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    importing = true
                } label: {
                    Label("Import audio", systemImage: "doc.badge.plus")
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

    /// Chip row above, one folder's worth of recordings below, and a horizontal
    /// swipe on the chip row moves between them.
    ///
    /// **A `TabView(selection:)` in `.page` style was tried first and it does not
    /// work here.** It pages beautifully, and it takes the rows' swipe actions
    /// with it: the paging scroll view wins the horizontal pan, so neither the
    /// leading download nor the trailing delete can be opened by a drag that
    /// starts on a row. Measured, not guessed — an XCUITest drove a measured drag
    /// on a row with the pager in place (both actions failed to open) and again
    /// with the pager bypassed (both opened). Losing delete to gain paging is not
    /// a trade worth making, so the drag lives on the chip row instead, where
    /// nothing else wants it.
    ///
    /// The chip row therefore stays put instead of scrolling away with the list —
    /// a swipe target that scrolls off screen is a swipe target that mostly is
    /// not there.
    private var list: some View {
        VStack(spacing: 0) {
            if !folders.isEmpty {
                folderChips
            }
            folderList(folderFilter)
        }
    }

    /// One folder's worth of the library.
    private func folderList(_ folder: String?) -> some View {
        let items = filtered(folder)
        let checklist = folder == nil && showsChecklist
        return ScrollViewReader { proxy in
            folderRows(items, checklist: checklist)
                .onAppear { takeChecklistRequest(proxy) }
                .onChange(of: router.checklistRequest) { _, _ in takeChecklistRequest(proxy) }
        }
    }

    private func folderRows(_ items: [CloudRecordingSummary], checklist: Bool) -> some View {
        List {
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
            if checklist {
                GettingStartedList(
                    state: gettingStarted.state,
                    canLoadSample: SampleRecordingStore.isBundled,
                    hasRecording: latestRecording != nil,
                    loadSample: loadSample,
                    open: openLatest,
                    dismiss: { withAnimation { gettingStarted.dismiss() } })
                    .listRowInsets(EdgeInsets(top: 12, leading: 20, bottom: 12, trailing: 20))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                    .id(Self.checklistID)
                // The list is drawn before the first load lands; the spinner
                // goes under it rather than over it.
                if loading && recordings.isEmpty {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 24)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
            }
            ForEach(items) { rec in
                NavigationLink(value: OpenedRecording(id: rec.id, orgId: scope, intent: .read)) {
                    RecordingCard(
                        summary: rec, folders: folders, audio: downloads.state(for: rec.id))
                }
                .modifier(RecordingRow())
                .swipeActions(edge: .trailing) {
                    Button("Delete", systemImage: "trash", role: .destructive) {
                        Task { await remove(rec) }
                    }
                }
                // Leading, so the destructive edge stays the one it has always
                // been. Nothing on this edge deletes anything: both actions here
                // are about the copy on the phone, and the cloud keeps its own.
                .swipeActions(edge: .leading) { downloadAction(for: rec) }
                .contextMenu { actions(for: rec) }
                .disabled(busyId == rec.id)
                .opacity(busyId == rec.id ? 0.5 : 1)
            }
            if !loading && items.isEmpty && error == nil {
                emptyState
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .overlay { if loading && recordings.isEmpty && !checklist { ProgressView() } }
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
                    // Same glyph as the toolbar button it duplicates — see
                    // `importButton` for why it is not the download arrow.
                    Label("Import an audio file", systemImage: "doc.badge.plus")
                        .font(.parley.subheadlineEmphasized)
                }
                .disabled(importer.isRunning)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 56)
        .padding(.bottom, 24)
        // The other place a folder swipe is safe: an empty folder has no rows to
        // take the drag away from, and it is exactly where someone lands when
        // they switch to a folder they have not filed anything into yet.
        .contentShape(Rectangle())
        .simultaneousGesture(folderSwipe)
    }

    /// The pages, in the order the chips and the swipe both run: everything,
    /// then the personal root, then the folders as the server ordered them.
    private var folderPages: [String] {
        [Self.allPage, Self.unfiledPage] + folders.map(\.id)
    }

    /// Swipe left for the next folder, right for the previous one.
    ///
    /// `simultaneousGesture`, so the chip row can still be scrolled and its chips
    /// still tapped — this reads the drag, it does not claim it. The two
    /// conditions are what keep it from firing on gestures that were meant for
    /// something else: 60pt so a thumb resting and moving slightly does nothing,
    /// and more horizontal than vertical so a diagonal flick towards the list
    /// scrolls rather than switching folder.
    ///
    /// The ends are ends: at `All` a rightward swipe has nowhere to go and the
    /// selection stays where it is, which is what the chip row already shows.
    private var folderSwipe: some Gesture {
        DragGesture(minimumDistance: 20)
            .onEnded { drag in
                let horizontal = drag.translation.width
                guard abs(horizontal) >= 60,
                    abs(horizontal) > abs(drag.translation.height)
                else { return }
                step(horizontal < 0 ? 1 : -1)
            }
    }

    private func step(_ delta: Int) {
        // No folders, no chip row, nothing to switch between: `Unfiled` and `All`
        // are the same list, and moving between them invisibly would read as the
        // library having lost something.
        guard !folders.isEmpty else { return }
        let pages = folderPages
        let current = pages.firstIndex(of: folderFilter ?? Self.allPage) ?? 0
        let next = current + delta
        guard pages.indices.contains(next) else { return }
        select(pages[next] == Self.allPage ? nil : pages[next])
    }

    static let allPage = "all"
    /// Recordings with no folder — the same value the desktop's root filter uses.
    static let unfiledPage = "root"

    /// Tap or swipe, the selection is the same state, so the underline follows
    /// either one. The chip row scrolls itself so the selected chip is on screen:
    /// paging past the fourth folder would otherwise move the underline to a chip
    /// that had scrolled out of the row.
    private var folderChips: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    chip(String(localized: "All"), selected: folderFilter == nil) {
                        select(nil)
                    }
                    .id(Self.allPage)
                    chip(
                        String(localized: "Unfiled"), selected: folderFilter == Self.unfiledPage
                    ) {
                        select(Self.unfiledPage)
                    }
                    .id(Self.unfiledPage)
                    ForEach(folders) { f in
                        chip(f.name, selected: folderFilter == f.id) { select(f.id) }
                            .id(f.id)
                    }
                }
                .padding(.vertical, 4)
                .padding(.horizontal, 2)
            }
            .onChange(of: folderFilter) { _, _ in
                withAnimation(.easeInOut(duration: 0.2)) {
                    proxy.scrollTo(folderFilter ?? Self.allPage, anchor: .center)
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 8)
        .padding(.bottom, 4)
        // The whole strip is the swipe target, padding included, so the gesture
        // does not require hitting a chip.
        .contentShape(Rectangle())
        .simultaneousGesture(folderSwipe)
        // Carries the underline and the semibold to the new chip instead of
        // snapping them across.
        .animation(.easeInOut(duration: 0.2), value: folderFilter)
    }

    /// A tap on a chip is the same move as a swipe, animated the same way, so
    /// the two cannot look like different features.
    private func select(_ page: String?) {
        withAnimation(.easeInOut(duration: 0.25)) { folderFilter = page }
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

    /// The rows one page shows. Takes the folder rather than reading
    /// `folderFilter`, because every page of the pager is built at once and each
    /// one has to filter by *its* folder, not by the selected one.
    ///
    /// The search text is deliberately not a parameter: it is one query across
    /// the whole library, so a search with the folder filter on "All" and the
    /// same search two chips over are the same search, narrowed.
    private func filtered(_ folderFilter: String?) -> [CloudRecordingSummary] {
        var items = allRecordings
        if let folderFilter {
            // Desktop orphan→root rule: an id not in the live folder list
            // renders at root.
            let live = Set(folders.map(\.id))
            items = items.filter { rec in
                let fid = rec.folderId.flatMap { live.contains($0) ? $0 : nil }
                return folderFilter == Self.unfiledPage ? fid == nil : fid == folderFilter
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

    // MARK: audio on this phone

    /// The leading-swipe action, and the same two buttons the context menu
    /// carries — one function, so the edge and the long-press cannot offer
    /// different words for the same thing.
    ///
    /// Personal scope only. `downloadAudio` reads `recordings/<id>/audio`, which
    /// is the personal endpoint; an org recording's audio lives behind an org
    /// path this client does not speak yet, and an action that would 404 is worse
    /// than no action at all. The `iphone` indicator is not gated the same way —
    /// it states a fact about the file, whatever scope the row is read in.
    ///
    /// Blue on the download because it is a tap, grey on the removal because it
    /// is not destructive: the cloud copy is untouched, and the red that
    /// `.destructive` would paint it says a recording is about to be lost.
    @ViewBuilder
    private func downloadAction(for rec: CloudRecordingSummary) -> some View {
        // The sample's audio is in the app bundle: there is nothing to fetch
        // and nothing to give back.
        if scope == nil && !SampleManifest.isSample(id: rec.id) {
            switch downloads.state(for: rec.id) {
            case .local:
                Button {
                    downloads.removeDownload(rec.id)
                } label: {
                    Label("Remove download", systemImage: "xmark.circle")
                }
                .tint(Color(.secondaryLabel))
            case .downloading:
                EmptyView()
            case .absent, .failed:
                Button {
                    Task { await downloads.download(rec.id, cloud: app.cloud) }
                } label: {
                    Label("Download", systemImage: "arrow.down.circle")
                }
                .tint(Theme.primary)
            }
        }
    }

    // MARK: actions (mirror of the desktop MoveMenu / ShareMenu / MoveDialog)

    @ViewBuilder
    private func actions(for rec: CloudRecordingSummary) -> some View {
        downloadAction(for: rec)
        // The picker sheet rather than a submenu of every folder: a submenu
        // has no search and no way to add the customer you have just met.
        // Personal scope can create a folder, so it always has somewhere to
        // go; an org scope has no create endpoint here, so it needs folders.
        if scope == nil || !folders.isEmpty {
            Button("Move to folder…", systemImage: "folder") { moving = rec }
        }
        // Not for the sample: sharing is a server-side copy of something the
        // server does not have.
        if scope == nil && !app.orgs.isEmpty && !SampleManifest.isSample(id: rec.id) {
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

    /// The same picker the recording screen uses, over this scope's folders.
    private func folderPicker(for rec: CloudRecordingSummary) -> some View {
        // The orphan→root rule the list renders by, so the tick agrees with
        // the page the row is on.
        let current = rec.folderId.flatMap { id in folders.contains { $0.id == id } ? id : nil }
        let create: ((String) async throws -> Void)? =
            scope == nil
            ? { name in
                let folder = try await app.cloud.createFolder(name: name)
                folders.append(folder)
                await moveToFolder(rec, folderId: folder.id)
            } : nil
        return FolderPickerSheet(
            folders: folders,
            currentFolderId: current,
            onSelect: { folderId in Task { await moveToFolder(rec, folderId: folderId) } },
            onCreate: create)
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
                // Before `personalLoaded` flips, so an existing user's library
                // has dismissed the checklist before it could be drawn.
                gettingStarted.noteLibraryLoaded(recordingCount: recordings.count)
                personalLoaded = true
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
        // Filed on this phone and nowhere else — see `SampleRecordingStore`.
        if SampleManifest.isSample(id: rec.id) {
            sample.setFolder(folderId)
            if folderId != nil { gettingStarted.mark(.filed) }
            return
        }
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
            if folderId != nil { gettingStarted.mark(.filed) }
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
            gettingStarted.mark(.filed)
            await load()
        } catch let e as CloudError where e.status == 403 {
            error = String(localized: "You don't have permission to share to “\(org.name)”")
        } catch {
            self.error = String(localized: "Share failed: \(error.localizedDescription)")
        }
    }

    private func remove(_ rec: CloudRecordingSummary) async {
        // Out of the Library, not out of the app: the checklist can load it
        // again.
        if SampleManifest.isSample(id: rec.id) {
            sample.remove()
            return
        }
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

/// A recording on the Library's stack, and what it was opened for: `.read`
/// from a row, `.file` or `.share` from the getting-started checklist.
private enum LibrarySection: Hashable {
    case meetings
    case voiceTyping
}

private struct OpenedRecording: Hashable {
    let id: String
    /// nil = personal scope.
    let orgId: String?
    let intent: RecordingDetailView.Intent
}

/// The getting-started checklist: four plain rows that teach the product by
/// doing it — record, file, replay, hand off — each ticked only by the real
/// event (see `GettingStartedStore`), never by a tap on the row.
///
/// Rows, hairlines and text, no card: the page is white and the list is part
/// of it. The one colour is the system green on a done item's check — "this
/// is fine" in the platform's own words — and the tint on what can be tapped.
private struct GettingStartedList: View {
    let state: GettingStartedState
    /// False in a build without the sample assets; the button is then absent
    /// rather than broken.
    let canLoadSample: Bool
    /// Rows 2–4 open the newest recording; with none, they are just text.
    let hasRecording: Bool
    let loadSample: () -> Void
    let open: (GettingStartedStep) -> Void
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Do one lap, five minutes")
                    .font(.parley.subheadlineEmphasized)
                    .foregroundStyle(Color(.label))
                Text(verbatim: "\(state.done) / \(GettingStartedState.total)")
                    .font(.parley.caption.monospacedDigit())
                    .foregroundStyle(Color(.secondaryLabel))
                    .accessibilityLabel(
                        Text("\(state.done) of \(GettingStartedState.total) done"))
                Spacer(minLength: 8)
                Button("Not now", action: dismiss)
                    .font(.parley.footnote)
                    .buttonStyle(.borderless)
            }
            .padding(.bottom, 8)
            ForEach(GettingStartedStep.allCases, id: \.self) { step in
                Rectangle()
                    .fill(Color(.separator))
                    .frame(height: 0.5)
                row(step)
            }
        }
    }

    @ViewBuilder
    private func row(_ step: GettingStartedStep) -> some View {
        let done = state[step]
        let opensRecording = step != .recorded && !done && hasRecording
        if opensRecording {
            // The whole row is the target: the words are what people reach
            // for. Borderless, so it is not taken over by the list row.
            Button {
                open(step)
            } label: {
                rowContent(step, done: done) {
                    Image(systemName: "chevron.right")
                        .font(.parley.footnote.weight(.semibold))
                        .foregroundStyle(Color(.tertiaryLabel))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
        } else {
            rowContent(step, done: done) {
                if step == .recorded && !done && canLoadSample {
                    Button("Load sample", action: loadSample)
                        .font(.parley.footnote.weight(.semibold))
                        .buttonStyle(.borderless)
                }
            }
        }
    }

    private func rowContent<Trailing: View>(
        _ step: GettingStartedStep, done: Bool, @ViewBuilder trailing: () -> Trailing
    ) -> some View {
        HStack(alignment: .center, spacing: 12) {
            // The mark and the words are one element to VoiceOver; the
            // trailing button stays its own, so it can still be activated.
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: done ? "checkmark.circle.fill" : "circle")
                    .font(.parley.body)
                    .foregroundStyle(done ? Theme.success : Color(.tertiaryLabel))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title(step))
                        .font(.parley.subheadline)
                        .foregroundStyle(done ? Color(.secondaryLabel) : Color(.label))
                    if let detail = detail(step) {
                        Text(detail)
                            .font(.parley.caption)
                            .foregroundStyle(Color(.secondaryLabel))
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
            .accessibilityValue(done ? Text("Done") : Text(verbatim: ""))
            Spacer(minLength: 8)
            trailing()
        }
        .padding(.vertical, 10)
    }

    private func title(_ step: GettingStartedStep) -> LocalizedStringKey {
        switch step {
        case .recorded: return "Record your first meeting"
        case .filed: return "Put it in a folder"
        case .replayed: return "Replay: tap a line to jump"
        case .sharedToAI: return "Share it with your AI"
        }
    }

    private func detail(_ step: GettingStartedStep) -> LocalizedStringKey? {
        switch step {
        case .recorded: return "or load the sample recording"
        case .filed: return "One customer, one folder"
        case .replayed: return nil
        case .sharedToAI: return "ChatGPT and Claude are in the share sheet"
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

/// How far a download has got, in the width of a glyph.
///
/// Hand-drawn rather than a `ProgressView` because `.circular` on iOS is an
/// indeterminate spinner — it says "something is happening" where the whole
/// point here is *how much* has happened — and the linear style is a bar that
/// cannot sit in a row of glyphs without pushing the date around. Two circles
/// and a trim is the whole thing.
///
/// Shared with the recording screen's toolbar, so a download watched from the
/// library and the same download watched from inside the recording are the same
/// mark at two sizes.
///
/// Blue, unlike its neighbours, because this is the one state on the row that is
/// happening right now.
struct DownloadRing: View {
    let fraction: Double
    var size: CGFloat = 12

    var body: some View {
        Circle()
            .stroke(Color(.quaternaryLabel), lineWidth: 2)
            .overlay {
                Circle()
                    // Never quite zero: a ring with nothing drawn on it reads as
                    // a placeholder rather than as a download that has just
                    // started.
                    .trim(from: 0, to: max(0.02, min(1, fraction)))
                    .stroke(Theme.primary, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    // 12 o'clock, filling clockwise, the way every other
                    // progress ring on the phone reads.
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: size, height: size)
            .accessibilityLabel("Downloading")
            .accessibilityValue(Text(fraction.formatted(.percent.precision(.fractionLength(0)))))
    }
}

/// Desktop HistoryCard, phone-sized: type badge, title, date, snippet,
/// duration/speakers/findings meta row.
private struct RecordingCard: View {
    let summary: CloudRecordingSummary
    let folders: [CloudFolder]
    /// Where this recording's audio is. The row is the only place in the app
    /// that answers this without being asked, which is the point: "can I play
    /// this on the train" is a property of the library, not of one recording.
    var audio: AudioDownloadState = .absent

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
                audioIndicator
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

    /// The last thing on the meta line: a phone glyph when the audio is here, a
    /// progress ring while it is arriving, and nothing at all otherwise.
    ///
    /// `tertiaryLabel`, the same weight as the clock beside it. It is a fact
    /// worth having on the row and never worth reading first — blue would claim
    /// it can be tapped, and this cannot.
    ///
    /// The failure is words rather than a glyph, because a red glyph in a
    /// four-glyph row is unreadable. The retry itself is the leading swipe or the
    /// context menu: a button inside a `NavigationLink`'s label cannot be tapped
    /// on its own, so a tappable "Retry" here would be a lie.
    @ViewBuilder
    private var audioIndicator: some View {
        switch audio {
        case .local:
            Image(systemName: "iphone")
                .foregroundStyle(Color(.tertiaryLabel))
                .accessibilityLabel("On this phone")
        case .downloading(let fraction):
            DownloadRing(fraction: fraction)
        case .failed:
            Text("Download failed · Retry")
                .foregroundStyle(Color(.secondaryLabel))
                .fixedSize()
        case .absent:
            EmptyView()
        }
    }

    /// Where the recording came from, as small caps text rather than a tinted
    /// chip. `LIVE` keeps the recording red — it is the one word on this screen
    /// that says "a microphone was open" — and `UPLOAD` is secondary, because a
    /// file someone imported is the unremarkable case.
    private var badge: some View {
        let live = summary.source == "live"
        if SampleManifest.isSample(id: summary.id) {
            return Text("SAMPLE")
                .font(.parley.caption2.weight(.semibold))
                .foregroundStyle(Color(.secondaryLabel))
        }
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
    /// One of each audio state across the three fixtures, for the card previews.
    /// The running app reads this from `AudioDownloadModel`, which needs a store
    /// and a session — neither of which a preview has.
    private func previewAudioState(_ id: String) -> AudioDownloadState {
        switch id {
        case ScreenshotDemo.recordings[0].id: return .local
        case ScreenshotDemo.recordings[1].id: return .downloading(0.45)
        default: return .absent
        }
    }

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
                        // The three audio states side by side, which is the one
                        // thing a preview can show that a screenshot can't: the
                        // first row is on the phone, the second is arriving, the
                        // third is cloud-only.
                        RecordingCard(
                            summary: rec, folders: ScreenshotDemo.folders,
                            audio: previewAudioState(rec.id))
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
                    RecordingCard(
                        summary: rec, folders: ScreenshotDemo.folders,
                        audio: previewAudioState(rec.id))
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
        LibraryView()
            .environmentObject(AppState())
            .environmentObject(AudioDownloadModel())
            .environmentObject(TabRouter())
    }
#endif
