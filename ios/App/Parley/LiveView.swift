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
                Divider().overlay(Theme.border)
                controls
            }
            .background(Theme.background)
            // The principal item below draws the title, but `navigationTitle`
            // stays: it is what a pushed screen's back button says, and it is
            // the name the system uses when the app has no custom title view to
            // show (VoiceOver's rotor, Stage Manager, screen-time reports).
            .navigationTitle("Parley")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Circle()
                        .fill(store.isRecording ? Theme.recording : Theme.mutedForeground.opacity(0.4))
                        .frame(width: 9, height: 9)
                }
                // The product name is a wordmark, not a heading: Alexandria in
                // the brand gradient, the same mark the landing site sets.
                ToolbarItem(placement: .principal) {
                    Text(verbatim: "Parley")
                        .font(.parley.wordmark)
                        .foregroundStyle(Theme.brandGradient)
                        .accessibilityAddTraits(.isHeader)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    LevelMeter(level: store.micLevel)
                }
                // Copying works mid-meeting on purpose: the reason to grab a
                // line is usually that it was just said.
                ToolbarItem(placement: .topBarTrailing) {
                    CopyTranscriptButton(
                        text: {
                            TranscriptClipboard.plainText(store.segments) {
                                TranscriptClipboard.liveLabel(for: $0)
                            }
                        },
                        isEmpty: store.segments.isEmpty)
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
                LazyVStack(alignment: .leading, spacing: 16) {
                    if store.segments.isEmpty {
                        emptyState
                    }
                    ForEach(store.segments, id: \.id) { seg in
                        SegmentRow(segment: seg).id(seg.id)
                    }
                }
                .padding(20)
            }
            .onChange(of: store.segments.count) {
                if let last = store.segments.last {
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
        }
    }

    /// An empty transcript is most of the first launch, so it gets the room the
    /// landing site gives a section rather than the two grey lines it had: a
    /// tinted disc carrying the glyph in brand blue, and the sentence below it.
    private var emptyState: some View {
        VStack(spacing: 18) {
            Image(systemName: "waveform")
                .font(.parley.title)
                .foregroundStyle(Theme.brand)
                .frame(width: 88, height: 88)
                .background(Theme.tintedSurface, in: Circle())
                .accessibilityHidden(true)
            Text(app.hasAccount
                ? "Hit record and put the phone on the table to catch the whole room."
                : "Sign in again to pick up where you left off.")
                .font(.parley.subheadline)
                .foregroundStyle(Theme.mutedForeground)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 72)
        .padding(.bottom, 24)
    }

    private var controls: some View {
        VStack(spacing: 12) {
            if store.status != "idle" {
                Text(store.status)
                    .font(.parley.caption)
                    .foregroundStyle(Theme.mutedForeground)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }
            Button(action: toggle) {
                Label(buttonTitle, systemImage: buttonIcon)
                    .font(.parley.bodyEmphasized)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    // White in both appearances, on purpose: the fill under it
                    // is either the fixed brand gradient or recording red, and
                    // neither follows the system appearance, so its label
                    // must not either. `Theme.primaryForeground` inverts in
                    // dark mode and would land near-black on brand blue.
                    .foregroundStyle(Theme.onBrand)
                    .background(buttonFill, in: RoundedRectangle(cornerRadius: Theme.radius))
            }
            .buttonStyle(.plain)
            if !store.isRecording && !app.hasAccount {
                Text("Your session expired. Sign in with the button above and recording works again.")
                    .font(.parley.caption)
                    .foregroundStyle(Theme.mutedForeground)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(20)
    }

    /// Idle is *the* primary action on this screen, so it wears the Pathors
    /// gradient. Recording is a state rather than an action — flat red, so a
    /// glance never mistakes "in progress" for "press me".
    private var buttonFill: AnyShapeStyle {
        store.isRecording
            ? AnyShapeStyle(Theme.recording)
            : AnyShapeStyle(Theme.brandGradient)
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

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: TranscriptClipboard.liveLabel(for: segment))
                .font(.parley.caption2.weight(.semibold))
                .foregroundStyle(
                    segment.speaker == 0
                        ? Theme.mutedForeground
                        : Theme.speakers[(segment.speaker - 1) % Theme.speakers.count])
            // Selection is enabled on the tentative tail too. A phrase is worth
            // grabbing the second it appears, and waiting for the provider to
            // finalise the utterance is not a distinction the person holding
            // the phone can see.
            Text(verbatim: segment.text)
                .font(.parley.body)
                .foregroundStyle(segment.isFinal ? Theme.foreground : Theme.mutedForeground)
                .italic(!segment.isFinal)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // Bare text, no speaker or timestamp: this screen shows neither a clock
        // nor a name, and a copy that carries more than what is on screen is a
        // surprise.
        .contextMenu {
            Button("Copy", systemImage: "doc.on.doc") {
                TranscriptClipboard.write(segment.text)
            }
            .disabled(segment.text.isEmpty)
        }
    }
}

struct LevelMeter: View {
    let level: Float

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.muted)
                Capsule()
                    .fill(Theme.brandGradient)
                    .frame(width: geo.size.width * CGFloat(min(1, level * 6)))
                    .animation(.linear(duration: 0.08), value: level)
            }
        }
        .frame(width: 70, height: 5)
    }
}

#if DEBUG
    // A bare `AppState()` reads the keychain and nothing else, so the previews
    // land on the signed-out empty state — which is the one worth eyeballing
    // here. `SegmentRow` and `LevelMeter` get their own preview below because
    // seeding a live transcript needs the demo fixtures the app only serves
    // under the `-ParleyDemo` launch argument.
    #Preview("Live — light") {
        LiveView().environmentObject(AppState())
    }

    #Preview("Live — dark") {
        LiveView()
            .environmentObject(AppState())
            .preferredColorScheme(.dark)
    }

    #Preview("Segments") {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ForEach(0..<7) { speaker in
                    SegmentRow(
                        segment: TranscriptSegment(
                            id: "s\(speaker)", source: "mix", speaker: speaker,
                            text: "Speaker \(speaker) says something worth reading back.",
                            isFinal: speaker != 6, startMs: 0, endMs: 1_000))
                }
                LevelMeter(level: 0.12)
            }
            .padding(20)
        }
        .background(Theme.background)
    }
#endif
