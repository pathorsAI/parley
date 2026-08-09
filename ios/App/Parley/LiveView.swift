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
            .alert("Before you start recording", isPresented: $showRecordingConsent) {
                Button("Cancel", role: .cancel) {}
                Button("Everyone has agreed") {
                    Task { await start() }
                }
            } message: {
                Text("Parley picks up the room through the microphone, sends the audio to your Parley account for live transcription, and syncs the recording and transcript there. Confirm that everyone present has agreed to be recorded.")
            }
            #if DEBUG
                .task { ScreenshotDemo.seedLive(store) }
            #endif
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
            Text(app.hasAccount
                ? "Hit record and put the phone on the table to catch the whole room."
                : "Sign in again to pick up where you left off.")
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
                Label(buttonTitle, systemImage: buttonIcon)
                    .font(.body.weight(.medium))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                    .foregroundStyle(store.isRecording ? Color.white : Theme.primaryForeground)
            }
            .buttonStyle(.borderedProminent)
            .tint(store.isRecording ? Theme.recording : Theme.primary)
            if !store.isRecording && !app.hasAccount {
                Text("Your session expired. Sign in with the button above and recording works again.")
                    .font(.caption)
                    .foregroundStyle(Theme.mutedForeground)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(16)
    }

    /// The button says what pressing it will actually do, so the signed-out case
    /// reads as a next step rather than a broken control.
    private var buttonTitle: String {
        if store.isRecording { return String(localized: "End meeting") }
        return app.hasAccount
            ? String(localized: "Start recording")
            : String(localized: "Sign in again to record")
    }

    private var buttonIcon: String {
        if store.isRecording { return "stop.circle.fill" }
        return app.hasAccount ? "record.circle" : "person.crop.circle"
    }

    /// The record button is never disabled. Before this, a signed-out launch put
    /// a permanently greyed-out Start recording on screen with no way to act on it — the
    /// bug App Review reported. A button that can't be pressed teaches nothing;
    /// one that opens sign-in does.
    private func toggle() {
        if store.isRecording {
            Task { await stop() }
        } else if app.hasAccount {
            showRecordingConsent = true
        } else {
            // The gate in RootView normally keeps this unreachable, but a
            // session can expire while the app is open and on this screen.
            app.signIn()
        }
    }

    private func start() async {
        guard await AudioCapture.requestPermission() else {
            store.status = String(localized: "Microphone access is required")
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
                store.status = String(localized: "Transcribing live")
            } catch {
                store.status = String(localized: "Relay connection failed — recording audio only")
            }
        } else {
            store.status = String(localized: "Not signed in — microphone test only")
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
            store.status = String(localized: "Audio error: \(error.localizedDescription)")
            await relayClient?.finish()
        }
    }

    private func stop() async {
        capture?.stop()
        capture = nil
        store.isRecording = false
        store.micLevel = 0
        if let relay {
            store.status = String(localized: "Wrapping up…")
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
            store.status = String(localized: "Not signed in — the recording was not uploaded")
            return
        }
        store.status = String(localized: "Uploading…")
        do {
            let outcome = try await uploader.finishAndUpload(
                segments: store.segments,
                cloud: app.cloud,
                defaultSave: app.defaultSave,
                orgs: app.orgs)
            if let outcome {
                app.pendingUploadCount = MeetingUploader.pendingCount
                store.status =
                    outcome.sharedToOrgName.map { String(localized: "Synced, and shared to “\($0)”") }
                    ?? String(localized: "Synced to the cloud")
            } else {
                store.status = String(localized: "That recording was too short to keep")
            }
        } catch let e as CloudError where e.status == 402 {
            app.pendingUploadCount = MeetingUploader.pendingCount
            store.status = String(
                localized:
                    "You're out of quota. The recording is safe on this phone and will sync once the quota resets."
            )
        } catch {
            app.pendingUploadCount = MeetingUploader.pendingCount
            store.status = String(
                localized:
                    "Sync failed for now. The recording is safe on this phone and will retry automatically."
            )
        }
    }

    private func handle(_ event: SttRelayEvent) {
        switch event {
        case .segment(let seg):
            store.upsert(seg)
        case .closed(let reason):
            store.status =
                store.isRecording ? String(localized: "Relay closed (\(reason))") : "idle"
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
