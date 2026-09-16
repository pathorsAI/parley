import ParleyKit
import SwiftUI

/// A synced recording, read and played back — the phone's reading room.
///
/// The transcript is a document here, rendered at once and scrollable, with the
/// desktop's speaker-label rules. What sits above it is the player: a pinned
/// block, under the navigation bar, that the transcript scrolls *under* rather
/// than past. Pinned because scrubbing is the thing you do while reading a
/// transcript — finding the paragraph and then hearing how it was said — and a
/// player that scrolled away would have to be chased back.
///
/// The two halves are wired together in both directions: the audio lights the
/// turn it is inside, and tapping a turn — its timecode or the words themselves
/// — seeks the audio to where that turn starts.
struct RecordingDetailView: View {
    @EnvironmentObject private var app: AppState
    /// The same model the library row drives, so a download started from either
    /// place is visible in both.
    @EnvironmentObject private var downloads: AudioDownloadModel
    let summary: CloudRecordingSummary
    /// nil = personal scope; set = org scope.
    let orgId: String?

    @State private var meta: RecordingMeta?
    @State private var error: String?
    /// One player per detail screen, built from the recording's id so the peaks
    /// cache and the audio it belongs to can find each other.
    @StateObject private var playback: PlaybackController
    /// Whether the transcript still follows the audio.
    ///
    /// Turned off the moment the reader scrolls themselves — they are looking for
    /// something, and having the list yank itself back under their thumb every
    /// few seconds is the single most irritating thing an auto-scrolling
    /// transcript can do. Nothing is shown for the off state: the next play,
    /// seek, or timecode tap turns it back on, so the return is an action the
    /// reader was going to take anyway rather than a pill asking them to take one.
    @State private var followsAudio = true
    /// The turn whose text is mid-flash, if any.
    ///
    /// A tap on a turn's words seeks the audio, and seeking is not something the
    /// transcript itself shows: the player moves, but the player is at the top
    /// of the screen and the thumb is halfway down it. So the tapped turn tints
    /// `Theme.primary` for a moment and goes back — the acknowledgement a button
    /// would get from its own pressed state, for a target that has no pressed
    /// state because it is a paragraph.
    @State private var flashedTurn: String?
    /// Whether the search field is up. Driven by the toolbar button, so the
    /// transcript stays a clean column of text whenever nobody is searching —
    /// a permanent search bar on a reading screen is a bar you read past every
    /// time and use once a week.
    @State private var searching = false
    /// What is being searched for. Empty is the whole of the "not searching"
    /// state: no highlights, no counter bar.
    @State private var query = ""
    /// Which hit `n of N` is pointing at, as an index into the hit list.
    ///
    /// An index rather than the `Hit` itself because the list is recomputed from
    /// scratch on every keystroke, and "the third match" survives that where a
    /// value identifying a range in a string does not. Clamped at the point of
    /// use — the list can shrink under it between renders.
    @State private var currentHit = 0
    @FocusState private var queryFocused: Bool
    /// The transcript's own width, measured off the scroll view, so the 2× hold
    /// can tell whether a press landed in one of the bands at either edge.
    @State private var transcriptWidth: CGFloat = 0
    /// Where the finger went down on the transcript, while it is down.
    ///
    /// Recorded by the drag half of the 2× gesture, because a `LongPressGesture`
    /// value is a bare `Bool` and carries no location, and the location is the
    /// whole of the question being asked.
    @State private var pressStart: CGPoint?
    /// Whether a touch is currently down on the transcript.
    ///
    /// `@GestureState` for exactly one reason: it unwinds by itself when the
    /// gesture ends, fails, or is interrupted, and that is what makes the release
    /// of 2× unmissable. A plain flag stays set when a system gesture, a context
    /// menu, or the screen going away takes the touch mid-hold, and the recording
    /// then plays at 2× with nothing holding it.
    @GestureState private var pressing = false

    /// The re-transcription confirmation, and what this recording's
    /// re-transcription is actually doing.
    ///
    /// Three states rather than a `Bool`, and that is the whole of the fix for
    /// "it says it's transcribing but it isn't". The flag this replaces was set
    /// from a `fileExists` on the queue directory, so "a run is under way" and
    /// "a manifest nobody is running" were the same answer — and the screen
    /// showed the spinner for both while the menu item that would have retried
    /// it was disabled *because* of them. iOS kills a backfill the moment the
    /// phone is locked, so the second state is the common one, and the only way
    /// out of it was to force-quit the app.
    ///
    /// Waiting and working now render differently, and only `.running` disables
    /// the action.
    @State private var confirmingReTranscribe = false
    @State private var backfill: MeetingUploader.BackfillState = .none
    /// How many hand-triggered re-runs this recording has left. Read from the
    /// ledger when the screen loads rather than on every render — the answer
    /// lives in a file, and the body is not a place to touch the disk.
    @State private var retriesRemaining = TranscriptCoverage.BackfillPolicy.standard
        .maxManualRetries
    /// Shown inline above the transcript. A re-transcription that failed must
    /// not take the transcript off the screen — the old one is still the best
    /// thing the reader has.
    @State private var reTranscribeError: String?

    init(summary: CloudRecordingSummary, orgId: String?) {
        self.summary = summary
        self.orgId = orgId
        _playback = StateObject(wrappedValue: PlaybackController(recordingId: summary.id))
    }

    var body: some View {
        Group {
            if let meta {
                transcript(meta)
            } else if let error {
                ContentUnavailableView(
                    "Couldn't load", systemImage: "exclamationmark.triangle",
                    description: Text(error))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(
            summary.title.isEmpty ? String(localized: "Untitled recording") : summary.title)
        .navigationBarTitleDisplayMode(.inline)
        .background(Theme.background)
        .toolbar {
            // The overflow menu goes innermost, ahead of the controls that were
            // here first: download and copy are the actions on this screen and
            // copy keeps the outermost trailing position it has always had.
            ToolbarItem(placement: .topBarTrailing) { overflowMenu }
            // Search sits out here as its own button rather than as another
            // row in the overflow menu. Two reasons: finding a phrase is
            // something you do *while reading*, over and over, where
            // re-transcribing is a once-ever action; and the overflow menu is
            // personal-scope only, so a search buried in it would not exist at
            // all on an org recording.
            ToolbarItem(placement: .topBarTrailing) { searchButton }
            ToolbarItem(placement: .topBarTrailing) { downloadControl }
            ToolbarItem(placement: .topBarTrailing) {
                CopyTranscriptButton(
                    text: plainTranscript,
                    isEmpty: readable.isEmpty)
            }
        }
        .confirmationDialog(
            "Re-transcribe this recording?",
            isPresented: $confirmingReTranscribe,
            titleVisibility: .visible
        ) {
            Button("Re-transcribe") { Task { await reTranscribe() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "The whole recording is transcribed again from the start, and the transcript you have now is replaced when the new one comes back. It uses your account's transcription hours, the same as a new meeting would."
            )
        }
        // Closing the field clears the query, because a search that is out of
        // sight must not leave the transcript highlighted — the reader has no
        // bar left to explain the tint, or to clear it with.
        .onChange(of: searching) { _, open in
            queryFocused = open
            if !open { query = "" }
        }
        // A backfill landed somewhere in the app, and it may well be this one:
        // the queue drains on launch, on sign-in, on every foregrounding and on
        // the Re-transcribe tap itself, so a repaired transcript can arrive
        // while the reader is sitting on the recording it belongs to. Before
        // this, it did not — the screen kept the transcript it had fetched, and
        // the new one turned up by chance on some later visit.
        .onChange(of: app.backfillRevision) { _, _ in
            Task { await backfillLanded() }
        }
        .task { await load() }
        // Keyed on the URL, so the download landing is what opens the player:
        // the block is showing "Download to play back" until this runs, and the
        // player appears in place when it does. The nil case is the reverse —
        // the audio was removed from the phone while this screen was open — and
        // has to put the block back rather than leave a player over a file that
        // is no longer there.
        .task(id: audioURL) {
            guard let audioURL else { return playback.unload() }
            await playback.load(url: audioURL)
        }
    }

    /// Where this recording's audio is, if it is anywhere. nil is the whole of
    /// the "not on the phone" state — `PlaybackBar` draws the download button
    /// from the same model.
    private var audioURL: URL? { downloads.url(for: summary.id) }

    /// Shows and hides the search field. Absent when there is no transcript to
    /// search, for the same reason the copy button goes inert on an empty one.
    @ViewBuilder
    private var searchButton: some View {
        if !readable.isEmpty {
            Button {
                searching.toggle()
            } label: {
                Label("Search transcript", systemImage: "magnifyingglass")
            }
        }
    }

    /// The search field, and the reason it is hand-built rather than
    /// `.searchable`.
    ///
    /// `.searchable(text:isPresented:)` was tried first and cannot do what this
    /// screen needs: its bar lives in the navigation drawer *permanently*, and
    /// `isPresented` governs only whether the field is focused, not whether the
    /// bar exists. That leaves a search bar sitting over the transcript on every
    /// visit — which is precisely what #367 asked to avoid, and it makes the
    /// toolbar button that is supposed to summon it redundant. (iOS 26 can
    /// minimise a `.searchable` bar into a toolbar button, but the app ships to
    /// iOS 17, and a search field that exists on some phones and not others is
    /// worse than one that behaves the same everywhere.)
    ///
    /// So: page-coloured with a hairline, the same chrome as `PlaybackBar`
    /// above it and the counter bar below, and it is simply not in the view
    /// tree when nobody is searching.
    @ViewBuilder
    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(Color(.tertiaryLabel))
                .accessibilityHidden(true)
            TextField("Search this transcript", text: $query)
                .focused($queryFocused)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                // The field is a filter, not a form: there is nothing to submit
                // because the highlights are already keeping up with the typing.
                .submitLabel(.done)
                .onSubmit { queryFocused = false }
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
            Button("Cancel") { searching = false }
                .font(.parley.subheadline)
        }
        .font(.parley.body)
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
        .background(Theme.background)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color(.separator))
                .frame(height: 0.5)
        }
    }

    /// Fetch this recording's audio, or show how far that has got.
    ///
    /// Nothing at all once the audio is here: the toolbar's job is to *get* the
    /// file, and a recording whose audio is on the phone has the player below
    /// where a permanent "downloaded" badge would only take up the slot.
    ///
    /// Personal scope only, for the same reason as the library row — see
    /// `LibraryView.downloadAction`. A failed attempt falls back to the button,
    /// which is the retry.
    @ViewBuilder
    private var downloadControl: some View {
        if orgId == nil {
            switch downloads.state(for: summary.id) {
            case .absent, .failed:
                Button {
                    Task { await downloads.download(summary.id, cloud: app.cloud) }
                } label: {
                    Label("Download", systemImage: "arrow.down.circle")
                }
            case .downloading(let fraction):
                DownloadRing(fraction: fraction, size: 20)
            case .local:
                EmptyView()
            }
        }
    }

    /// Everything that is not download and not copy — which today is one thing.
    ///
    /// A menu rather than a third toolbar button because of what the thing is:
    /// re-transcribing spends transcription hours and rewrites the document on
    /// screen, and an action like that should not sit one mis-tap away from
    /// "copy". The ellipsis costs a tap and buys a confirmation the user chose
    /// to walk towards.
    ///
    /// Personal scope only, the same rule as `downloadControl`: the re-push
    /// goes through the personal recording endpoints, so an org recording read
    /// on this phone has nothing here to offer and the menu is absent rather
    /// than present and dead.
    @ViewBuilder
    private var overflowMenu: some View {
        if orgId == nil {
            Menu {
                Section {
                    Button("Re-transcribe", systemImage: "arrow.clockwise") {
                        confirmingReTranscribe = true
                    }
                    .disabled(!canReTranscribe)
                } header: {
                    // Localized on the way in by `reTranscribeNote`, so
                    // `verbatim` — a key lookup here would look up a sentence
                    // that is already the answer.
                    if let note = reTranscribeNote { Text(verbatim: note) }
                }
            } label: {
                Label("More", systemImage: "ellipsis.circle")
            }
        }
    }

    /// The transcript has to be loaded — it is what the queued request carries
    /// as its fallback and what the re-push preserves the rest of — and the
    /// budget has to have something left in it.
    ///
    /// Only `.running` closes the item. A `.queued` recording is one nobody is
    /// working on, and refusing it there is what left people stuck: a job iOS
    /// killed on the lock screen disabled its own retry for the life of the
    /// install. Asking again is exactly the right thing to be able to do.
    private var canReTranscribe: Bool {
        guard meta != nil, retriesRemaining > 0 else { return false }
        return backfill != .running
    }

    /// Why the item above is disabled, when it is. nil when it is not: a menu
    /// that explains an action you can simply take is noise.
    private var reTranscribeNote: String? {
        if backfill == .running {
            return String(localized: "Already re-transcribing this recording.")
        }
        if retriesRemaining <= 0 {
            return String(
                localized: "This recording has been re-transcribed as many times as allowed.")
        }
        return nil
    }

    /// Send the audio for transcription again and replace the transcript with
    /// what comes back.
    ///
    /// The audio has to be on the phone first, because the queue transcribes a
    /// local file — so a recording that was never downloaded is downloaded
    /// here, through the same model the toolbar's own button drives. That is
    /// also why there is no progress indicator of its own for this step: the
    /// download ring is already in the toolbar and is already showing it.
    private func reTranscribe() async {
        guard orgId == nil, let meta else { return }
        reTranscribeError = nil

        var source = audioURL
        if source == nil {
            await downloads.download(summary.id, cloud: app.cloud)
            source = audioURL
        }
        guard let source else {
            // `download` records the reason as the row's state; it is a better
            // message than anything this screen could invent.
            if case .failed(let message) = downloads.state(for: summary.id) {
                reTranscribeError = message
            } else {
                reTranscribeError = String(localized: "Download failed")
            }
            return
        }

        do {
            try MeetingUploader.enqueueManualBackfill(
                summary: summary, meta: meta, audioAt: source)
        } catch {
            reTranscribeError = error.localizedDescription
            refreshReTranscribeState()
            return
        }

        await drainNow()
    }

    /// Run the queue now, for a request that is already in it.
    ///
    /// What the "start now" button in the status panel does, and what the tail
    /// of `reTranscribe()` does once it has queued the work. Deliberately not a
    /// second `enqueueManualBackfill`: the manifest and the audio are already on
    /// disk, and re-queuing would spend another retry from the budget for a job
    /// the user has already paid for. This is the foregrounding drain, asked for
    /// by hand.
    private func drainNow() async {
        // Whatever the last attempt said is about to be answered by this one,
        // and a red line under a live spinner is the panel claiming both at
        // once.
        reTranscribeError = nil
        // Optimistic, and true within the frame: the drain below is what runs
        // this recording. It is also what takes the button off the screen, so
        // the same pass cannot be asked for twice while it is under way.
        backfill = .running
        let result = await app.syncPendingBackfills()
        refreshReTranscribeState()
        if backfill == .none {
            // Gone from the queue is the one unambiguous "it worked": the new
            // transcript is on the server, and `load()` is what puts it on the
            // screen.
            await load()
            return
        }
        // Still queued. Say what went wrong — the queue now keeps the reason
        // instead of swallowing it — and let the panel below say what happens
        // to the request next.
        reTranscribeError = failureMessage(result.failure)
    }

    /// Why a pass came back without this recording's new transcript.
    ///
    /// The queue's own reason when it kept one and it is a reason worth reading.
    /// A `CancellationError` is not: it means the app went away mid-pass, which
    /// the reader can see for themselves and which the foreground drain already
    /// takes care of.
    private func failureMessage(_ failure: Error?) -> String {
        if let failure, !(failure is CancellationError) {
            return failure.localizedDescription
        }
        return String(localized: "Re-transcribing didn't finish this time.")
    }

    /// A backfill — possibly another recording's — finished pushing.
    ///
    /// Reloading rather than matching ids: `backfillRevision` is a counter by
    /// design, and a wasted meta fetch on the recording that is on screen costs
    /// less than the bookkeeping to avoid it.
    private func backfillLanded() async {
        refreshReTranscribeState()
        if backfill == .none { reTranscribeError = nil }
        await load()
    }

    private func refreshReTranscribeState() {
        guard orgId == nil else { return }
        backfill = MeetingUploader.backfillState(for: summary.id)
        retriesRemaining = MeetingUploader.manualRetriesRemaining(for: summary.id)
    }

    /// What the view renders, and therefore what "copy the transcript" means
    /// here: the tentative tail a live session leaves behind never reaches this
    /// screen, so it must not reach the pasteboard either.
    private var readable: [TranscriptSegment] {
        meta?.segments.filter { $0.isFinal } ?? []
    }

    private func plainTranscript() -> String {
        guard let meta else { return "" }
        return TranscriptClipboard.plainText(readable) { meta.speakerLabel(for: $0) }
    }

    /// One continuous column, the way the desktop reads a transcript: the meta
    /// line, the highlights, then turn after turn separated by whitespace. No
    /// rows, no rules, no cards — the speaker label is what marks a turn's start,
    /// so nothing else has to.
    ///
    /// `safeAreaInset` is what pins the player: the scroll view keeps its own
    /// scrolling and its own safe area, and the block occupies the top of it
    /// without being part of the content.
    private func transcript(_ meta: RecordingMeta) -> some View {
        let segments = meta.segments.filter { $0.isFinal }
        let current = currentTurn(segments)
        // Computed once per render and handed down two ways: the flat list is
        // what `n of N` counts and what the chevrons walk, and the grouping is
        // what each turn highlights from without re-scanning the whole list.
        let hits = TranscriptSearch.hits(in: segments, query: query)
        let byTurn = Dictionary(grouping: hits, by: { $0.segmentID })
        let active = hits.indices.contains(currentHit) ? hits[currentHit] : hits.first
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    reTranscribeStatus
                    header(meta)
                    findings(meta)
                    if segments.isEmpty {
                        Text("This recording has no transcript.")
                            .font(.parley.subheadline)
                            .foregroundStyle(Color(.secondaryLabel))
                    }
                    ForEach(segments, id: \.id) { seg in
                        turn(
                            seg, meta: meta, isCurrent: seg.id == current,
                            hits: byTurn[seg.id] ?? [], active: active)
                    }
                }
                .padding(20)
            }
            // A user pan turns following off. `simultaneousGesture` so the scroll
            // view still scrolls — this only wants to *know*, not to take the
            // gesture. It never fires for a programmatic `scrollTo`, which is
            // precisely the distinction that has to be made.
            .simultaneousGesture(
                DragGesture(minimumDistance: 8).onChanged { _ in followsAudio = false })
            // 2× while an edge is held, and it lives here rather than in the
            // strips it draws. An overlay is a *sibling* layered above the scroll
            // view, and hit testing — which runs before any gesture arbitration —
            // hands the touch to the topmost layer that will take it and never
            // gives it back to the one underneath. A strip that merely *might*
            // want the touch therefore takes it away from the scroll view's pan
            // outright, which is how 44pt of each edge stopped scrolling at all.
            // On the scroll view the press is in the pan's own arena and loses to
            // it by priority the moment the finger moves.
            .simultaneousGesture(twoXHold)
            // The scroll view's own width, for the edge test above.
            .background {
                GeometryReader { geo in
                    Color.clear
                        .onAppear { transcriptWidth = geo.size.width }
                        .onChange(of: geo.size.width) { _, width in transcriptWidth = width }
                }
            }
            .overlay(alignment: .top) { twoXPill }
            .overlay { edgeZones }
            // The one place 2× is released, and it is driven by the gesture state
            // unwinding rather than by an `onEnded`: a cancelled press has no end.
            .onChange(of: pressing) { _, down in
                guard !down else { return }
                playback.holdTwoX(false)
                pressStart = nil
            }
            .onChange(of: current) { _, turn in
                guard followsAudio, playback.isPlaying, let turn else { return }
                // Upper third, so there is context above and a paragraph's worth
                // of what is coming below. Once per turn change, which is what
                // keying the change on the turn id rather than on the clock buys.
                withAnimation(.easeOut(duration: 0.35)) {
                    proxy.scrollTo(turn, anchor: UnitPoint(x: 0, y: 0.3))
                }
            }
            .onChange(of: playback.isPlaying) { _, playing in
                if playing { followsAudio = true }
            }
            // A seek is not the same question as following. Following asks
            // whether the app may move the page while nobody asked it to, and
            // while paused the answer is no; a seek *is* the asking, so it takes
            // the reader there unconditionally — paused as much as playing, which
            // is the whole of dragging the timeline to a point to read what was
            // said at it.
            //
            // The target is recomputed here rather than left to `onChange(of:
            // current)` below. Both run in the same update, in modifier order,
            // and that one reads `followsAudio` before this one has written it —
            // so a discrete seek, the VoiceOver ±15 s or a short flick, is lost
            // between them. Recomputing sidesteps the ordering entirely: it does
            // not care whether `current` changed at all.
            //
            // Unanimated on purpose. A scrub emits one of these per frame, and
            // 0.35 s animations sixty times a second pile up and read as lag; a
            // seek is a jump, and the finger is already supplying the continuity.
            .onChange(of: playback.seekGeneration) { _, _ in
                followsAudio = true
                guard let turn = currentTurn(segments) else { return }
                proxy.scrollTo(turn, anchor: UnitPoint(x: 0, y: 0.3))
            }
            // A new query starts again from the top hit and takes the reader
            // there. Recomputed inside rather than closing over `hits`, so the
            // scroll target is the new query's first match and not the previous
            // keystroke's.
            .onChange(of: query) { _, typed in
                currentHit = 0
                guard let first = TranscriptSearch.hits(in: segments, query: typed).first
                else { return }
                followsAudio = false
                withAnimation(.easeOut(duration: 0.35)) {
                    proxy.scrollTo(first.segmentID, anchor: UnitPoint(x: 0, y: 0.3))
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                matchBar(hits: hits, proxy: proxy)
            }
        }
        // Both pinned blocks in one inset, in the order they read: the player,
        // then the query. The field goes *under* the player rather than over
        // it because the player is what this screen is for — searching is a
        // thing you do to the transcript, and it belongs next to the transcript.
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                PlaybackBar(controller: playback, summary: summary, orgId: orgId)
                if searching { searchField }
            }
        }
    }

    /// `n of N` and the two chevrons, pinned under the transcript while a query
    /// is live and gone the moment it is cleared.
    ///
    /// A `safeAreaInset` for the same reason the player is one: the transcript
    /// keeps its own scrolling and scrolls *under* the bar, so walking the hits
    /// never has the counter scroll away from the reader who is using it.
    ///
    /// Same chrome as `PlaybackBar` — page-coloured with a hairline — so the
    /// screen reads as one surface with something pinned at each end rather
    /// than a transcript wedged between two tinted bands.
    @ViewBuilder
    private func matchBar(hits: [TranscriptSearch.Hit], proxy: ScrollViewProxy) -> some View {
        if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            HStack(spacing: 18) {
                if hits.isEmpty {
                    Text("No matches")
                } else {
                    Text("\(min(currentHit, hits.count - 1) + 1) of \(hits.count)")
                        .monospacedDigit()
                }
                Spacer(minLength: 0)
                // Up and down, not left and right: the transcript is one
                // column and the previous match is above the thumb, not behind
                // it.
                chevron("chevron.up", label: "Previous match", hits: hits, step: -1, proxy: proxy)
                chevron("chevron.down", label: "Next match", hits: hits, step: 1, proxy: proxy)
            }
            .font(.parley.footnote)
            .foregroundStyle(Color(.secondaryLabel))
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .background(Theme.background)
            .overlay(alignment: .top) {
                Rectangle()
                    .fill(Color(.separator))
                    .frame(height: 0.5)
            }
        }
    }

    private func chevron(
        _ symbol: String, label: LocalizedStringKey, hits: [TranscriptSearch.Hit],
        step delta: Int, proxy: ScrollViewProxy
    ) -> some View {
        Button {
            step(delta, hits: hits, proxy: proxy)
        } label: {
            Image(systemName: symbol)
                .font(.parley.footnote.weight(.semibold))
                // A caption-sized glyph is a 10pt target; the padding is what
                // makes it a thumb-sized one without making it look like a
                // button.
                .frame(width: 32, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(hits.isEmpty)
        .accessibilityLabel(label)
    }

    /// Move to the next or previous hit, wrapping at both ends.
    ///
    /// Turns following off, and that is the point of it: without this, the next
    /// turn change during playback scrolls the transcript off the hit the reader
    /// just asked to be taken to. Somebody walking matches is reading, not
    /// listening along, and the playhead has to give way.
    private func step(_ delta: Int, hits: [TranscriptSearch.Hit], proxy: ScrollViewProxy) {
        guard !hits.isEmpty else { return }
        let from = min(currentHit, hits.count - 1)
        let next = (from + delta + hits.count) % hits.count
        currentHit = next
        followsAudio = false
        withAnimation(.easeOut(duration: 0.35)) {
            proxy.scrollTo(hits[next].segmentID, anchor: UnitPoint(x: 0, y: 0.3))
        }
    }

    /// One turn. The speaker label goes **blue while the audio is inside this
    /// turn** — the same rule as the live screen, where blue means "this is
    /// happening now". On a finished recording nothing is happening until
    /// somebody presses play, and then exactly one turn is.
    private func turn(
        _ seg: TranscriptSegment, meta: RecordingMeta, isCurrent: Bool,
        hits: [TranscriptSearch.Hit], active: TranscriptSearch.Hit?
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(verbatim: meta.speakerLabel(for: seg))
                    .font(.parley.footnote.weight(.semibold))
                    .foregroundStyle(isCurrent ? Theme.primary : Color(.secondaryLabel))
                // The timecode is the way into the audio from the text. A plain
                // tertiary numeral rather than a tinted control: it is one of
                // dozens on the screen, and colouring every one of them blue
                // would spend the signal on furniture.
                Button {
                    playback.seek(to: Double(seg.startMs) / 1000)
                } label: {
                    Text(verbatim: TranscriptClipboard.clock(seg.startMs))
                        .font(.parley.caption2.monospacedDigit())
                        .foregroundStyle(Color(.tertiaryLabel))
                }
                .buttonStyle(.plain)
                .disabled(!playback.isSeekable)
            }
            Text(highlighting(seg, hits: hits, active: active))
                .font(.parley.body)
                .foregroundStyle(flashedTurn == seg.id ? Theme.primary : Color(.label))
                .textSelection(.enabled)
                // The words are the target people actually reach for — the
                // timecode is a caption-sized numeral nobody finds. A tap
                // anywhere in the paragraph seeks to where the paragraph starts.
                //
                // `onTapGesture` and not `simultaneousGesture(TapGesture())`:
                // the shared version never fires here at all, because the
                // selectable `Text` has recognizers of its own and a
                // simultaneous tap loses to them. Ordering matters too — this
                // has to come *after* `textSelection`. Nothing is given up by
                // taking the tap outright: the long press belongs to the row's
                // `contextMenu` below, which is where "Copy" has always lived
                // on this screen, and a drag still belongs to the scroll view.
                .onTapGesture { seekToTurn(seg) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .id(seg.id)
        // Selection alone can't reach the speaker and the clock — they are
        // separate `Text` views — so the row-level copy takes the whole turn,
        // header included.
        .contextMenu {
            Button("Copy", systemImage: "doc.on.doc") {
                TranscriptClipboard.write(
                    TranscriptClipboard.plainText(
                        seg, label: meta.speakerLabel(for: seg)))
            }
        }
    }

    /// A turn's text with its search hits marked.
    ///
    /// Background tint rather than bold or a colour change: the transcript is a
    /// page of prose in one weight, and re-weighting words inside it makes the
    /// paragraph look mis-set. A wash behind the glyphs leaves the text exactly
    /// as it reads unsearched — which matters, because every other hit stays on
    /// screen while the reader works through them.
    ///
    /// Two strengths. Every hit gets the pale one so the reader can see how the
    /// matches are distributed; the current one gets twice that, so `n of N` is
    /// pointing at something findable without a second kind of mark.
    ///
    /// `Text(verbatim:)` is not used any more, but nothing is given up: an
    /// `AttributedString` built from a plain `String` carries no markdown
    /// parsing either, so a turn containing `*` or `_` still renders as spoken.
    private func highlighting(
        _ seg: TranscriptSegment, hits: [TranscriptSearch.Hit],
        active: TranscriptSearch.Hit?
    ) -> AttributedString {
        var text = AttributedString(seg.text)
        for hit in hits {
            guard let range = Range(hit.range, in: text) else { continue }
            text[range].backgroundColor = Theme.primary.opacity(hit == active ? 0.5 : 0.25)
        }
        return text
    }

    /// Send the audio to the start of a turn, and say so.
    ///
    /// A no-op with no visual answer when the audio is not on the phone: the
    /// timecode next to it is `.disabled` for the same reason, and a paragraph
    /// that flashed blue without the player moving would be a lie about what
    /// just happened. Seeking also re-enables following, via `seekGeneration` —
    /// somebody who taps a paragraph to hear it wants the transcript to keep up
    /// with the audio again.
    private func seekToTurn(_ seg: TranscriptSegment) {
        guard playback.isSeekable else { return }
        playback.seek(to: Double(seg.startMs) / 1000)
        withAnimation(.easeOut(duration: 0.1)) { flashedTurn = seg.id }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(250))
            // Guarded on the id so a second tap elsewhere, landing inside this
            // one's 250 ms, does not have its own flash cancelled by the first
            // tap's timer coming due.
            guard flashedTurn == seg.id else { return }
            withAnimation(.easeOut(duration: 0.2)) { flashedTurn = nil }
        }
    }

    /// The turn the playhead is inside: the last one that has started.
    ///
    /// Deliberately by `startMs` alone rather than by the `startMs…endMs` range.
    /// The ranges have gaps — a pause between turns belongs to neither — and
    /// during a pause the turn that was just spoken is the one a reader's eye is
    /// on, so it keeps the label rather than handing it back to nobody.
    private func currentTurn(_ segments: [TranscriptSegment]) -> String? {
        guard playback.duration > 0 else { return nil }
        let ms = UInt64(max(0, playback.currentTime * 1000))
        var found: String?
        for seg in segments {
            if seg.startMs <= ms { found = seg.id } else { break }
        }
        return found
    }

    /// How wide a band at either edge holds 2×. The same number twice over: the
    /// strips `edgeZones` draws, and the test `twoXHold` applies.
    private static let edgeBand: CGFloat = 44

    /// The two strips that mark where 2× can be held — YouTube's gesture, on the
    /// only part of this screen with room for it.
    ///
    /// They are a map and nothing else: `allowsHitTesting(false)`, because the
    /// gesture itself is on the scroll view. An overlay is a sibling layered
    /// above the scroll view, not a descendant of it, and hit testing runs before
    /// gesture arbitration — so a strip that takes the touch keeps it, and the
    /// pan recognizer underneath never enters the arena at all. That is not a
    /// theory: gating these on `searching` was once necessary because the
    /// right-hand strip sat on top of the "next match" chevron and swallowed
    /// taps meant for a `Button`, a far stronger claimant than a pan. Inert, the
    /// strips cannot swallow anything, and the gate is gone with them — 2× works
    /// while searching again.
    ///
    /// **Do not put the gesture back here.** It scrolls because it is over there.
    private var edgeZones: some View {
        HStack(spacing: 0) {
            edgeZone
            Spacer(minLength: 0)
            edgeZone
        }
        .allowsHitTesting(false)
    }

    private var edgeZone: some View {
        Color.clear
            .frame(width: Self.edgeBand)
            .accessibilityLabel("Playback speed")
            .accessibilityHint("Hold for 2×")
    }

    /// Hold an edge of the transcript for 2×, released on let-go.
    ///
    /// `simultaneously(with:)` and not `sequenced(before:)` because the decision
    /// needs the touch's *location* from first touch-down, and a long press
    /// carries none — the drag is there to say where, not to move. It is also
    /// what keeps the state honest: `pressing` follows the drag, which lives
    /// until the finger leaves, where the press is over the moment its 0.35 s is
    /// up.
    ///
    /// `maximumDistance` is what keeps scrolling clean. A finger already on its
    /// way fails the press at 10pt and the pan carries on; a finger that stays
    /// put for a third of a second meant it.
    ///
    /// The press's own `onEnded` is the moment 2× engages, and it has to be:
    /// a `LongPressGesture`'s value reads `true` from touch-down — it means "a
    /// press is being detected", not "a press has succeeded" — so engaging on
    /// the value would put every tap near an edge into 2× for as long as the tap
    /// lasted. `onEnded` fires when the duration is satisfied, which is the
    /// thing being asked about.
    private var twoXHold: some Gesture {
        LongPressGesture(minimumDuration: 0.35, maximumDistance: 10)
            .onEnded { _ in
                guard let start = pressStart, startedInEdgeBand(start) else { return }
                playback.holdTwoX(true)
            }
            .simultaneously(
                with: DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        // Written once per touch: `startLocation` does not move,
                        // and re-assigning it on every frame of a scroll would
                        // invalidate the whole transcript sixty times a second.
                        guard pressStart != value.startLocation else { return }
                        pressStart = value.startLocation
                    }
            )
            .updating($pressing) { value, state, _ in
                state = value.second != nil
            }
    }

    /// Whether a touch went down in one of the bands at either edge.
    ///
    /// The width guard is not paranoia: before the first layout `transcriptWidth`
    /// is 0, the right-hand test reads `x > -44`, and the whole page would be an
    /// edge band.
    private func startedInEdgeBand(_ point: CGPoint) -> Bool {
        guard transcriptWidth > 0 else { return false }
        return point.x < Self.edgeBand || point.x > transcriptWidth - Self.edgeBand
    }

    /// What YouTube shows while the same gesture is held: a small mark saying the
    /// speed is not the one you chose, so a release is obviously what ends it.
    ///
    /// A badge, so it takes no touches: it appears over the transcript in the
    /// middle of a hold, and a hit-testable one would be a hole in the page
    /// exactly where the reader is already pressing.
    @ViewBuilder
    private var twoXPill: some View {
        if playback.isHoldingTwoX {
            HStack(spacing: 4) {
                Text(verbatim: PlaybackRate.label(PlaybackController.heldRate))
                Image(systemName: "play.fill")
            }
            .font(.parley.footnote.monospacedDigit())
            .foregroundStyle(Color(.label))
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(
                Capsule().fill(Theme.background)
                    .overlay(Capsule().stroke(Color(.separator), lineWidth: 0.5)))
            .padding(.top, 8)
            .transition(.opacity)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    /// A few lines at the top of the transcript saying what this recording's
    /// re-transcription is doing, if anything.
    ///
    /// Deliberately not a spinner over the screen and deliberately not a
    /// disabled state on the text. The job takes minutes, the transcript that
    /// is already here is readable and playable throughout, and the only thing
    /// that changes when the new one lands is the words — so the honest UI is a
    /// sentence saying so, above a document that still works.
    ///
    /// The spinner belongs to `.running` **only**. Spinning over a request that
    /// nothing is running is the whole of the reported bug: the app said it was
    /// transcribing, it was not, and there was no second thing on the screen to
    /// contradict it. Waiting therefore gets plain text, the truth about what
    /// will move it, and a button that moves it now. For the same reason the
    /// failure line and the spinner are in different branches and can never
    /// appear together.
    @ViewBuilder
    private var reTranscribeStatus: some View {
        switch backfill {
        case .running:
            statusPanel {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.mini)
                    Text("Re-transcribing… this can take a few minutes.")
                }
                .font(.parley.footnote)
                .foregroundStyle(Color(.secondaryLabel))
                .accessibilityElement(children: .combine)
            }
        case .queued(let lastAttempt):
            statusPanel {
                failureLine
                VStack(alignment: .leading, spacing: 6) {
                    if let lastAttempt {
                        Text(
                            "Waiting to re-transcribe. It last tried \(lastAttempt.formatted(.relative(presentation: .named))), and tries again when you open Parley or bring it back to the front."
                        )
                    } else {
                        Text(
                            "Waiting to re-transcribe. Nothing is running it yet — it starts when you open Parley or bring it back to the front."
                        )
                    }
                    Button("Start now") { Task { await drainNow() } }
                        .font(.parley.footnote.weight(.semibold))
                        .accessibilityLabel("Start re-transcribing now")
                }
                .font(.parley.footnote)
                .foregroundStyle(Color(.secondaryLabel))
                .fixedSize(horizontal: false, vertical: true)
            }
        case .none:
            // Nothing is queued, so there is nothing to report but a refusal —
            // a download that failed, or a budget that is spent — and that has
            // to stay on screen, because it is the only account of a tap that
            // did not produce a re-transcription.
            if reTranscribeError != nil {
                statusPanel { failureLine }
                    .accessibilityElement(children: .combine)
            }
        }
    }

    /// The last attempt's complaint, in the one colour this screen uses for
    /// them. `verbatim` because the message is already localized — it comes
    /// from an `Error` or from `failureMessage`.
    @ViewBuilder
    private var failureLine: some View {
        if let reTranscribeError {
            Text(verbatim: reTranscribeError)
                .font(.parley.footnote)
                .foregroundStyle(Theme.destructive)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// The shape all three of those share: a left-aligned block above the
    /// header.
    ///
    /// Layout only, and no `accessibilityElement(children: .combine)` here on
    /// purpose. Combining is right for the branches that are pure prose, and
    /// wrong for the queued one, where a button folded into a paragraph is a
    /// button VoiceOver has to be talked into finding.
    private func statusPanel<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The recording's facts, as one plain secondary line. It used to sit in a
    /// pale-blue band, which made the least important thing on the page the only
    /// thing with a shape.
    ///
    /// Counted off `meta` rather than read off `summary`, with `summary` kept
    /// only as the fallback for what `meta` cannot answer. `summary` is a `let`
    /// handed in by the library row and is never refetched for the life of this
    /// screen, so after a re-transcription lands it describes the transcript
    /// that was just replaced — five speakers over a transcript that now has
    /// three. `meta` is what `load()` refreshes and what the rest of the page is
    /// already drawn from, so it is the only one of the two that can be right.
    private func header(_ meta: RecordingMeta) -> some View {
        let speakers = Self.speakerCount(meta) ?? summary.speakerCount ?? 0
        let findings = meta.findings.count
        return HStack(spacing: 14) {
            Label(
                Self.duration(meta.durationMs > 0 ? meta.durationMs : summary.durationMs),
                systemImage: "clock")
            Label("\(speakers) speakers", systemImage: "person.2")
            if findings > 0 {
                Label("\(findings) findings", systemImage: "lightbulb")
            }
            Spacer(minLength: 0)
        }
        .font(.parley.caption.monospacedDigit())
        .foregroundStyle(Color(.secondaryLabel))
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// How many people the transcript itself has in it, or nil when there is no
    /// transcript to count — a recording whose job never produced one keeps the
    /// server's number rather than being told it has nobody in it.
    private static func speakerCount(_ meta: RecordingMeta) -> Int? {
        let speakers = Set(meta.segments.filter { $0.isFinal }.map(\.speaker))
        return speakers.isEmpty ? nil : speakers.count
    }

    /// What the analysis found, above the transcript it was found in.
    ///
    /// A 2pt rule down the left edge in `label`, and nothing else: no violet, no
    /// glyph, no fill. The rule is the whole of the treatment because it is the
    /// only thing needed — it says "these lines are a different kind of thing
    /// from the transcript below" without claiming they are more important than
    /// what was actually said.
    @ViewBuilder
    private func findings(_ meta: RecordingMeta) -> some View {
        let found = meta.findings
        if !found.isEmpty {
            VStack(alignment: .leading, spacing: 14) {
                Text("Highlights")
                    .font(.parley.footnote.weight(.semibold))
                    .foregroundStyle(Color(.secondaryLabel))
                    .accessibilityAddTraits(.isHeader)
                ForEach(found) { finding in
                    HStack(alignment: .top, spacing: 12) {
                        Rectangle()
                            .fill(Color(.label))
                            .frame(width: 2)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(verbatim: finding.title)
                                .font(.parley.subheadlineEmphasized)
                                .foregroundStyle(Color(.label))
                            if !finding.detail.isEmpty {
                                Text(verbatim: finding.detail)
                                    .font(.parley.footnote)
                                    .foregroundStyle(Color(.secondaryLabel))
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Text(verbatim: TranscriptClipboard.clock(finding.atMs))
                                .font(.parley.caption2.monospacedDigit())
                                .foregroundStyle(Color(.tertiaryLabel))
                        }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityElement(children: .combine)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func load() async {
        #if DEBUG
            if ScreenshotDemo.servesFixtures {
                meta = ScreenshotDemo.meta
                return
            }
        #endif
        // Before the fetch, not after: this is local state, and a fetch that
        // fails still has to stop claiming a re-transcription is running.
        refreshReTranscribeState()
        do {
            meta =
                orgId == nil
                ? try await app.cloud.recordingMeta(id: summary.id)
                : try await app.cloud.orgRecordingMeta(orgId: orgId!, id: summary.id)
        } catch {
            self.error = error.localizedDescription
        }
    }

    static func duration(_ ms: Double) -> String {
        let s = Int(ms / 1000)
        if s >= 3600 { return String(format: "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60) }
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}
