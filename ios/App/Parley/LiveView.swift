import ParleyKit
import SwiftUI

/// The live screen: record an in-person meeting, watch the diarized
/// transcript grow. Signed-in users stream through the hosted STT relay with
/// their session token — no API keys on the phone.
struct LiveView: View {
    @EnvironmentObject private var app: AppState
    @StateObject private var store = TranscriptStore()
    @State private var capture: AudioCapture?
    @State private var relay: SttRelayClient?
    @State private var uploader: MeetingUploader?
    @State private var showRecordingConsent = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                transcript
                Divider()
                controls
            }
            .background(Theme.background)
            .navigationTitle("Parley")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Circle()
                        .fill(store.isRecording ? Theme.recording : Theme.mutedForeground.opacity(0.4))
                        .frame(width: 9, height: 9)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    LevelMeter(level: store.micLevel)
                }
            }
            .alert("開始錄音前請確認", isPresented: $showRecordingConsent) {
                Button("取消", role: .cancel) {}
                Button("我已取得所有與會者同意") {
                    Task { await start() }
                }
            } message: {
                Text("Parley 會收取房間麥克風聲音，將音訊送往你的 Parley 雲端帳號進行即時轉錄，並同步儲存錄音與逐字稿。請先確認所有與會者同意錄音。")
            }
        }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if store.segments.isEmpty {
                        emptyState
                    }
                    ForEach(store.segments, id: \.id) { seg in
                        SegmentRow(segment: seg).id(seg.id)
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

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "waveform")
                .font(.title2)
                .foregroundStyle(Theme.mutedForeground)
            Text(app.signedIn ? "按下錄音，把手機放在桌上收整個房間。" : "登入後即可即時轉錄——設定 → 帳號。")
                .font(.subheadline)
                .foregroundStyle(Theme.mutedForeground)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
    }

    private var controls: some View {
        VStack(spacing: 8) {
            if store.status != "idle" {
                Text(store.status)
                    .font(.caption)
                    .foregroundStyle(Theme.mutedForeground)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }
            Button(action: toggle) {
                Label(
                    store.isRecording ? "結束會議" : "開始錄音",
                    systemImage: store.isRecording ? "stop.circle.fill" : "record.circle"
                )
                .font(.body.weight(.medium))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .foregroundStyle(store.isRecording ? Color.white : Theme.primaryForeground)
            }
            .buttonStyle(.borderedProminent)
            .tint(store.isRecording ? Theme.recording : Theme.primary)
            .disabled(!store.isRecording && !app.signedIn)
            if !store.isRecording && !app.signedIn {
                Text("請先到「設定」登入，錄音才會安全同步到你的雲端帳號。")
                    .font(.caption)
                    .foregroundStyle(Theme.mutedForeground)
            }
        }
        .padding(16)
    }

    private func toggle() {
        if store.isRecording {
            Task { await stop() }
        } else {
            showRecordingConsent = true
        }
    }

    private func start() async {
        guard await AudioCapture.requestPermission() else {
            store.status = "需要麥克風權限"
            return
        }
        store.clear()

        // Signed in → stream through the hosted relay; otherwise level-only.
        var relayClient: SttRelayClient?
        if let token = KeychainStore.get(AppState.tokenKey) {
            let client = SttRelayClient(
                options: .init(bearerToken: token, feature: "meeting")
            ) { event in
                Task { @MainActor in handle(event) }
            }
            do {
                try await client.start()
                relayClient = client
                store.status = "即時轉錄中"
            } catch {
                store.status = "relay 連線失敗，僅錄音"
            }
        } else {
            store.status = "未登入——僅收音測試"
        }
        self.relay = relayClient

        let rec = try? MeetingUploader()
        self.uploader = rec

        let cap = AudioCapture { samples, level in
            Task { @MainActor in store.micLevel = level }
            rec?.append(samples)
            if let relayClient {
                Task { try? await relayClient.send(pcm: samples) }
            }
        }
        do {
            try cap.start()
            capture = cap
            store.isRecording = true
        } catch {
            store.status = "audio error: \(error.localizedDescription)"
            await relayClient?.finish()
        }
    }

    private func stop() async {
        capture?.stop()
        capture = nil
        store.isRecording = false
        store.micLevel = 0
        if let relay {
            store.status = "收尾中…"
            await relay.finish()  // drain: the relay flushes the last utterance
        }
        await upload()
    }

    private func upload() async {
        guard let uploader else {
            store.status = "idle"
            return
        }
        self.uploader = nil
        guard app.signedIn else {
            store.status = "未登入——錄音未上傳"
            return
        }
        store.status = "上傳中…"
        do {
            let outcome = try await uploader.finishAndUpload(
                segments: store.segments,
                cloud: app.cloud,
                defaultSave: app.defaultSave,
                orgs: app.orgs)
            if let outcome {
                app.pendingUploadCount = MeetingUploader.pendingCount
                store.status =
                    outcome.sharedToOrgName.map { "已同步，並分享到「\($0)」" } ?? "已同步到雲端"
            } else {
                store.status = "錄音太短，已捨棄"
            }
        } catch let e as CloudError where e.status == 402 {
            app.pendingUploadCount = MeetingUploader.pendingCount
            store.status = "額度已用完，錄音已安全保留，額度恢復後會自動同步"
        } catch {
            app.pendingUploadCount = MeetingUploader.pendingCount
            store.status = "同步暫時失敗，錄音已安全保留，稍後會自動重試"
        }
    }

    private func handle(_ event: SttRelayEvent) {
        switch event {
        case .segment(let seg):
            store.upsert(seg)
        case .closed(let reason):
            store.status = store.isRecording ? "relay 已關閉（\(reason)）" : "idle"
            relay = nil
        case .error(let message):
            store.status = message
            relay = nil
        }
    }
}

struct SegmentRow: View {
    let segment: TranscriptSegment

    private static let palette: [Color] = [.blue, .orange, .purple, .teal, .pink, .indigo]

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(segment.speaker == 0 ? "…" : "Speaker \(segment.speaker)")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(
                    segment.speaker == 0
                        ? Theme.mutedForeground
                        : Self.palette[(segment.speaker - 1) % Self.palette.count])
            Text(segment.text)
                .font(.body)
                .foregroundStyle(segment.isFinal ? Theme.foreground : Theme.mutedForeground)
                .italic(!segment.isFinal)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct LevelMeter: View {
    let level: Float

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.muted)
                Capsule()
                    .fill(Color.green)
                    .frame(width: geo.size.width * CGFloat(min(1, level * 6)))
                    .animation(.linear(duration: 0.08), value: level)
            }
        }
        .frame(width: 70, height: 5)
    }
}
