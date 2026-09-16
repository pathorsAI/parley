import ParleyKit
import SwiftUI

/// The live screen: record an in-person meeting, watch the diarized
/// transcript grow. Signed-in users stream through the hosted STT relay with
/// their session token — no API keys on the phone.
///
/// Everything below the transcript is one column that answers one question in
/// order: *is it recording* (the red dot and the sentence), *for how long* (the
/// timer), *is it hearing me* (the waveform), and *how do I stop* (the circle).
/// Nothing on it is filled or tinted; the only colour is the recording red and
/// the blue on whoever is talking right now.
struct LiveView: View {
    @EnvironmentObject private var app: AppState
    /// Everything about the recording itself lives in the recorder, including
    /// "am I recording?" — see `MeetingRecorder` for why that cannot be a flag
    /// this view sets once the microphone is finally up.
    @StateObject private var recorder = MeetingRecorder()
    /// Only for the microphone-window bar below. The keyboard's window is not
    /// this screen's business, but the orange dot it lights is: someone who
    /// notices that dot opens Parley and lands *here*, and a record screen that
    /// says "not recording" while the indicator is on reads as a lie.
    @ObservedObject private var dictation = DictationCoordinator.shared
    /// The name-and-folder suggestion for the recording that just finished. It
    /// owns the pass and its own accepted state, so this view only has to say
    /// where the block goes and when a new recording retires it.
    @StateObject private var filing = FilingSuggestionModel()
    @State private var showRecordingConsent = false
    @State private var showDiscardConfirm = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                transcript
                // Above the controls, not in the transcript: it is about the
                // recording that just ended, and it must not scroll away with
                // the words.
                FilingSuggestionCard(model: filing)
                if dictation.window.isOpen() && !recorder.isRecording {
                    micWindowBar
                }
                Divider()
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
                // The product name is a wordmark, not a heading: Alexandria, in
                // ink. It used to carry the brand gradient, which made the one
                // fixed piece of the chrome the loudest thing on a page whose
                // whole job is to be quiet while somebody talks.
                ToolbarItem(placement: .principal) {
                    Text(verbatim: "Parley")
                        .font(.parley.wordmark)
                        .foregroundStyle(Color(.label))
                        .accessibilityAddTraits(.isHeader)
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
            // Keyed on the settled recording rather than on the meeting ending:
            // the suggestion is a write against a recording the cloud already
            // holds, so it cannot be offered before the upload lands. The
            // recorder clears `settled` when the next meeting starts, which is
            // what takes the previous block down.
            .onChange(of: recorder.settled?.id) {
                if let settled = recorder.settled {
                    filing.consider(settled, app: app)
                } else {
                    filing.forget()
                }
            }
            #if DEBUG
                .task { ScreenshotDemo.seedRecordScreen(recorder, filing: filing) }
            #endif
        }
    }

    // MARK: - Transcript

    /// One flowing column, like the desktop's transcript: no rows, no rules, no
    /// cards — a turn is separated from the next by whitespace and by its own
    /// speaker label, which is all a reader needs to see where one ends.
    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    if recorder.segments.isEmpty {
                        emptyState
                    }
                    ForEach(recorder.segments, id: \.id) { seg in
                        SegmentRow(segment: seg, isCurrent: seg.id == currentSpeakingID)
                            .id(seg.id)
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

    /// Who is talking *now*: the most recent segment the provider has not
    /// finalised yet. A final segment is something that was said; the tentative
    /// tail is the only thing on screen that is still happening, which is why it
    /// is the only label that gets the blue.
    private var currentSpeakingID: String? {
        recorder.segments.last { !$0.isFinal }?.id
    }

    /// An empty transcript is most of the first launch. It gets room and a
    /// sentence, and the glyph is a quiet mark rather than a blue one on a tinted
    /// disc: there is nothing happening yet, so there is nothing for the signal
    /// colour to point at.
    private var emptyState: some View {
        VStack(spacing: 18) {
            Image(systemName: "waveform")
                .font(.parley.title)
                .foregroundStyle(Color(.tertiaryLabel))
                .accessibilityHidden(true)
            Text(app.hasAccount
                ? "Hit record and put the phone on the table to catch the whole room."
                : "Sign in again to pick up where you left off.")
                .font(.parley.subheadline)
                .foregroundStyle(Color(.secondaryLabel))
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 72)
        .padding(.bottom, 24)
    }

    // MARK: - Status

    /// Recording is a state, and this is the sentence that says so: the red dot
    /// the whole platform uses, and two facts joined by a middot — that it is
    /// recording, and that the words are arriving live. Only while a meeting is
    /// actually running; there is no "not recording" to announce.
    @ViewBuilder
    private var recordingStatus: some View {
        if recorder.isRecording {
            HStack(spacing: 7) {
                Circle()
                    .fill(Theme.recording)
                    .frame(width: 8, height: 8)
                Text("Recording · live transcript")
                    .font(.parley.footnote)
                    .foregroundStyle(Color(.secondaryLabel))
            }
            .accessibilityElement(children: .combine)
        }
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
                case .stopped: return Color(.label)
                default: return Color(.secondaryLabel)
                }
            }())
        .accessibilityElement(children: .combine)
    }

    /// What the orange dot means, and the way out of it. Shown only while a
    /// window is actually open, and never during a meeting — a recording has
    /// its own reason to hold the microphone, and two explanations for one
    /// indicator is worse than none.
    private var micWindowBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "mic.fill")
                .font(.parley.footnote)
                .foregroundStyle(Theme.micWindow)
            VStack(alignment: .leading, spacing: 1) {
                Text("The microphone is open for the keyboard")
                    .font(.parley.caption.weight(.semibold))
                    .foregroundStyle(Color(.label))
                Text("Nothing is being recorded or transcribed.")
                    .font(.parley.caption2)
                    .foregroundStyle(Color(.secondaryLabel))
            }
            Spacer(minLength: 8)
            if let expiresAt = dictation.window.expiresAt {
                Text(expiresAt, style: .timer)
                    .font(.parley.caption2.monospacedDigit())
                    .foregroundStyle(Color(.secondaryLabel))
            }
            Button("End") {
                Task { await dictation.endWindow() }
            }
            .font(.parley.caption.weight(.semibold))
            .buttonStyle(.plain)
            .foregroundStyle(Theme.primary)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
    }

    // MARK: - Controls

    private var controls: some View {
        VStack(spacing: 14) {
            recordingStatus
            timer
            WaveformView(level: recorder.micLevel, sample: recorder.micSample, isActive: recorder.isRecording)
            if let status = recorder.status {
                statusLine(status)
            }
            recordControl
            if recorder.isRecording {
                discardControl
            }
            if !recorder.isRecording && !app.hasAccount {
                Text("Your session expired. Sign in with the button above and recording works again.")
                    .font(.parley.caption)
                    .foregroundStyle(Color(.secondaryLabel))
                    .multilineTextAlignment(.center)
            }
        }
        .padding(20)
    }

    /// How long this has been running, in ink. `Text(_:style:.timer)` rather
    /// than a string this view refreshes: the system redraws the digits, so a
    /// ticking clock costs no published state. Tabular figures, so it doesn't
    /// shuffle its own digits sideways every second.
    @ViewBuilder
    private var timer: some View {
        if let startedAt = recorder.startedAt, recorder.isRecording {
            Text(startedAt, style: .timer)
                .font(.parley.displayNumber)
                .foregroundStyle(Color(.label))
        } else {
            Text(verbatim: "0:00")
                .font(.parley.displayNumber)
                .foregroundStyle(Color(.tertiaryLabel))
                .accessibilityHidden(true)
        }
    }

    /// The way out for a recording that should not have started. Stop is
    /// "keep this"; without a second door every mis-tap became a two-second
    /// recording in the library. A confirmation follows, because it throws the
    /// audio away.
    ///
    /// It is an outlined capsule because the line of secondary text it used to
    /// be was indistinguishable from the explanatory prose on this same screen
    /// — same face, same size, same `secondaryLabel` — and its tap target was
    /// the height of one 15pt line. Ink and a hairline outline say "tappable"
    /// without saying "recommended": not red, because the record circle above
    /// it is already the screen's one red thing and a second would compete with
    /// the control the user actually reaches for (the keyboard's ✕ is drawn
    /// down for the same reason), and not blue, because blue here would be the
    /// app recommending that you throw the meeting away. The red belongs in the
    /// confirmation, which has it.
    private var discardControl: some View {
        Button {
            showDiscardConfirm = true
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "trash")
                Text("Discard")
            }
            .font(.parley.subheadlineEmphasized)
            .foregroundStyle(Color(.label))
            .padding(.horizontal, 18)
            // 44pt so the target is the HIG minimum rather than the line box,
            // and `contentShape` so the whole capsule takes the tap, not just
            // the glyph and the word.
            .frame(minHeight: 44)
            .contentShape(Capsule())
            .overlay(Capsule().stroke(Color(.separator), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(recorder.isBusy)
        .accessibilityLabel(Text("Discard recording"))
        .accessibilityHint(Text("Asks you to confirm, then throws the audio and transcript away."))
        .confirmationDialog(
            "Discard this recording?", isPresented: $showDiscardConfirm, titleVisibility: .visible
        ) {
            Button("Discard", role: .destructive) {
                Task { await recorder.discard() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The audio and transcript are thrown away. Nothing is saved or uploaded.")
        }
    }

    /// One circle, two states, no label.
    ///
    /// Idle it is the universal record glyph — a blue disc with a white circle
    /// inside — and recording it is the universal stop: the same disc in
    /// recording red with a white rounded square. There is nothing to read,
    /// because there is nothing to decide: the screen already says whether it is
    /// recording, so the control only has to be the thing you press.
    ///
    /// The button is never disabled. Before this, a signed-out launch put a
    /// permanently greyed-out control on screen with no way to act on it — the
    /// bug App Review reported. A button that can't be pressed teaches nothing;
    /// one that opens sign-in does. It *is* inert while the meeting is wrapping
    /// up, where there is no action left to take.
    private var recordControl: some View {
        Button(action: toggle) {
            ZStack {
                Circle()
                    .fill(recorder.isRecording ? Theme.recording : Theme.primary)
                    .frame(width: 64, height: 64)
                inner
            }
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .opacity(recorder.isBusy ? 0.6 : 1)
        .accessibilityLabel(accessibilityLabel)
    }

    /// White in both appearances, on purpose: the disc under it is either
    /// recording red or the signal blue, and neither follows the system
    /// appearance, so what sits on it must not either.
    @ViewBuilder
    private var inner: some View {
        if recorder.isBusy {
            ProgressView()
                .controlSize(.regular)
                .tint(.white)
        } else if recorder.isRecording {
            RoundedRectangle(cornerRadius: 4)
                .fill(.white)
                .frame(width: 18, height: 18)
        } else if app.hasAccount {
            Circle()
                .fill(.white)
                .frame(width: 22, height: 22)
        } else {
            // Signed out, the press opens sign-in rather than the microphone, so
            // the glyph says so — the sentence under the control carries the
            // rest.
            Image(systemName: "person.crop.circle")
                .font(.system(size: 26, weight: .regular))
                .foregroundStyle(.white)
        }
    }

    private var accessibilityLabel: Text {
        if recorder.isBusy { return Text("Wrapping up…") }
        if recorder.isRecording { return Text("Stop recording") }
        return app.hasAccount ? Text("Start recording") : Text("Sign in again to record")
    }

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

/// One turn of the live transcript: who, when, and what — the same three facts,
/// in the same order, as a recording opened a week later (`RecordingDetailView`)
/// and as the clipboard (`TranscriptClipboard`).
///
/// The speaker is a letter in plain text, not a coloured badge. Six per-speaker
/// hues had to be told apart at a glance in a moving column and could not be,
/// and they collided with the one meaning colour carries here: `isCurrent` — the
/// turn the provider has not finalised yet, the only thing on screen that is
/// still happening — is blue, and every other label is secondary.
struct SegmentRow: View {
    let segment: TranscriptSegment
    /// This is the turn being spoken right now.
    var isCurrent: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(verbatim: TranscriptClipboard.liveLabel(for: segment))
                    .font(.parley.footnote.weight(.semibold))
                    .foregroundStyle(isCurrent ? Theme.primary : Color(.secondaryLabel))
                Text(verbatim: TranscriptClipboard.clock(segment.startMs))
                    .font(.parley.caption2.monospacedDigit())
                    .foregroundStyle(Color(.tertiaryLabel))
            }
            // Selection is enabled on the tentative tail too. A phrase is worth
            // grabbing the second it appears, and waiting for the provider to
            // finalise the utterance is not a distinction the person holding
            // the phone can see.
            //
            // Tertiary rather than italic-and-muted: the tail is text that has
            // not settled, and stepping it back one level of the ink hierarchy
            // says that without leaning on a slant the CJK faces don't have.
            Text(verbatim: segment.text)
                .font(.parley.body)
                .foregroundStyle(segment.isFinal ? Color(.label) : Color(.tertiaryLabel))
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // The whole turn, header included: the speaker and the clock are on
        // screen now, so a copy that dropped them would carry less than what was
        // pointed at. Selection alone cannot reach them — they are separate
        // `Text` views — which is what the row-level copy is for.
        .contextMenu {
            Button("Copy", systemImage: "doc.on.doc") {
                TranscriptClipboard.write(
                    TranscriptClipboard.plainText(
                        segment, label: TranscriptClipboard.liveLabel(for: segment)))
            }
            .disabled(segment.text.isEmpty)
        }
    }
}

#if DEBUG
    // A bare `AppState()` reads the keychain and nothing else, so the previews
    // land on the signed-out empty state — which is the one worth eyeballing
    // here. `SegmentRow` gets its own preview below because seeding a live
    // transcript needs the demo fixtures the app only serves under the
    // `-ParleyDemo` launch argument.
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
            VStack(alignment: .leading, spacing: 20) {
                ForEach(0..<7) { speaker in
                    SegmentRow(
                        segment: TranscriptSegment(
                            id: "s\(speaker)", source: "mix", speaker: speaker,
                            text: "Speaker \(speaker) says something worth reading back.",
                            isFinal: speaker != 6, startMs: UInt64(speaker) * 12_000,
                            endMs: UInt64(speaker) * 12_000 + 1_000),
                        isCurrent: speaker == 6)
                }
            }
            .padding(20)
        }
        .background(Theme.background)
    }
#endif
