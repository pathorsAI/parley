import ParleyKit
import SwiftUI

/// The live screen, walking-skeleton edition: mic level proves the
/// AVAudioEngine → 16 kHz mono pipeline; the demo feed proves the Soniox
/// parser + segment upsert + UI. The relay hookup lands once cloud auth
/// (Phase 0) exists.
struct LiveView: View {
    @StateObject private var store = TranscriptStore()
    @State private var capture: AudioCapture?
    @State private var demoTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            transcript
            Divider()
            controls
        }
        .background(Color(.systemBackground))
    }

    private var header: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(store.isRecording ? Color.red : Color.secondary.opacity(0.4))
                .frame(width: 10, height: 10)
            Text("Parley").font(.headline)
            Text(store.status).font(.caption).foregroundStyle(.secondary)
            Spacer()
            LevelMeter(level: store.micLevel)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if store.segments.isEmpty {
                        Text("按 Demo 重播一段談判逐字稿，或按錄音測試收音。")
                            .foregroundStyle(.secondary)
                            .font(.subheadline)
                            .padding(.top, 40)
                            .frame(maxWidth: .infinity)
                    }
                    ForEach(store.segments, id: \.id) { seg in
                        SegmentRow(segment: seg)
                            .id(seg.id)
                    }
                }
                .padding(16)
            }
            .onChange(of: store.segments.count) {
                if let last = store.segments.last {
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
        }
    }

    private var controls: some View {
        HStack(spacing: 12) {
            Button(action: toggleRecord) {
                Label(
                    store.isRecording ? "停止" : "錄音測試",
                    systemImage: store.isRecording ? "stop.circle.fill" : "mic.circle.fill"
                )
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(store.isRecording ? .red : .accentColor)

            Button(action: runDemo) {
                Label("Demo", systemImage: "play.circle")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
        }
        .padding(16)
    }

    private func toggleRecord() {
        if store.isRecording {
            capture?.stop()
            capture = nil
            store.isRecording = false
            store.status = "idle"
            store.micLevel = 0
            return
        }
        Task {
            guard await AudioCapture.requestPermission() else {
                store.status = "mic permission denied"
                return
            }
            let cap = AudioCapture { _, level in
                Task { @MainActor in store.micLevel = level }
            }
            do {
                try cap.start()
                capture = cap
                store.isRecording = true
                store.status = "capturing 16k mono"
            } catch {
                store.status = "audio error: \(error.localizedDescription)"
            }
        }
    }

    private func runDemo() {
        demoTask?.cancel()
        store.clear()
        store.status = "demo replay"
        demoTask = DemoFeed.run { seg in
            store.upsert(seg)
            if seg.id.hasSuffix("-tail") == false && seg.text.contains("核心模組") {
                store.status = "demo done"
            }
        }
    }
}

private struct SegmentRow: View {
    let segment: TranscriptSegment

    private var label: String {
        segment.speaker == 0 ? "…" : "Speaker \(segment.speaker)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(segment.speaker == 1 ? Color.blue : Color.orange)
            Text(segment.text)
                .font(.body)
                .foregroundStyle(segment.isFinal ? .primary : .secondary)
                .italic(!segment.isFinal)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct LevelMeter: View {
    let level: Float

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.15))
                Capsule()
                    .fill(Color.green)
                    .frame(width: geo.size.width * CGFloat(min(1, level * 6)))
                    .animation(.linear(duration: 0.08), value: level)
            }
        }
        .frame(width: 90, height: 6)
    }
}
