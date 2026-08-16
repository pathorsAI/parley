import ParleyKit
import SwiftUI

/// Read-only transcript view for a synced recording — the phone's reading room.
/// No streaming replay theatrics: the transcript is a document here, rendered
/// at once, scrollable, with the desktop's speaker-label rules.
struct RecordingDetailView: View {
    @EnvironmentObject private var app: AppState
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
            ToolbarItem(placement: .topBarTrailing) {
                CopyTranscriptButton(
                    text: plainTranscript,
                    isEmpty: readable.isEmpty)
            }
        }
        .task { await load() }
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

    private func transcript(_ meta: RecordingMeta) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                header
                let segs = meta.segments.filter { $0.isFinal }
                if segs.isEmpty {
                    Text("This recording has no transcript.")
                        .font(.parley.subheadline)
                        .foregroundStyle(Theme.mutedForeground)
                }
                ForEach(segs, id: \.id) { seg in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            Text(verbatim: meta.speakerLabel(for: seg))
                                // `primary`, not `brand`: this is 12pt text on
                                // the page, and brand blue is the colour the
                                // dark palette replaces with sky precisely
                                // because it can't be read on a navy-black
                                // page. `brand` stays for the mark and the
                                // gradient, which are fills, not text.
                                .font(.parley.caption.weight(.semibold))
                                .foregroundStyle(Theme.primary)
                            Text(verbatim: TranscriptClipboard.clock(seg.startMs))
                                .font(.parley.caption2.monospacedDigit())
                                .foregroundStyle(Theme.mutedForeground.opacity(0.7))
                        }
                        Text(verbatim: seg.text)
                            .font(.parley.body)
                            .foregroundStyle(Theme.foreground)
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

    /// The recording's facts, in a pale-blue band rather than above a hairline:
    /// the landing site separates a section by filling it, not by ruling it off,
    /// and this is the one piece of chrome on an otherwise plain document.
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
        .foregroundStyle(Theme.mutedForeground)
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.tintedSurface, in: RoundedRectangle(cornerRadius: Theme.radius))
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
