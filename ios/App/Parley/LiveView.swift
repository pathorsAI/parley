import ParleyKit
import SwiftUI

/// The live screen: record an in-person meeting, watch the diarized
/// transcript grow. Signed-in users stream through the hosted STT relay with
/// their session token — no API keys on the phone.
struct LiveView: View {
    @EnvironmentObject private var app: AppState
    /// Everything about the recording itself lives in the recorder, including
    /// "am I recording?" — see `MeetingRecorder` for why that cannot be a flag
    /// this view sets once the microphone is finally up.
    @StateObject private var recorder = MeetingRecorder()
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
                        .fill(recorder.isRecording ? Theme.recording : Theme.mutedForeground.opacity(0.4))
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
                    LevelMeter(level: recorder.micLevel)
                }
                // Copying works mid-meeting on purpose: the reason to grab a
                // line is usually that it was just said.
                ToolbarItem(placement: .topBarTrailing) {
                    CopyTranscriptButton(
                        text: {
                            TranscriptClipboard.plainText(recorder.segments) {
                                TranscriptClipboard.liveLabel(for: $0)
                            }
                        },
                        isEmpty: recorder.segments.isEmpty)
                }
            }
            .alert("Before you start recording", isPresented: $showRecordingConsent) {
                Button("Cancel", role: .cancel) {}
                Button("Everyone has agreed") {
                    Task { await recorder.start(token: KeychainStore.get(AppState.tokenKey)) }
                }
            } message: {
                Text("Parley picks up the room through the microphone, sends the audio to your Parley account for live transcription, and syncs the recording and transcript there. Confirm that everyone present has agreed to be recorded.")
            }
            // The microphone is not coming back. End the meeting rather than
            // leave a recording on screen that records nothing — the audio up
            // to the failure is on disk and worth keeping.
            .onChange(of: recorder.lostMicrophone) {
                if recorder.lostMicrophone { Task { await recorder.stop(app: app) } }
            }
            #if DEBUG
                .task { ScreenshotDemo.seedLive(recorder) }
            #endif
        }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    if recorder.segments.isEmpty {
                        emptyState
                    }
                    ForEach(recorder.segments, id: \.id) { seg in
                        SegmentRow(segment: seg).id(seg.id)
                    }
                }
                .padding(20)
            }
            .onChange(of: recorder.segments.count) {
                if let last = recorder.segments.last {
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

    /// The one line under the transcript. Its *look* is the transcription's
    /// health, not just its words: a reconnect is a spinner in amber, because
    /// it is a pause the recording will come back from, while the sentence
    /// that says live transcription is over gets the icon and the weight of
    /// something the user may want to act on. Both are still only about the
    /// live transcript — the recording itself is unaffected either way.
    @ViewBuilder
    private func statusLine(_ status: String) -> some View {
        let health = recorder.transcription
        HStack(spacing: 6) {
            switch health {
            case .reconnecting:
                ProgressView()
                    .controlSize(.mini)
                    .tint(Theme.warning)
            case .stopped:
                Image(systemName: "bolt.horizontal.circle")
                    .font(.parley.caption)
            default:
                EmptyView()
            }
            Text(status)
                .font(.parley.caption)
                .lineLimit(2)
                .multilineTextAlignment(.center)
        }
        .foregroundStyle(
            {
                switch health {
                case .reconnecting: return Theme.warning
                // Full-weight ink rather than red: the live transcript is
                // over, but the recording is not, and colouring this like a
                // failure would say the opposite of what the sentence says.
                case .stopped: return Theme.foreground
                default: return Theme.mutedForeground
                }
            }())
        .accessibilityElement(children: .combine)
    }

    private var controls: some View {
        VStack(spacing: 12) {
            if let status = recorder.status {
                statusLine(status)
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
            if !recorder.isRecording && !app.hasAccount {
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
        recorder.isRecording
            ? AnyShapeStyle(Theme.recording)
            : AnyShapeStyle(Theme.brandGradient)
    }

    /// The button says what pressing it will actually do, so the signed-out case
    /// reads as a next step rather than a broken control.
    private var buttonTitle: String {
        if recorder.isBusy { return String(localized: "Wrapping up…") }
        if recorder.isRecording { return String(localized: "End meeting") }
        return app.hasAccount
            ? String(localized: "Start recording")
            : String(localized: "Sign in again to record")
    }

    private var buttonIcon: String {
        if recorder.isBusy { return "hourglass" }
        if recorder.isRecording { return "stop.circle.fill" }
        return app.hasAccount ? "record.circle" : "person.crop.circle"
    }

    /// The record button is never disabled. Before this, a signed-out launch put
    /// a permanently greyed-out Start recording on screen with no way to act on it — the
    /// bug App Review reported. A button that can't be pressed teaches nothing;
    /// one that opens sign-in does.
    ///
    /// It *is* inert while the meeting is wrapping up: at that point there is no
    /// action left to take, and a press that started a second recording on top
    /// of an upload is exactly the sort of thing this screen used to allow.
    private func toggle() {
        guard !recorder.isBusy else { return }
        if recorder.isRecording {
            Task { await recorder.stop(app: app) }
        } else if app.hasAccount {
            showRecordingConsent = true
        } else {
            // The gate in RootView normally keeps this unreachable, but a
            // session can expire while the app is open and on this screen.
            app.signIn()
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
