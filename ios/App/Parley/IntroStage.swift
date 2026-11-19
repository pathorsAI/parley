import ParleyKit
import SwiftUI

/// The welcome screen's demo: Parley in four steps — record, transcribe, file,
/// hand to AI. The desktop's `IntroStage` (`src/components/onboarding/
/// IntroStage.tsx`) beat for beat, same content and timing, drawn with the
/// phone app's own screens rather than the desktop window.
///
/// The four steps land first as a row and hold, then the demo walks through
/// them one at a time while the row tracks where it is, on a small phone
/// screen over the app's tab bar: the Record tab starts recording (status
/// line, running clock, waveform, the red stop), two transcript lines type
/// under their speakers; the Library shows the new recording's row, which
/// flies into its customer's folder chip; then the recording's page on its
/// summary face fills in action items and the brief while the MCP plug
/// lights. Only the current step's part is at full strength, so there is one
/// thing to look at.
/// It runs in eleven seconds and rests on its final frame, where Replay runs it
/// again; tapping a step plays it from that step, the ones before it already
/// done. Under Reduce Motion it shows the final frame and offers neither.
///
/// Driven by one `TimelineView` against `LapMotion.WelcomeSchedule` (ParleyKit,
/// tested), so every piece is a pure function of the time since the run began.
struct IntroStage: View {
    private struct Line {
        let speaker: String
        let isMe: Bool
        let text: String
        /// Where it was said, as the Record tab prints it: 0:12.
        let time: String
    }

    private let lines: [Line]
    private let folderName: String
    private let cardTitle: String
    private let points: [String]
    private let actions: [String]
    private let schedule: LapMotion.WelcomeSchedule

    /// When the current run began, shifted back when it starts from a step.
    @State private var start = Date()
    /// Whether this run began at the top, so the row lands step by step. A
    /// run from a step finds the row already there.
    @State private var fromOverview = true
    @State private var finished = false
    @Namespace private var flight
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private typealias Beat = LapMotion.WelcomeBeat
    private typealias Schedule = LapMotion.WelcomeSchedule

    /// The desktop's ease, `cubic-bezier(.2,.8,.2,1)`.
    private static func ease(_ duration: Double) -> Animation {
        .timingCurve(0.2, 0.8, 0.2, 1, duration: duration)
    }

    init() {
        let manifest = SampleRecordingStore.manifest(lang: SampleRecordingStore.preferredLang)
        let me = manifest?.speakers.me ?? ""
        let them = manifest?.speakers.them ?? ""
        let built: [Line] = (manifest?.segments.prefix(2) ?? []).map { segment in
            let isMe = segment.speaker == "me"
            let seconds = Int(segment.startMs / 1000)
            return Line(
                speaker: isMe ? me : them, isMe: isMe, text: segment.text,
                time: String(format: "%d:%02d", seconds / 60, seconds % 60))
        }
        lines = built
        folderName = manifest?.suggestion?.folders.first?.name ?? ""
        cardTitle = manifest?.suggestion?.title ?? ""
        points = (manifest?.findings.prefix(2) ?? []).map(\.title)
        actions = (manifest?.actionItems.prefix(2) ?? []).map(\.text)
        schedule = Schedule(lineLengths: built.map { $0.text.count })
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: finished || reduceMotion)) { context in
            let t = reduceMotion ? schedule.end : context.date.timeIntervalSince(start)
            let beat = schedule.beat(at: t)
            VStack(alignment: .leading, spacing: 16) {
                stepRow(at: t, beat: beat)
                phone(at: t, beat: beat)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(Text("How Parley works"))
                footer(beat: beat)
            }
            .onChange(of: t >= schedule.end) { _, done in
                if done { finished = true }
            }
        }
    }

    /// Runs the demo again from `beat`: `overview` is the top, a step plays
    /// from that step with the ones before it already done.
    private func play(from beat: Beat) {
        start = Date().addingTimeInterval(-Schedule.start(of: beat))
        fromOverview = beat == .overview
        finished = false
    }

    /// 0…1 over `duration` from `at`, eased; the CSS keyframe animations
    /// (`ob-rise`, `ob-scale-in`, `ob-fade-in`) as functions of time.
    private func progress(_ t: TimeInterval, from at: TimeInterval, over duration: TimeInterval) -> Double {
        let x = min(1, max(0, (t - at) / duration))
        // cubic-bezier(.2,.8,.2,1) is close to an ease-out cubic.
        return 1 - pow(1 - x, 3)
    }

    /// Parts already shown step back while another step plays; at rest
    /// everything is back to full.
    private func dim(_ part: Beat, _ beat: Beat) -> Double {
        beat != .ready && beat != part && beat > part ? 0.4 : 1
    }

    // MARK: the step row

    /// The four steps as a row, each a label over a bar: upcoming (muted),
    /// current (blue, its bar filling over the step), done (checked, full).
    /// Every column is as tall as the tallest label and keeps its bar at the
    /// bottom, so a label that wraps does not push its bar below the others.
    private func stepRow(at t: TimeInterval, beat: Beat) -> some View {
        let labels: [LocalizedStringKey] = ["Record", "Live transcript", "File", "AI summary"]
        return HStack(alignment: .top, spacing: 8) {
            ForEach(Array(Beat.steps.enumerated()), id: \.offset) { i, step in
                let state: StepState = beat == step ? .current : (beat > step ? .done : .upcoming)
                let rise =
                    fromOverview && !reduceMotion
                    ? progress(t, from: Schedule.overviewLanding(i), over: 0.4) : 1
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .top, spacing: 5) {
                        ZStack {
                            Circle().fill(state == .upcoming ? Color(.systemGray5) : Theme.primary)
                            if state == .done {
                                Image(systemName: "checkmark")
                                    .font(.system(size: 7, weight: .bold))
                                    .foregroundStyle(.white)
                            } else {
                                Text(verbatim: "\(i + 1)")
                                    .font(.system(size: 9, weight: .semibold).monospacedDigit())
                                    .foregroundStyle(state == .upcoming ? Color(.secondaryLabel) : .white)
                            }
                        }
                        .frame(width: 15, height: 15)
                        Text(labels[i])
                            .font(.parley.caption.weight(.medium))
                            .foregroundStyle(state.ink)
                            .lineLimit(2)
                            .minimumScaleFactor(0.8)
                    }
                    Spacer(minLength: 0)
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color(.systemGray5))
                            Capsule().fill(Theme.primary)
                                .frame(width: geo.size.width * (state == .upcoming ? 0 : schedule.fill(step, at: t)))
                        }
                    }
                    .frame(height: 4)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .onTapGesture { if !reduceMotion { play(from: step) } }
                .opacity(rise)
                .offset(y: 6 * (1 - rise))
                .animation(Self.ease(0.5), value: state)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isButton)
                .accessibilityHint(Text("Play from this step"))
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private enum StepState {
        case upcoming, current, done

        var ink: Color {
            switch self {
            case .upcoming: return Color(.secondaryLabel)
            case .current: return Theme.primary
            case .done: return Color(.label)
            }
        }
    }

    // MARK: the phone

    /// Which of the app's own screens the demo is on: the Record tab while a
    /// meeting is recorded and transcribed, the Library while it is filed, the
    /// recording's page once it is over.
    private enum Screen { case record, library, detail }

    private func screen(for beat: Beat) -> Screen {
        switch beat {
        case .overview, .record, .transcript: return .record
        case .folder: return .library
        case .mcp, .ready: return .detail
        }
    }

    /// A small phone screen: the current page over the floating tab bar.
    private func phone(at t: TimeInterval, beat: Beat) -> some View {
        let screen = screen(for: beat)
        return ZStack(alignment: .bottom) {
            Group {
                switch screen {
                case .record: recordScreen(at: t, beat: beat)
                case .library: libraryScreen(at: t, beat: beat)
                case .detail: detailScreen(at: t)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .padding(.bottom, 52)
            .transition(.opacity)
            .id(screen)
            tabBar(selected: screen == .record ? 0 : 1)
                .padding(.bottom, 8)
        }
        .frame(height: 320)
        .background(Theme.background)
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(Color(.separator), lineWidth: 0.5)
        )
        .animation(Self.ease(0.4), value: screen)
    }

    /// The app's floating tab bar: Record, Library, Settings.
    private func tabBar(selected: Int) -> some View {
        let tabs: [(String, LocalizedStringKey)] = [
            ("record.circle", "Record"), ("rectangle.stack", "Library"), ("gearshape", "Settings"),
        ]
        return HStack(spacing: 2) {
            ForEach(Array(tabs.enumerated()), id: \.offset) { i, tab in
                VStack(spacing: 1) {
                    Image(systemName: tab.0)
                        .font(.system(size: 13))
                    Text(tab.1)
                        .font(.system(size: 8, weight: .medium))
                }
                .foregroundStyle(i == selected ? Theme.primary : Color(.label))
                .frame(width: 58, height: 36)
                .background(Capsule().fill(i == selected ? Color(.systemGray5) : .clear))
            }
        }
        .padding(3)
        .background(Capsule().fill(Color(.secondarySystemBackground)))
        .overlay(Capsule().stroke(Color(.separator).opacity(0.5), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.06), radius: 6, y: 2)
        .animation(Self.ease(0.4), value: selected)
    }

    // MARK: Record tab

    /// The Record tab: the transcript fills the top while the panel at the
    /// bottom holds the status line, the clock, the waveform and the button.
    private func recordScreen(at t: TimeInterval, beat: Beat) -> some View {
        VStack(spacing: 0) {
            transcript(at: t)
                .opacity(dim(.transcript, beat))
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            recordPanel(at: t, beat: beat)
                .opacity(dim(.record, beat))
        }
    }

    /// Two transcript lines typing in, under "speaker · time" as the Record tab
    /// shows them; each speaker is named once its line is in — the order a
    /// live transcript resolves it.
    private func transcript(at t: TimeInterval) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                let shown = schedule.typedCount(line: index, at: t)
                if shown > 0 {
                    let done = schedule.lineDone(index, at: t)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 5) {
                            Text(verbatim: line.speaker)
                                .foregroundStyle(line.isMe ? Theme.primary : Color(.secondaryLabel))
                            Text(verbatim: line.time)
                                .foregroundStyle(Color(.tertiaryLabel))
                        }
                        .font(.system(size: 10, weight: .medium).monospacedDigit())
                        .opacity(done ? 1 : 0)
                        .animation(Self.ease(0.4), value: done)
                        Text(verbatim: LapMotion.typed(line.text, count: shown))
                            .font(.system(size: 13))
                            .foregroundStyle(Color(.label))
                            .lineLimit(2)
                            .lineSpacing(1)
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 16)
    }

    /// The Record tab's panel. Idle it is the clock at zero over the blue
    /// record button; recording it gains the status line, the clock runs, the
    /// waveform moves, and the button turns into the red stop.
    private func recordPanel(at t: TimeInterval, beat: Beat) -> some View {
        let recording = beat >= .record
        let since = max(0, t - Schedule.start(of: .record))
        let landing = recording ? progress(t, from: Schedule.start(of: .record), over: 0.5) : 0
        // `ob-blink`: 0.7 s each way between full and a quarter.
        let phase = since.truncatingRemainder(dividingBy: 1.4) / 0.7
        let blink = phase <= 1 ? 1 - 0.75 * phase : 0.25 + 0.75 * (phase - 1)
        let seconds = recording ? Int(since) : 0
        return VStack(spacing: 6) {
            Capsule().fill(Color(.systemGray4)).frame(width: 28, height: 3)
            HStack(spacing: 5) {
                Circle().fill(Theme.recording).frame(width: 6, height: 6).opacity(blink)
                Text("Recording · live transcript")
                    .font(.system(size: 10))
                    .foregroundStyle(Color(.secondaryLabel))
            }
            .opacity(landing)
            Text(verbatim: String(format: "%d:%02d", seconds / 60, seconds % 60))
                .font(.system(size: 22, weight: .semibold).monospacedDigit())
                .foregroundStyle(recording ? Color(.label) : Color(.tertiaryLabel))
            waveform(at: t, live: recording)
            ZStack {
                Circle()
                    .fill(recording ? Theme.recording : Theme.primary)
                    .frame(width: 34, height: 34)
                if recording {
                    RoundedRectangle(cornerRadius: 2).fill(.white).frame(width: 11, height: 11)
                } else {
                    Circle().fill(.white).frame(width: 12, height: 12)
                }
            }
            .scaleEffect(recording ? 0.85 + 0.15 * landing : 1)
        }
        .padding(.top, 6)
        .padding(.bottom, 4)
        .frame(maxWidth: .infinity)
        .overlay(alignment: .top) { Divider() }
    }

    /// The panel's waveform: flat while idle, moving while recording.
    private func waveform(at t: TimeInterval, live: Bool) -> some View {
        HStack(alignment: .center, spacing: 2) {
            ForEach(0..<36, id: \.self) { i in
                let wobble = abs(sin(t * 5.3 + Double(i) * 0.9) * cos(t * 2.1 + Double(i) * 0.37))
                let height: CGFloat = live && i >= 18 ? 2 + 14 * wobble : 2
                Capsule()
                    .fill(live && i >= 18 ? Theme.primary : Color(.systemGray4))
                    .frame(width: 2, height: height)
            }
        }
        .frame(height: 16)
    }

    // MARK: Library tab

    /// The Library tab mid-filing: the folder chips over the list, the new
    /// recording's row on top of it, which then flies into its customer's
    /// chip — the chip lit for the step, flashing as the row lands.
    private func libraryScreen(at t: TimeInterval, beat: Beat) -> some View {
        let card = schedule.card(at: t)
        let flashing = schedule.folderFlashing(at: t)
        return VStack(alignment: .leading, spacing: 10) {
            Text("Library")
                .font(.system(size: 20, weight: .bold))
                .foregroundStyle(Color(.label))
            HStack(spacing: 12) {
                libraryChip(Text("All"), selected: true)
                libraryChip(Text("Unfiled"), selected: false)
                libraryChip(Text(verbatim: folderName), selected: false, lit: true, flashing: flashing)
                    .overlay {
                        // The row in flight lands here, shrinking and fading
                        // as it goes, then is gone.
                        if card == .flying {
                            libraryRow
                                .matchedGeometryEffect(id: "row", in: flight)
                                .scaleEffect(0.25)
                                .opacity(0.15)
                        }
                    }
            }
            ZStack(alignment: .top) {
                VStack(spacing: 0) {
                    placeholderRow
                    placeholderRow
                }
                if card == .shown {
                    libraryRow
                        .matchedGeometryEffect(id: "row", in: flight)
                        .transition(.scale(scale: 0.85).combined(with: .opacity))
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 16)
        .animation(Self.ease(Schedule.cardFly), value: card)
        .animation(Self.ease(0.5), value: flashing)
    }

    private func libraryChip(_ label: Text, selected: Bool, lit: Bool = false, flashing: Bool = false) -> some View {
        VStack(spacing: 4) {
            HStack(spacing: 3) {
                if lit {
                    Image(systemName: "folder")
                        .font(.system(size: 9))
                }
                label
                    .font(.system(size: 11, weight: selected || lit ? .semibold : .regular))
                    .lineLimit(1)
            }
            .foregroundStyle(selected || lit ? Theme.primary : Color(.secondaryLabel))
            .padding(.horizontal, lit ? 6 : 0)
            .padding(.vertical, lit ? 3 : 0)
            .background(
                Capsule().fill(Theme.primary.opacity(lit ? (flashing ? 0.22 : 0.1) : 0))
            )
            Rectangle()
                .fill(selected ? Theme.primary : Color.clear)
                .frame(height: 1)
        }
        .fixedSize()
    }

    /// The new recording as the library lists it: LIVE, its title, a line.
    private var libraryRow: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 5) {
                Text("LIVE")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Theme.recording)
                Text(verbatim: cardTitle)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color(.label))
                    .lineLimit(1)
            }
            Text(verbatim: points.first ?? "")
                .font(.system(size: 10))
                .foregroundStyle(Color(.secondaryLabel))
                .lineLimit(1)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.background, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color(.separator), lineWidth: 0.5)
        )
        .shadow(color: .black.opacity(0.08), radius: 4, y: 2)
    }

    /// The rest of the list, as grey bars: there, but not what to look at.
    private var placeholderRow: some View {
        VStack(alignment: .leading, spacing: 5) {
            Capsule().fill(Color(.systemGray5)).frame(width: 150, height: 7)
            Capsule().fill(Color(.systemGray6)).frame(width: 210, height: 6)
        }
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) { Divider() }
    }

    // MARK: the recording's page

    /// The meeting over: its page, filed under the customer, on the summary
    /// face — action items, then the brief — with the MCP plug in the corner
    /// lighting up as the record is handed to Claude or ChatGPT.
    private func detailScreen(at t: TimeInterval) -> some View {
        let total = actions.count + points.count
        let shown = schedule.reportLines(total, at: t)
        return VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color(.label))
                Text(verbatim: cardTitle)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color(.label))
                    .lineLimit(1)
                Spacer(minLength: 4)
                mcpPlug(lit: schedule.plugLit(at: t))
            }
            HStack(spacing: 3) {
                Image(systemName: "folder").font(.system(size: 9))
                Text(verbatim: folderName).font(.system(size: 10, weight: .medium))
                Image(systemName: "chevron.down").font(.system(size: 7, weight: .semibold))
            }
            .foregroundStyle(Theme.primary)
            HStack(spacing: 0) {
                Text("Summary")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Color(.label))
                    .frame(maxWidth: .infinity, minHeight: 22)
                    .background(Capsule().fill(Theme.background))
                Text("Transcript")
                    .font(.system(size: 10))
                    .foregroundStyle(Color(.secondaryLabel))
                    .frame(maxWidth: .infinity, minHeight: 22)
            }
            .padding(2)
            .background(Capsule().fill(Color(.systemGray6)))
            reportSection("Action items", rows: actions, offset: 0, shown: shown, at: t, action: true)
            reportSection("Brief", rows: points, offset: actions.count, shown: shown, at: t, action: false)
        }
        .padding(.horizontal, 14)
        .padding(.top, 14)
    }

    /// The MCP plug: greyed until the hand-off, then lit.
    private func mcpPlug(lit: Bool) -> some View {
        Image(systemName: "powerplug")
            .font(.system(size: 11))
            .foregroundStyle(lit ? Theme.primary : Color(.tertiaryLabel))
            .frame(width: 26, height: 26)
            .background(Circle().fill(lit ? Theme.primary.opacity(0.1) : Color(.systemGray6)))
            .overlay(Circle().stroke(Theme.primary.opacity(lit ? 0.25 : 0), lineWidth: 2))
            .animation(Self.ease(0.5), value: lit)
    }

    private func reportSection(
        _ title: LocalizedStringKey, rows: [String], offset: Int, shown: Int, at t: TimeInterval, action: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Color(.secondaryLabel))
            ForEach(Array(rows.enumerated()), id: \.offset) { i, text in
                if offset + i < shown {
                    let rise = progress(t, from: schedule.reportLineStart(offset + i), over: 0.4)
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        if action {
                            Image(systemName: "circle")
                                .font(.system(size: 10))
                                .foregroundStyle(Color(.tertiaryLabel))
                        } else {
                            Rectangle()
                                .fill(Color(.label))
                                .frame(width: 2, height: 11)
                                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
                        }
                        Text(verbatim: text)
                            .font(.system(size: 12, weight: action ? .regular : .medium))
                            .foregroundStyle(Color(.label))
                            .lineLimit(1)
                    }
                    .opacity(rise)
                    .offset(y: 6 * (1 - rise))
                }
            }
        }
    }

    // MARK: the caption

    /// One line naming the beat, and Replay at rest.
    private func footer(beat: Beat) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(caption(beat))
                .font(.parley.subheadline)
                .foregroundStyle(Color(.secondaryLabel))
                .fixedSize(horizontal: false, vertical: true)
                .id(beat)
                .transition(.opacity)
                .animation(Self.ease(0.4), value: beat)
                .accessibilityAddTraits(.updatesFrequently)
            Spacer(minLength: 0)
            if beat == .ready && !reduceMotion {
                Button {
                    play(from: .overview)
                } label: {
                    Label("Replay", systemImage: "arrow.counterclockwise")
                        .font(.parley.footnote.weight(.medium))
                        .foregroundStyle(Theme.primary)
                }
                .buttonStyle(.plain)
                .transition(.opacity)
            }
        }
        .frame(minHeight: 22)
        .animation(Self.ease(0.4), value: beat == .ready)
    }

    private func caption(_ beat: Beat) -> LocalizedStringKey {
        switch beat {
        case .overview: return "Four steps, from the meeting to your AI."
        case .record: return "Parley records both sides of the conversation."
        case .transcript: return "It transcribes live and labels who is speaking."
        case .folder: return "Afterwards, one customer, one folder."
        case .mcp: return "Then hand the record to Claude or ChatGPT to analyse."
        case .ready: return "Setup takes a minute."
        }
    }
}
