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
    /// The meeting the `mic_recovery` prompt is about, when it is up. Latched
    /// on the meeting ending — see `MeetingRecorder.micRecoveries` — and
    /// cleared by the next meeting, a send, or ✕.
    @State private var micPrompt: MeetingRecorder.FinishedMeeting?
    @State private var showDiscardConfirm = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// How far open the controls panel is while recording, 0 (one row) to 1
    /// (everything). A fraction rather than points so the choice survives a
    /// Dynamic Type change or a status line that wraps, both of which move
    /// the panel's full height; persisted so the next meeting — and the next
    /// launch — opens the panel the way this person last left it.
    @AppStorage(Self.controlsFractionKey) private var controlsFraction: Double = 1
    /// The panel's height while a finger is on it, and where that drag began.
    /// Nil at rest, when the height is `controlsFraction`'s. Kept apart from
    /// the stored fraction so a drag writes to `UserDefaults` once, on
    /// release, rather than sixty times a second.
    @State private var dragHeight: Double?
    @State private var dragStart: Double?
    /// The natural heights of the panel's pieces, read off a hidden copy of
    /// them (`metricsProbe`). Seeded with the default text size's values so
    /// the first frame is already about right.
    @State private var measured = LiveControlsLayout.Metrics(
        statusRow: 18, timer: 41, waveform: 28, statusLine: 16)

    static let controlsFractionKey = "liveControlsFraction"

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                transcript
                // Above the controls, not in the transcript: it is about the
                // recording that just ended, and it must not scroll away with
                // the words.
                if let micPrompt {
                    FeedbackPromptCard(
                        trigger: .micRecovery,
                        recordingId: micPrompt.id,
                        text: Text(
                            "The microphone dropped \(micPrompt.micRecoveries) times during this recording."),
                        send: {
                            self.micPrompt = nil
                            sendMicReport(micPrompt)
                        },
                        close: { withAnimation { self.micPrompt = nil } })
                    .padding(.horizontal, 20)
                    .padding(.vertical, 8)
                }
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
            // `parley://record`, from the lock screen. `.onAppear` covers the
            // cold launch, where the note was left before this view existed;
            // `.onReceive` covers a warm one, where it already does.
            .onAppear { takeQuickRecord() }
            .onReceive(QuickRecordInbox.shared.$requestedAt) { if $0 != nil { takeQuickRecord() } }
            // The microphone is not coming back. End the meeting rather than
            // leave a recording on screen that records nothing — the audio up
            // to the failure is on disk and worth keeping.
            .onChange(of: recorder.lostMicrophone) {
                if recorder.lostMicrophone { Task { await recorder.stop(app: app) } }
            }
            // `mic_recovery`: asked once, as the meeting it is about ends.
            .onChange(of: recorder.finished?.id) {
                guard let finished = recorder.finished else {
                    micPrompt = nil
                    return
                }
                guard FeedbackConditions.isMicRecoveryWorthAsking(finished.micRecoveries),
                    FeedbackCenter.shared.mayOffer(.micRecovery, recordingId: finished.id)
                else { return }
                withAnimation { micPrompt = finished }
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

    private func sendMicReport(_ meeting: MeetingRecorder.FinishedMeeting) {
        let context = FeedbackDiagnostics.Context(
            recordingId: meeting.id, recordingDurationMs: Int(meeting.durationMs),
            transcriptSegments: meeting.transcriptSegments,
            lastSegmentEndMs: Int(meeting.lastSegmentEndMs),
            micRecoveries: meeting.micRecoveries)
        Task {
            await FeedbackCenter.shared.send(
                .micRecovery, recordingId: meeting.id, context: context)
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
            // Resizing the panel resizes this scroll view from the bottom, and
            // a scroll view keeps its top still — so without this, pulling the
            // panel down would uncover older lines while the newest one, the
            // one being read, slid out of view under the finger. Unanimated:
            // it tracks the drag frame by frame.
            .onChange(of: panelHeight) {
                if recorder.isRecording, let last = recorder.segments.last {
                    proxy.scrollTo(last.id, anchor: .bottom)
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
            recordingStatusRow
        }
    }

    /// The row itself, unconditionally — `metricsProbe` measures it before
    /// any meeting has started, so the panel knows its full height the moment
    /// one does.
    private var recordingStatusRow: some View {
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

    /// The transcription is paused or over. That is the one fact on this
    /// panel that must survive any amount of shrinking: a person who has
    /// collapsed the controls to read more is exactly the person who would
    /// otherwise not notice the words had stopped arriving.
    private var healthNeedsAttention: Bool {
        switch recorder.transcription {
        case .reconnecting, .stopped: return true
        default: return false
        }
    }

    /// The status line's glyph on its own, for wherever the sentence no
    /// longer fits: beside the timer in a shortened column, and in the
    /// compact row. Same glyph, same colour as in `statusLine`, so it reads as
    /// the same warning at a smaller size. VoiceOver gets the whole sentence.
    @ViewBuilder
    private var healthBadge: some View {
        if healthNeedsAttention {
            Group {
                if recorder.transcription == .reconnecting {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(Theme.warning)
                } else {
                    Image(systemName: "bolt.horizontal.circle")
                        .font(.parley.subheadline)
                        .foregroundStyle(Color(.label))
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: recorder.status ?? ""))
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

    /// Idle, the column at its natural height, exactly as it has always been:
    /// there is nothing to read above it yet, so there is nothing to make room
    /// for. Recording, the same column inside a panel the user can shrink.
    /// The probe behind both keeps the panel's full height current either way.
    private var controls: some View {
        Group {
            if recorder.isRecording {
                resizablePanel
            } else {
                column(at: nil)
            }
        }
        .background(alignment: .top) { metricsProbe }
        // A meeting that ends mid-drag must not leave the next one starting
        // at wherever the finger happened to be.
        .onChange(of: recorder.isRecording) {
            dragHeight = nil
            dragStart = nil
        }
    }

    /// Everything below the transcript, top to bottom. `height` is the
    /// panel's height while recording, and nil at the natural size; below full
    /// height the pieces `LiveControlsLayout` says no longer fit drop out — in
    /// its order, Discard first — and the timer and the stop disc shrink with
    /// the panel instead of stepping.
    private func column(at height: Double?) -> some View {
        let layout = controlsLayout
        let shown = height.map { layout.visible(at: $0) } ?? Set(LiveControlsLayout.Element.allCases)
        let timerScale = height.map { layout.timerScale(at: $0) } ?? 1
        let stop = height.map { layout.stopDiameter(at: $0) } ?? 64
        return VStack(spacing: 14) {
            if shown.contains(.statusRow) {
                recordingStatus
            }
            HStack(spacing: 8) {
                timer(scale: timerScale)
                // The sentence is gone but the warning it carried is not.
                if !shown.contains(.statusLine) || recorder.status == nil {
                    healthBadge
                }
            }
            if shown.contains(.waveform) {
                WaveformView(level: recorder.micLevel, sample: recorder.micSample, isActive: recorder.isRecording)
            }
            if let status = recorder.status, shown.contains(.statusLine) {
                statusLine(status)
            }
            recordControl(diameter: stop)
            if recorder.isRecording && shown.contains(.discard) {
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
        // Pieces fade as they leave or return rather than blinking, even
        // mid-drag: the height tracks the finger, but a piece appearing is an
        // event, and a short fade is how it reads as one.
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: shown)
    }

    // MARK: - Resizable panel

    /// The free divider. While a meeting runs, the controls take about a
    /// third of the phone, and the transcript — the thing someone actually
    /// glances at mid-meeting — gets what is left. Dragging the panel's top
    /// edge down gives the transcript that room back, and the panel stays
    /// wherever it is let go: there are no detents, because the right amount
    /// of transcript depends on the meeting, not on the app.
    ///
    /// Any part of the panel that is not a button takes the drag, not only
    /// the grabber: a 36pt capsule is a hint, not a target, and a panel that
    /// only moves from a sliver at its edge is one people conclude does not
    /// move. The buttons keep their taps — the drag needs a few points of
    /// travel before it wins.
    ///
    /// Below the crossfade band the column hands over to `compactRow`, one
    /// line of the essentials. Both are the same controls; only one is ever
    /// hittable, so a tap never lands on a half-faded copy.
    private var resizablePanel: some View {
        let layout = controlsLayout
        let height = panelHeight
        let columnOpacity = layout.columnOpacity(at: height)
        let rowOpacity = layout.rowOpacity(at: height)
        return ZStack {
            if columnOpacity > 0 {
                column(at: height)
                    .opacity(columnOpacity)
                    .allowsHitTesting(columnOpacity >= 0.5)
                    .accessibilityHidden(columnOpacity < 0.5)
            }
            if rowOpacity > 0 {
                compactRow
                    .opacity(rowOpacity)
                    .allowsHitTesting(rowOpacity > 0.5)
                    .accessibilityHidden(rowOpacity <= 0.5)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .clipped()
        .overlay(alignment: .top) { grabber(layout) }
        .contentShape(Rectangle())
        .gesture(resizeDrag(layout))
    }

    /// The panel's height right now: under the finger while dragging, the
    /// remembered fraction otherwise.
    private var panelHeight: Double {
        dragHeight ?? controlsLayout.height(forFraction: controlsFraction)
    }

    /// The layout for the pieces as they are measured now. A status line that
    /// is not there takes no room, so the panel's full height does not keep a
    /// gap for a sentence that is not showing.
    private var controlsLayout: LiveControlsLayout {
        var metrics = measured
        if recorder.status == nil { metrics.statusLine = 0 }
        return LiveControlsLayout(metrics: metrics)
    }

    /// Global coordinates, because the panel's own top edge — the local
    /// origin — moves with the drag; measured locally, the translation would
    /// shrink as fast as the panel did.
    private func resizeDrag(_ layout: LiveControlsLayout) -> some Gesture {
        DragGesture(minimumDistance: 6, coordinateSpace: .global)
            .onChanged { value in
                let start = dragStart ?? layout.height(forFraction: controlsFraction)
                dragStart = start
                dragHeight = layout.dragged(from: start, translation: value.translation.height)
            }
            .onEnded { _ in
                let released = dragHeight ?? layout.height(forFraction: controlsFraction)
                settle(to: layout.fraction(forHeight: layout.settled(released)))
            }
    }

    /// Lands the panel on `fraction`: a spring from wherever the finger left
    /// it, or — with Reduce Motion — straight there.
    private func settle(to fraction: Double) {
        withAnimation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86)) {
            controlsFraction = fraction
            dragHeight = nil
            dragStart = nil
        }
    }

    /// The handle: the system's sheet grabber, so it needs no explaining. A
    /// tap on it opens a shortened panel fully and folds a full one to a row,
    /// for anyone who would rather not drag at all. Its target is 44pt tall
    /// even though the capsule is five, and it is the one element VoiceOver
    /// gets for the whole feature, adjusted by swiping up and down.
    private func grabber(_ layout: LiveControlsLayout) -> some View {
        Capsule()
            .fill(Color(.tertiaryLabel))
            .frame(width: 36, height: 5)
            .padding(.top, 7)
            .frame(width: 120, height: 44, alignment: .top)
            .contentShape(Rectangle())
            .onTapGesture { settle(to: layout.toggled(fraction: controlsFraction)) }
            .accessibilityElement()
            .accessibilityLabel(Text("Resize controls"))
            .accessibilityValue(grabberValue)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { settle(to: layout.toggled(fraction: controlsFraction)) }
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment:
                    settle(to: layout.stepped(fraction: controlsFraction, taller: true))
                case .decrement:
                    settle(to: layout.stepped(fraction: controlsFraction, taller: false))
                @unknown default:
                    break
                }
            }
    }

    private var grabberValue: Text {
        if controlsFraction >= 1 { return Text("Expanded") }
        if controlsFraction <= 0 { return Text("Compact") }
        return Text(controlsFraction, format: .percent.precision(.fractionLength(0)))
    }

    /// The panel folded to one line: that it is recording, for how long,
    /// whether it is hearing, and the way to stop — the column's four
    /// answers without its sentences. The waveform takes whatever width the
    /// others leave. Dynamic Type is capped here because the row's height is
    /// fixed; the full column, which grows with the text, is a drag away.
    private var compactRow: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(Theme.recording)
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)
            if let startedAt = recorder.startedAt {
                Text(startedAt, style: .timer)
                    .font(.parley.displayNumber(size: 22))
                    .foregroundStyle(Color(.label))
                    .lineLimit(1)
                    .fixedSize()
            }
            healthBadge
            WaveformView(level: recorder.micLevel, sample: recorder.micSample, isActive: recorder.isRecording)
                .padding(.horizontal, 4)
            recordControl(diameter: 44)
        }
        .padding(.horizontal, 20)
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
    }

    /// A hidden copy of the column's text-bearing pieces, measured so the
    /// panel's full height is the real one at this text size and with this
    /// status sentence — not a constant that was right for one of each. Hidden
    /// views still lay out, which is all a measurement needs; the waveform
    /// here is the idle one, a single static draw.
    private var metricsProbe: some View {
        VStack(spacing: 0) {
            recordingStatusRow
                .modifier(ProbeHeight(piece: .statusRow))
            Text(verbatim: "0:00")
                .font(.parley.displayNumber)
                .modifier(ProbeHeight(piece: .timer))
            WaveformView(level: 0, sample: 0, isActive: false)
                .modifier(ProbeHeight(piece: .waveform))
            if let status = recorder.status {
                statusLine(status)
                    .modifier(ProbeHeight(piece: .statusLine))
            }
        }
        .frame(maxWidth: .infinity)
        .background {
            GeometryReader { proxy in
                Color.clear.preference(key: ProbeHeight.Key.self, value: [.width: proxy.size.width])
            }
        }
        .padding(.horizontal, 20)
        .hidden()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onPreferenceChange(ProbeHeight.Key.self) { heights in
            // The probe passes through a layout at a sliver of the screen's
            // width on launch, where every sentence wraps to three or four
            // lines. Those heights are not a size this panel will ever be
            // drawn at, and SwiftUI was seen to deliver them *last* — once
            // with `onGeometryChange` and once with this preference — leaving
            // the panel's full height up to 100pt off for the session. So a
            // report only counts when it was made at a real column width;
            // until one is, the seeded defaults stand.
            guard let width = heights[.width], width >= 200 else { return }
            if let value = heights[.statusRow] { measured.statusRow = value }
            if let value = heights[.timer] { measured.timer = value }
            if let value = heights[.waveform] { measured.waveform = value }
            if let value = heights[.statusLine] { measured.statusLine = value }
        }
    }

    /// How long this has been running, in ink. `Text(_:style:.timer)` rather
    /// than a string this view refreshes: the system redraws the digits, so a
    /// ticking clock costs no published state. Tabular figures, so it doesn't
    /// shuffle its own digits sideways every second.
    ///
    /// `scale` shrinks it with the panel by setting the size, not by scaling
    /// the drawing, so the line box shrinks too and the room it gives up is
    /// real.
    @ViewBuilder
    private func timer(scale: Double) -> some View {
        let font = Font.parley.displayNumber(size: 34 * scale)
        if let startedAt = recorder.startedAt, recorder.isRecording {
            Text(startedAt, style: .timer)
                .font(font)
                .foregroundStyle(Color(.label))
        } else {
            Text(verbatim: "0:00")
                .font(font)
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
    ///
    /// `diameter` is 64 at rest and shrinks with the recording panel; the
    /// glyph inside keeps its proportion to the disc.
    private func recordControl(diameter: Double = 64) -> some View {
        Button(action: toggle) {
            ZStack {
                Circle()
                    .fill(recorder.isRecording ? Theme.recording : Theme.primary)
                    .frame(width: diameter, height: diameter)
                inner(scale: diameter / 64)
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
    private func inner(scale: Double) -> some View {
        if recorder.isBusy {
            ProgressView()
                .controlSize(.regular)
                .tint(.white)
        } else if recorder.isRecording {
            RoundedRectangle(cornerRadius: 4 * scale)
                .fill(.white)
                .frame(width: 18 * scale, height: 18 * scale)
        } else if app.hasAccount {
            Circle()
                .fill(.white)
                .frame(width: 22 * scale, height: 22 * scale)
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

    /// Start a recording for a lock-screen request, if there is a fresh one.
    /// Already recording, or wrapping one up, it only brings this screen
    /// forward: a second tap on the lock screen is someone checking that it is
    /// still going, not asking for it to stop. Signed out, the request is
    /// dropped rather than turned into a sign-in prompt the user did not ask
    /// for — the gate in `RootView` is already showing them one.
    private func takeQuickRecord() {
        guard QuickRecordInbox.shared.take() else { return }
        guard !recorder.isBusy, !recorder.isRecording, app.hasAccount else { return }
        Task { await recorder.start(token: KeychainStore.get(AppState.tokenKey)) }
    }

    private func toggle() {
        guard !recorder.isBusy else { return }
        if recorder.isRecording {
            Task { await recorder.stop(app: app) }
        } else if app.hasAccount {
            // No "has everyone agreed?" alert first: getting the room's
            // permission is the person holding the phone's call, as it is with
            // any other recorder, and asking every single time taught nothing
            // but a reflex tap.
            Task { await recorder.start(token: KeychainStore.get(AppState.tokenKey)) }
        } else {
            // The gate in RootView normally keeps this unreachable, but a
            // session can expire while the app is open and on this screen.
            app.signIn()
        }
    }
}

/// Reports one piece of `LiveView`'s hidden metrics probe: its natural height
/// at the width it is given, under a name the panel's layout knows. `width` is
/// the probe's own column width, reported alongside so a measurement taken
/// mid-launch at a sliver of the screen can be told apart and ignored.
private struct ProbeHeight: ViewModifier {
    enum Piece: Hashable {
        case statusRow, timer, waveform, statusLine, width
    }

    struct Key: PreferenceKey {
        static let defaultValue: [Piece: Double] = [:]
        static func reduce(value: inout [Piece: Double], nextValue: () -> [Piece: Double]) {
            value.merge(nextValue()) { $1 }
        }
    }

    let piece: Piece

    func body(content: Content) -> some View {
        content
            .fixedSize(horizontal: false, vertical: true)
            .background {
                GeometryReader { proxy in
                    Color.clear.preference(key: Key.self, value: [piece: proxy.size.height])
                }
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
