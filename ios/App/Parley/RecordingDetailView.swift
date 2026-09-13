import ParleyKit
import SwiftUI

/// Read-only transcript view for a synced recording — the phone's reading room.
/// No streaming replay theatrics: the transcript is a document here, rendered
/// at once, scrollable, with the desktop's speaker-label rules.
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
    }

    /// Fetch this recording's audio, or show how far that has got.
    ///
    /// Nothing at all once the audio is here: the toolbar's job is to *get* the
    /// file, and a recording whose audio is on the phone has a player coming
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
    private func transcript(_ meta: RecordingMeta) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                header
                findings(meta)
                let segs = meta.segments.filter { $0.isFinal }
                if segs.isEmpty {
                    Text("This recording has no transcript.")
                        .font(.parley.subheadline)
                        .foregroundStyle(Color(.secondaryLabel))
                }
                ForEach(segs, id: \.id) { seg in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            // Plain secondary text, not blue and not a badge.
                            // Blue on this screen would claim something is
                            // happening now, and nothing on a finished recording
                            // is: every turn here is equally over.
                            Text(verbatim: meta.speakerLabel(for: seg))
                                .font(.parley.footnote.weight(.semibold))
                                .foregroundStyle(Color(.secondaryLabel))
                            Text(verbatim: TranscriptClipboard.clock(seg.startMs))
                                .font(.parley.caption2.monospacedDigit())
                                .foregroundStyle(Color(.tertiaryLabel))
                        }
                        Text(verbatim: seg.text)
                            .font(.parley.body)
                            .foregroundStyle(Color(.label))
                            .textSelection(.enabled)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    // Selection alone can't reach the speaker and the clock —
                    // they are separate `Text` views — so the row-level copy
                    // takes the whole turn, header included.
                    .contextMenu {
                        Button("Copy", systemImage: "doc.on.doc") {
                            TranscriptClipboard.write(
                                TranscriptClipboard.plainText(
                                    seg, label: meta.speakerLabel(for: seg)))
                        }
                    }
                }
            }
            .padding(20)
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
