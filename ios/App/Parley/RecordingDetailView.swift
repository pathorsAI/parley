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
/// turn it is inside, and a turn's timecode seeks the audio.
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
            // Declared first so copy keeps the outermost trailing position it
            // has always had.
            ToolbarItem(placement: .topBarTrailing) { downloadControl }
            ToolbarItem(placement: .topBarTrailing) {
                CopyTranscriptButton(
                    text: plainTranscript,
                    isEmpty: readable.isEmpty)
            }
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
                .foregroundStyle(Color(.label))
                .textSelection(.enabled)
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
