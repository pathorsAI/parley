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
        .task { await load() }
    }

    private func transcript(_ meta: RecordingMeta) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                header
                Divider()
                let segs = meta.segments.filter { $0.isFinal }
                if segs.isEmpty {
                    Text("This recording has no transcript.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.mutedForeground)
                }
                ForEach(segs, id: \.id) { seg in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 8) {
                            Text(meta.speakerLabel(for: seg))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Theme.mutedForeground)
                            Text(Self.clock(seg.startMs))
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(Theme.mutedForeground.opacity(0.7))
                        }
                        Text(seg.text)
                            .font(.body)
                            .foregroundStyle(Theme.foreground)
                            .textSelection(.enabled)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(16)
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Label(Self.duration(summary.durationMs), systemImage: "clock")
            Label("\(summary.speakerCount ?? 0) speakers", systemImage: "person.2")
            if let n = summary.findingsCount, n > 0 {
                Label("\(n) findings", systemImage: "lightbulb")
            }
            Spacer()
        }
        .font(.caption)
        .foregroundStyle(Theme.mutedForeground)
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

    static func clock(_ ms: UInt64) -> String {
        let s = ms / 1000
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    static func duration(_ ms: Double) -> String {
        let s = Int(ms / 1000)
        if s >= 3600 { return String(format: "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60) }
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}
