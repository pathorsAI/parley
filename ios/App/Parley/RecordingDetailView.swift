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

    /// The re-transcription confirmation, and whether one is in flight.
    ///
    /// `isReTranscribing` covers "queued" as well as "running": the queue is on
    /// disk, so a request that outlived the app is still this recording's
    /// pending re-transcription when the screen opens again.
    @State private var confirmingReTranscribe = false
    @State private var isReTranscribing = false
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
            // The overflow menu goes innermost, ahead of the two controls that
            // were here first: download and copy are the actions on this screen
            // and copy keeps the outermost trailing position it has always had.
            ToolbarItem(placement: .topBarTrailing) { overflowMenu }
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
    private var canReTranscribe: Bool {
        meta != nil && !isReTranscribing && retriesRemaining > 0
    }

    /// Why the item above is disabled, when it is. nil when it is not: a menu
    /// that explains an action you can simply take is noise.
    private var reTranscribeNote: String? {
        if isReTranscribing {
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
            return
        }

        isReTranscribing = true
        // Straight into the queue rather than waiting for the next foreground
        // pass: the person is looking at the screen they asked from.
        await app.syncPendingBackfills()

        if MeetingUploader.hasQueuedBackfill(for: summary.id) {
            // Still queued means the run did not land. Say so and leave it
            // there — the queue retries it, and nothing has been lost.
            reTranscribeError = String(
                localized: "Re-transcribing didn't finish. It stays queued and will be retried.")
            refreshReTranscribeState()
        } else {
            await load()
        }
    }

    private func refreshReTranscribeState() {
        guard orgId == nil else { return }
        isReTranscribing = MeetingUploader.hasQueuedBackfill(for: summary.id)
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
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    reTranscribeStatus
                    header
                    findings(meta)
                    if segments.isEmpty {
                        Text("This recording has no transcript.")
                            .font(.parley.subheadline)
                            .foregroundStyle(Color(.secondaryLabel))
                    }
                    ForEach(segments, id: \.id) { seg in
                        turn(seg, meta: meta, isCurrent: seg.id == current)
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
            .overlay(alignment: .top) { twoXPill }
            .overlay { edgeZones }
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
            .onChange(of: playback.seekGeneration) { _, _ in followsAudio = true }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            PlaybackBar(controller: playback, summary: summary, orgId: orgId)
        }
    }

    /// One turn. The speaker label goes **blue while the audio is inside this
    /// turn** — the same rule as the live screen, where blue means "this is
    /// happening now". On a finished recording nothing is happening until
    /// somebody presses play, and then exactly one turn is.
    private func turn(_ seg: TranscriptSegment, meta: RecordingMeta, isCurrent: Bool)
        -> some View
    {
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
            Text(verbatim: seg.text)
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

    /// The two invisible strips that hold 2× while pressed — YouTube's gesture,
    /// on the only part of this screen with room for it.
    ///
    /// 44pt of each edge, the full height of the transcript. They sit *over* the
    /// text and still let everything through: a `LongPressGesture` that has not
    /// fired yet claims nothing, so a scroll that starts in a strip scrolls, and
    /// a press that stays put for 0.35 s is unambiguous. Text selection and the
    /// turn's context menu both keep working because neither begins with a third
    /// of a second of stillness.
    private var edgeZones: some View {
        HStack(spacing: 0) {
            edgeZone
            Spacer(minLength: 0)
            edgeZone
        }
    }

    private var edgeZone: some View {
        Color.clear
            .frame(width: 44)
            .contentShape(Rectangle())
            .gesture(
                LongPressGesture(minimumDuration: 0.35)
                    // Sequenced with a drag that never has to move, so the finger
                    // can simply stay down: the long press satisfies the first
                    // half and the second half runs until release.
                    .sequenced(before: DragGesture(minimumDistance: 0))
                    .onChanged { value in
                        if case .second(true, _) = value { playback.holdTwoX(true) }
                    }
                    .onEnded { _ in playback.holdTwoX(false) }
            )
            .accessibilityLabel("Playback speed")
            .accessibilityHint("Hold for 2×")
    }

    /// What YouTube shows while the same gesture is held: a small mark saying the
    /// speed is not the one you chose, so a release is obviously what ends it.
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
            .accessibilityHidden(true)
        }
    }

    /// One line at the top of the transcript while a re-transcription is
    /// queued or running, and one line if the last one failed.
    ///
    /// Deliberately not a spinner over the screen and deliberately not a
    /// disabled state on the text. The job takes minutes, the transcript that
    /// is already here is readable and playable throughout, and the only thing
    /// that changes when the new one lands is the words — so the honest UI is a
    /// sentence saying so, above a document that still works.
    @ViewBuilder
    private var reTranscribeStatus: some View {
        if isReTranscribing || reTranscribeError != nil {
            VStack(alignment: .leading, spacing: 6) {
                if isReTranscribing {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.mini)
                        Text("Re-transcribing… this can take a few minutes.")
                    }
                    .font(.parley.footnote)
                    .foregroundStyle(Color(.secondaryLabel))
                }
                if let reTranscribeError {
                    Text(verbatim: reTranscribeError)
                        .font(.parley.footnote)
                        .foregroundStyle(Theme.destructive)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
        }
    }

    /// The recording's facts, as one plain secondary line. It used to sit in a
    /// pale-blue band, which made the least important thing on the page the only
    /// thing with a shape.
    private var header: some View {
        HStack(spacing: 14) {
            Label(Self.duration(summary.durationMs), systemImage: "clock")
            Label("\(summary.speakerCount ?? 0) speakers", systemImage: "person.2")
            if let n = summary.findingsCount, n > 0 {
                Label("\(n) findings", systemImage: "lightbulb")
            }
            Spacer(minLength: 0)
        }
        .font(.parley.caption.monospacedDigit())
        .foregroundStyle(Color(.secondaryLabel))
        .frame(maxWidth: .infinity, alignment: .leading)
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
