import AVFoundation
import ParleyKit
import SwiftUI

/// The live screen: record an in-person meeting, watch the diarized
/// transcript grow. Signed-in users stream through the hosted STT relay with
/// their session token — no API keys on the phone.
///
/// It has two layouts, one per question the screen is answering.
///
/// **Between meetings** it is the record button: the transcript of the last
/// meeting (or the empty state), then one column that says whether it is
/// recording, for how long, whether it hears anything, and how to start.
///
/// **During a meeting** — recording or paused, and while it finishes — it is
/// the desktop's meeting window (`src/components/live/MeetingFloatingWindow.tsx`)
/// laid out for a phone: the recording clock and the microphone along the top,
/// one warning strip at most, the meeting's name, date and folder, the
/// transcript in a tabbed panel, and Pause and End along the bottom. Same
/// pieces, same order, same quiet greys, so a person who uses both reads them
/// as one product. The only colour is meaning: the recording red, the blue of
/// what is live or tappable, and the warning amber.
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
    /// Where a meeting goes once its upload settles: its result page on the
    /// Library tab. See `TabRouter.openEndedMeeting`.
    @EnvironmentObject private var router: TabRouter
    /// The meeting the `mic_recovery` prompt is about, when it is up here.
    /// Only for a meeting whose upload did NOT settle — one that did is asked
    /// about on its result page instead (`RecordingDetailView`). Latched once
    /// the upload has an outcome, and cleared by the next meeting, a send, or
    /// ✕.
    @State private var micPrompt: MeetingRecorder.FinishedMeeting?
    @State private var showDiscardConfirm = false
    /// The folder picker for the meeting in progress.
    @State private var choosingFolder = false
    /// The user's personal folders, loaded when a meeting starts: the picker
    /// lists them, and the folder chip names the default destination with
    /// them before anything has been picked.
    @State private var folders: [CloudFolder] = []
    @FocusState private var titleFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    /// Whether the transcript keeps itself on the newest line. On until the
    /// reader drags it — someone scrolling up mid-meeting is re-reading
    /// something, and pulling them back down on every new turn is the one
    /// thing an auto-scrolling transcript must not do (the same rule
    /// `RecordingDetailView.followsAudio` keeps for playback). Back on from
    /// the "Latest" control, from scrolling back down to the end, and when
    /// the next meeting starts.
    @State private var followsLive = true
    /// How many turns there were when following stopped, so "Latest" only
    /// appears once there is something below the reader they have not seen.
    @State private var segmentsWhenLeft = 0
    /// The transcript's last line is in view (within a few points). Only ever
    /// written on iOS 18, which can report scroll geometry; on 17 it stays
    /// false and the way back is the "Latest" control alone.
    @State private var transcriptAtBottom = false

    var body: some View {
        NavigationStack {
            Group {
                if showsMeeting {
                    meetingScreen
                } else {
                    idleScreen
                }
            }
            .background(Theme.background)
            // No visible title: the tab bar already says Record, and a
            // wordmark over the transcript was one more thing to read on a page
            // whose job is to be quiet while somebody talks. `navigationTitle`
            // stays for what the system does with it (VoiceOver's rotor, Stage
            // Manager, screen-time reports); the empty principal item is what
            // keeps the bar from drawing it.
            .navigationTitle("Parley")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text(verbatim: "").accessibilityHidden(true)
                }
            }
            // During a meeting the header row is the top of the screen, as the
            // title bar is the top of the desktop's meeting window; an empty
            // navigation bar above it would only push the transcript down.
            .toolbar(.hidden, for: .navigationBar)
            // `parley://record`, from the lock screen. `.onAppear` covers the
            // cold launch, where the note was left before this view existed;
            // `.onReceive` covers a warm one, where it already does.
            .onAppear { takeQuickRecord() }
            .onReceive(QuickRecordInbox.shared.$requestedAt) { if $0 != nil { takeQuickRecord() } }
            // Coming back from Settings is the moment a refused microphone may
            // have been turned on; checking here is what takes the "Open
            // Settings" button down without asking for another tap on record.
            .onChange(of: scenePhase) {
                if scenePhase == .active { recorder.recheckMicrophonePermission() }
            }
            // The microphone is not coming back. End the meeting rather than
            // leave a recording on screen that records nothing — the audio up
            // to the failure is on disk and worth keeping.
            .onChange(of: recorder.lostMicrophone) {
                if recorder.lostMicrophone { Task { await recorder.stop(app: app) } }
            }
            // The next meeting starting (or the handoff below) clears the
            // meeting the prompt was about, and the prompt with it.
            .onChange(of: recorder.finished?.id) {
                if recorder.finished == nil { micPrompt = nil }
            }
            // `mic_recovery` on this screen: asked once the upload has an
            // outcome and it was not a settled one. Not on `finished` itself,
            // which is set before the upload is even tried: a prompt that went
            // up during "Uploading…" would be whisked away by the handoff a
            // second later, its one showing spent on nobody reading it.
            .onChange(of: recorder.isBusy) {
                guard !recorder.isBusy, recorder.settled == nil,
                    let finished = recorder.finished, finished.offersMicRecoveryPrompt
                else { return }
                withAnimation { micPrompt = finished }
            }
            // End, as on the desktop, ends on the recording's result page. Keyed
            // on the settled recording rather than on the meeting ending: the
            // page reads the recording from the cloud, so it cannot open before
            // the upload lands. Until then the disc keeps its "Wrapping up…"
            // spinner; an upload that never settles (background, quota,
            // offline, too short) stays here with its status line, as before.
            //
            // The recorder is cleared in the same beat, so coming back to
            // Record finds the screen for the next meeting rather than the
            // transcript of one that now has a page of its own. The filing
            // suggestion and the mic prompt travel with the handoff.
            .onChange(of: recorder.settled?.id) {
                guard let settled = recorder.settled else { return }
                router.openEndedMeeting(
                    EndedMeeting(settled: settled, finished: recorder.finished))
                micPrompt = nil
                recorder.clearEndedMeeting()
            }
            // A new meeting is a new transcript, and its folder chip needs the
            // folder names to say where the default sends it.
            .onChange(of: recorder.isInMeeting) {
                guard recorder.isInMeeting else { return }
                followsLive = true
                segmentsWhenLeft = 0
                Task { await loadFolders() }
            }
            .sheet(isPresented: $choosingFolder) { folderPicker }
            #if DEBUG
                .task {
                    ScreenshotDemo.seedRecordScreen(recorder)
                    if recorder.isInMeeting { await loadFolders() }
                }
            #endif
        }
    }

    /// The meeting layout stays up through `.finishing` — the relay draining
    /// its last sentence — so End can turn into its spinner where it was
    /// pressed, as the desktop's does, instead of the screen changing under
    /// the finger the moment it is tapped. The upload after that belongs to
    /// the record screen, which shows it on the disc.
    private var showsMeeting: Bool {
        recorder.isInMeeting || recorder.phase == .finishing
    }

    private var copyButton: some View {
        // Copying works mid-meeting on purpose: the reason to grab a line is
        // usually that it was just said.
        CopyTranscriptButton(
            text: {
                TranscriptClipboard.plainText(recorder.segments) {
                    TranscriptClipboard.liveLabel(for: $0)
                }
            },
            isEmpty: recorder.segments.isEmpty)
    }

    // MARK: - Between meetings

    /// The transcript of the meeting that just ended (or the empty state),
    /// what is left to say about it, and the record button.
    private var idleScreen: some View {
        VStack(spacing: 0) {
            // Before a meeting, the heading is the next one's: name it and
            // pick its folder now, and the recording starts under them. With
            // the last meeting's transcript still on screen — an upload that
            // did not settle, so no result page took it — the heading would
            // read as that meeting's, so the page keeps only the copy button
            // for it.
            if recorder.segments.isEmpty {
                meetingHeading
            } else {
                HStack {
                    Spacer()
                    copyButton
                        .font(.parley.body)
                        .tint(Color(.label).opacity(0.8))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .padding(.horizontal, 8)
            }
            transcriptPanel
            // Above the dock, not in the transcript: it is about the
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
                        micPrompt.sendMicRecoveryReport()
                    },
                    close: { withAnimation { self.micPrompt = nil } })
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
            }
            if dictation.window.isOpen() {
                micWindowBar
            }
            idleDock
        }
    }

    // MARK: - During a meeting

    /// The desktop's meeting window, reordered for a hand: what the meeting
    /// *is* on top — its name, day, folder and transcript — and everything
    /// you *do* in one dock along the bottom, under the thumb: the clock and
    /// the microphone, the waveform the record screen has always had, and
    /// discard, pause and end. The panel takes whatever height is left.
    private var meetingScreen: some View {
        VStack(spacing: 0) {
            warningStrip
            meetingHeading
            transcriptPanel
            controlDock
        }
        .confirmationDialog(
            "Cancel this meeting?", isPresented: $showDiscardConfirm, titleVisibility: .visible
        ) {
            Button("Discard meeting", role: .destructive) {
                Task { await recorder.discard() }
            }
            Button("Keep meeting", role: .cancel) {}
        } message: {
            Text(
                "The transcript and recording will be discarded — nothing is saved and no analysis runs. This cannot be undone."
            )
        }
    }

    // MARK: Control dock

    /// Everything the meeting is operated with, together at the bottom: the
    /// clock and the microphone on one line, the live waveform under them —
    /// *is it hearing me*, the question the record screen has always answered
    /// at a glance — and the three actions. Discard sits apart from End on the
    /// left, so the two ways out are never side by side under a thumb.
    private var controlDock: some View {
        VStack(spacing: 8) {
            HStack(spacing: 6) {
                clockPill
                Spacer(minLength: 8)
                micChip
            }
            WaveformView(level: recorder.micLevel, sample: recorder.micSample, isActive: isHearing)
                .frame(height: 30)
                .accessibilityHidden(true)
            HStack(spacing: 8) {
                discardButton
                pauseButton
                Spacer(minLength: 8)
                endButton
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 6)
        .overlay(alignment: .top) { hairline }
    }

    /// The recording clock: a pulsing red dot and the elapsed time on a grey
    /// capsule. Paused — by the user, or by a call holding the microphone —
    /// the dot goes grey and still, and 已暫停 follows the time. Red is the
    /// only colour a running meeting wears, so it is the only thing here that
    /// moves.
    private var clockPill: some View {
        let held = recorder.isPaused || recorder.heldBySystem
        return HStack(spacing: 8) {
            Image(systemName: "circle.fill")
                .font(.system(size: 8))
                .foregroundStyle(held ? Color(.tertiaryLabel) : Theme.recording)
                .symbolEffect(.pulse, options: .repeating, isActive: !held && !reduceMotion)
                .accessibilityHidden(true)
            if recorder.clock != nil {
                clockText(font: .parley.clock)
                    .lineLimit(1)
                    .fixedSize()
            }
            if held {
                Text("Paused")
                    .font(.parley.caption.weight(.medium))
                    .foregroundStyle(Color(.secondaryLabel))
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
        .background(Capsule().fill(Color(.tertiarySystemFill)))
        .accessibilityElement(children: .combine)
        // The pill sizes to the time in it, which can be long at the largest
        // text sizes; past these it would push the controls off the row.
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
    }

    /// The microphone, in the spirit of the desktop's `MicChip`: whether it
    /// hears anything (three bars that move with the level), whether the live
    /// transcript is in trouble (the same badge the record column used to
    /// carry), and — opened — which input is recording and the status line
    /// that used to sit under the transcript. The input is in the menu rather
    /// than on the chip: a phone's header has no room for a device name, and a
    /// truncated one says less than none.
    private var micChip: some View {
        Menu {
            Section(inputName) {
                if let status = recorder.status {
                    Text(verbatim: status)
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: recorder.heldBySystem ? "mic.slash.fill" : "mic.fill")
                    .font(.parley.footnote)
                    .foregroundStyle(Color(.label))
                if healthNeedsAttention {
                    healthBadge
                } else {
                    ChipMeter(level: isHearing ? recorder.micLevel : 0)
                }
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Color(.tertiaryLabel))
            }
            .padding(.horizontal, 10)
            .frame(height: 30)
            .overlay(Capsule().stroke(Color(.separator), lineWidth: 1))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("Microphone: \(inputName)"))
        .accessibilityValue(Text(verbatim: recorder.status ?? ""))
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    /// The input the meeting is recording from, as the system names it
    /// ("iPhone Microphone", a headset). Read on each draw rather than
    /// observed: the chip redraws with every level update anyway.
    private var inputName: String {
        AVAudioSession.sharedInstance().currentRoute.inputs.first?.portName
            ?? String(localized: "Microphone")
    }

    /// ✕, the desktop title bar's way out, in the dock: throw the meeting
    /// away, after the desktop's own confirmation. Grey, not red — the red
    /// belongs in the confirmation and on End's square.
    private var discardButton: some View {
        Button {
            titleFocused = false
            showDiscardConfirm = true
        } label: {
            Image(systemName: "xmark")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color(.secondaryLabel))
                .frame(width: 42, height: 42)
                .background(
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(Color(.tertiarySystemFill)))
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(recorder.isBusy || recorder.phase == .finishing)
        .accessibilityLabel(Text("Cancel meeting"))
    }

    private var hairline: some View {
        Rectangle()
            .fill(Color(.separator))
            .frame(height: 0.5)
    }

    // MARK: Warning strip

    /// One warning at a time, under the header, in the desktop's amber and its
    /// order (`LiveBanners`): the most urgent thing the meeting is not doing
    /// first. iOS has its own three — a call holding the microphone, a
    /// dropped transcription redialling, and live transcription given up —
    /// and no detector for the desktop's no-audio or long-silence strips, so
    /// those have no phone counterpart.
    @ViewBuilder
    private var warningStrip: some View {
        if let warning = currentWarning {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Group {
                    switch warning {
                    case .reconnecting:
                        ProgressView()
                            .controlSize(.mini)
                            .tint(Theme.warning)
                    case .micHeld:
                        Image(systemName: "mic.slash")
                    case .transcriptionStopped:
                        Image(systemName: "bolt.horizontal.circle")
                    }
                }
                .font(.parley.caption)
                .foregroundStyle(Theme.warning)
                .accessibilityHidden(true)
                warningText(warning)
                    .font(.parley.caption)
                    .foregroundStyle(Color(.label))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(Theme.warning.opacity(0.12))
            .overlay(alignment: .bottom) {
                Rectangle().fill(Theme.warning.opacity(0.35)).frame(height: 0.5)
            }
            .accessibilityElement(children: .combine)
            .transition(.opacity)
        }
    }

    private enum Warning {
        case micHeld, reconnecting, transcriptionStopped
    }

    /// Nothing is being recorded outranks the transcript pausing, which
    /// outranks the transcript having stopped for good — the recording, which
    /// is what the user keeps, is unaffected by the last two.
    private var currentWarning: Warning? {
        if recorder.heldBySystem { return .micHeld }
        switch recorder.transcription {
        case .reconnecting: return .reconnecting
        case .stopped where recorder.status != nil: return .transcriptionStopped
        default: return nil
        }
    }

    @ViewBuilder
    private func warningText(_ warning: Warning) -> some View {
        switch warning {
        case .micHeld:
            Text(
                "Recording paused while a call or another app uses the microphone. It picks up again on its own."
            )
        case .reconnecting:
            Text(
                "Transcription dropped — reconnecting… The recording is still running. What's said during a short drop catches up in the transcript; a longer gap is kept in the recording but won't appear in the live transcript."
            )
        case .transcriptionStopped:
            // Already localized by the recorder: which sentence depends on
            // why it gave up (quota, signed out, out of retries).
            Text(verbatim: recorder.status ?? "")
        }
    }

    // MARK: Heading

    /// The meeting's name, day and folder, as under the desktop's title bar.
    /// The name and the folder are the recording's: `MeetingRecorder` saves
    /// it under them when it ends.
    private var meetingHeading: some View {
        VStack(alignment: .leading, spacing: 4) {
            TextField(
                text: $recorder.meetingTitle,
                prompt: Text("Untitled meeting").foregroundStyle(Color(.tertiaryLabel))
            ) {
                Text("Meeting name")
            }
            .font(.parley.title2)
            .foregroundStyle(Color(.label))
            .submitLabel(.done)
            .focused($titleFocused)
            .onSubmit { titleFocused = false }
            // Room for the copy button, so a long name never runs under it.
            .padding(.trailing, 36)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .trailing) {
                copyButton
                    .font(.parley.body)
                    .tint(Color(.label).opacity(0.8))
                    .frame(width: 40, height: 44)
                    .contentShape(Rectangle())
                    .offset(x: 8)
            }
            HStack(spacing: 8) {
                dateChip
                folderChip
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
    }

    /// 2026/10/30 — the meeting's day, in the desktop's numeric form.
    private var dateChip: some View {
        let day = Calendar.current.dateComponents(
            [.year, .month, .day], from: recorder.startedAt ?? Date())
        let stamp = String(
            format: "%04d/%02d/%02d", day.year ?? 0, day.month ?? 0, day.day ?? 0)
        return HStack(spacing: 6) {
            Image(systemName: "calendar")
                .font(.parley.caption2)
                .accessibilityHidden(true)
            Text(verbatim: stamp)
                .font(.parley.caption)
                .lineLimit(1)
        }
        .foregroundStyle(Theme.primary)
        .padding(.horizontal, 8)
        .frame(minHeight: 26)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(Color(.quaternarySystemFill)))
        .fixedSize()
    }

    /// Where the recording will land: dashed with 放進資料夾 while nothing but
    /// the personal top level is set, solid with the place once there is one —
    /// picked here, or the app's default destination. Tapping it opens the
    /// same folder picker the filing card uses.
    private var folderChip: some View {
        let label = folderLabel
        let isOrg = (recorder.meetingFolder?.destination ?? app.defaultSave).isOrg
        return Button {
            titleFocused = false
            choosingFolder = true
        } label: {
            HStack(spacing: 6) {
                Image(systemName: isOrg ? "person.2" : "folder")
                    .font(.parley.caption2)
                    .accessibilityHidden(true)
                Text(verbatim: label ?? String(localized: "Add to folder"))
                    .font(.parley.caption)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .foregroundStyle(label == nil ? Color(.secondaryLabel) : Color(.label))
            .padding(.horizontal, 8)
            .frame(minHeight: 26)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(label == nil ? Color.clear : Color(.quaternarySystemFill)))
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(
                        Color(.separator),
                        style: StrokeStyle(lineWidth: 1, dash: label == nil ? [3, 2] : [])))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: label ?? String(localized: "Add to folder")))
        .accessibilityHint(Text("Choose a folder"))
    }

    /// The chip's words: the pick, else the default destination when it is
    /// somewhere other than the personal top level; nil for "nowhere chosen".
    private var folderLabel: String? {
        if let chosen = recorder.meetingFolder { return chosen.label }
        let fallback = app.defaultSave
        guard fallback.isOrg || fallback.folderId != nil else { return nil }
        if !fallback.isOrg, let id = fallback.folderId,
            let folder = folders.first(where: { $0.id == id })
        {
            return folder.name
        }
        return fallback.label(orgs: app.orgs, folders: folders)
    }

    /// The picker, for the meeting in progress. Its confirm is a choice, not a
    /// move — there is no recording yet to move — and the choice is saved
    /// into when the meeting ends. A new folder is created on confirm, since
    /// it is the one moment someone has said they want it; an organization
    /// gets a shared copy, as the app's default destination does.
    private var folderPicker: some View {
        let orgGroups: (() async -> [FolderGroup])? =
            app.orgs.isEmpty && !demoServesOrgs ? nil : { await FolderGroup.organizations(app: app) }
        return FolderPickerSheet(
            groups: [.personal(folders)],
            loadMoreGroups: orgGroups,
            current: (recorder.meetingFolder?.destination ?? app.defaultSave).folderDestination,
            canCreate: true,
            title: "Choose a folder",
            confirm: .choose,
            orgTransfer: .copy,
            onConfirm: { destination, label in
                var picked = destination
                var name = label
                if case .newFolder(let folderName) = destination {
                    let folder = try await app.cloud.createFolder(name: folderName)
                    folders.append(folder)
                    picked = .folder(id: folder.id, orgId: nil)
                    name = folder.name
                }
                guard let save = SaveDestination(picked) else { return }
                recorder.meetingFolder = .init(destination: save, label: name)
            })
    }

    private var demoServesOrgs: Bool {
        #if DEBUG
            return ScreenshotDemo.servesFixtures
        #else
            return false
        #endif
    }

    /// The personal folders, for the picker and the chip. Best-effort: an
    /// empty list still lets the user pick the top level or create one.
    private func loadFolders() async {
        #if DEBUG
            if ScreenshotDemo.servesFixtures {
                folders = ScreenshotDemo.folders
                return
            }
        #endif
        guard app.signedIn else { return }
        if let loaded = try? await app.cloud.listFolders() {
            folders = loaded.filter { $0.orgId == nil }
        }
    }

    // MARK: Panel

    /// The transcript on the desktop's muted, rounded panel. No tab strip and
    /// no label: while recording the phone shows the transcript and nothing
    /// else, so a lone 逐字稿 tab only named what is plainly there. When Notes
    /// or Coach come to the phone, the desktop's tabs come back above it.
    private var transcriptPanel: some View {
        transcript(inPanel: true)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color(.quaternarySystemFill)))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 12)
    }

    // MARK: Pause and End

    private var pauseButton: some View {
        let paused = recorder.isPaused
        return Button {
            if paused { recorder.resume() } else { recorder.pause() }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: paused ? "play.fill" : "pause.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .accessibilityHidden(true)
                Text(paused ? "Resume" : "Pause")
                    .font(.parley.subheadlineEmphasized)
            }
            .foregroundStyle(paused ? Theme.primary : Color(.secondaryLabel))
            .padding(.leading, 14)
            .padding(.trailing, 16)
            // Larger than the desktop's 32 px: on a phone these are the
            // meeting's two main controls, under a thumb.
            .frame(minHeight: 42)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(paused ? Theme.primary.opacity(0.12) : Color(.tertiarySystemFill)))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // Inert while the microphone is still opening — there is nothing to
        // pause yet — and once End has been pressed.
        .disabled(recorder.phase != .recording && !paused)
        .opacity(recorder.phase == .starting ? 0.5 : 1)
    }

    /// 結束: a small filled red square and the word, in the same grey as
    /// Pause. A spinner while the relay drains the last sentence.
    private var endButton: some View {
        let finishing = recorder.phase == .finishing
        return Button {
            titleFocused = false
            guard recorder.isInMeeting else { return }
            Task { await recorder.stop(app: app) }
        } label: {
            HStack(spacing: 7) {
                Group {
                    if finishing {
                        ProgressView().controlSize(.mini)
                    } else {
                        RoundedRectangle(cornerRadius: 2, style: .continuous)
                            .fill(Theme.recording)
                            .frame(width: 10, height: 10)
                    }
                }
                .frame(width: 14, height: 14)
                .accessibilityHidden(true)
                Text("End")
                    .font(.parley.subheadlineEmphasized)
            }
            .foregroundStyle(Color(.secondaryLabel))
            .padding(.leading, 14)
            .padding(.trailing, 16)
            // Larger than the desktop's 32 px: on a phone these are the
            // meeting's two main controls, under a thumb.
            .frame(minHeight: 42)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(Color(.tertiarySystemFill)))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!recorder.isInMeeting)
        .accessibilityLabel(finishing ? Text("Wrapping up…") : Text("End"))
    }

    // MARK: - Transcript

    /// One flowing column, like the desktop's transcript: no rows, no rules, no
    /// cards — a turn is separated from the next by whitespace and by its own
    /// speaker label, which is all a reader needs to see where one ends.
    /// `inPanel`: inside the meeting's tabbed panel, with its tighter gutter.
    private func transcript(inPanel: Bool) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    if recorder.segments.isEmpty {
                        if recorder.isInMeeting { listeningState } else { emptyState }
                    }
                    ForEach(recorder.segments, id: \.id) { seg in
                        SegmentRow(segment: seg, isCurrent: seg.id == currentSpeakingID)
                            .id(seg.id)
                    }
                }
                .padding(inPanel ? 16 : 20)
            }
            // A user pan stops following. `simultaneousGesture` so the scroll
            // view still scrolls — this only wants to know — and it never fires
            // for a `scrollTo`, which is the distinction that matters. A pan
            // that starts at the end does not count until it has left it, so
            // a nudge at the bottom, or the drag that brings the reader back
            // down, does not undo the resume below.
            .simultaneousGesture(
                DragGesture(minimumDistance: 8).onChanged { _ in
                    guard followsLive, !transcriptAtBottom else { return }
                    segmentsWhenLeft = recorder.segments.count
                    followsLive = false
                })
            .modifier(
                ReportsScrollBottom { atBottom in
                    guard atBottom != transcriptAtBottom else { return }
                    transcriptAtBottom = atBottom
                    // Scrolling back down to the newest line is asking to
                    // follow again; making the reader find a button for it
                    // would be a step they already took.
                    if atBottom { followsLive = true }
                })
            .onChange(of: recorder.segments.count) {
                guard followsLive, let last = recorder.segments.last else { return }
                withAnimation(reduceMotion ? nil : .default) {
                    proxy.scrollTo(last.id, anchor: .bottom)
                }
            }
            // The panel is laid out afresh when the meeting starts, and the
            // keyboard for the title shrinks it from the bottom; a scroll view
            // keeps its top still, so without this the line being read would
            // slide out of view. Only while following.
            .onAppear {
                if followsLive, let last = recorder.segments.last {
                    proxy.scrollTo(last.id, anchor: .bottom)
                }
            }
            .onChange(of: titleFocused) {
                if followsLive, let last = recorder.segments.last {
                    proxy.scrollTo(last.id, anchor: .bottom)
                }
            }
            // The fade is scoped to the overlay: on the scroll view it would
            // also animate the turn whose arrival brought the control up.
            .overlay(alignment: .bottom) {
                ZStack {
                    if showsLatest {
                        latestControl(proxy)
                            .padding(.bottom, 12)
                            .transition(.opacity)
                    }
                }
                .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: showsLatest)
            }
        }
    }

    /// The reader has scrolled away from the end and more has been said since.
    private var showsLatest: Bool {
        !followsLive && recorder.segments.count > segmentsWhenLeft
    }

    /// The way back to the newest line once the reader has scrolled away and
    /// more has been said. Blue because it is the one live, tappable thing on
    /// the transcript; on the page colour with a hairline, not a filled pill,
    /// so it reads as a control sitting over the words rather than a banner
    /// competing with them. Only there when there is something new to jump
    /// to — a reader who scrolled up in a quiet moment is not nagged.
    private func latestControl(_ proxy: ScrollViewProxy) -> some View {
        Button {
            followsLive = true
            guard let last = recorder.segments.last else { return }
            withAnimation(reduceMotion ? nil : .default) {
                proxy.scrollTo(last.id, anchor: .bottom)
            }
        } label: {
            Label("Latest", systemImage: "arrow.down")
                .font(.parley.footnote.weight(.semibold))
                .foregroundStyle(Theme.primary)
                .padding(.horizontal, 16)
                // 44pt so the target is the HIG minimum rather than the line
                // box, and `contentShape` so the whole capsule takes the tap.
                .frame(minHeight: 44)
                .background(Capsule().fill(Theme.background))
                .overlay(Capsule().stroke(Color(.separator), lineWidth: 1))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("Jump to latest"))
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

    /// The panel before the first words arrive, as the desktop's says it.
    private var listeningState: some View {
        Text("Listening…")
            .font(.parley.subheadline)
            .foregroundStyle(Color(.secondaryLabel))
            .frame(maxWidth: .infinity)
            .padding(.top, 48)
    }

    // MARK: - Status

    /// Chunks are reaching the file. Not while starting's microphone is still
    /// opening, which the level has always shown as live anyway, and not
    /// while paused, when they are dropped.
    private var isHearing: Bool {
        recorder.isInMeeting && !recorder.isPaused && !recorder.heldBySystem
    }

    /// The transcription is paused or over — the one fact about the live
    /// transcript worth a mark of its own, wherever there is room for one.
    private var healthNeedsAttention: Bool {
        switch recorder.transcription {
        case .reconnecting, .stopped: return true
        default: return false
        }
    }

    /// The status sentence's glyph on its own: on the microphone chip during a
    /// meeting, beside the timer between them when there is no sentence. Same
    /// glyph, same colour as in `statusLine`, so it reads as the same warning
    /// at a smaller size. VoiceOver gets the whole sentence.
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
                        .font(.parley.footnote)
                        .foregroundStyle(Color(.label))
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: recorder.status ?? ""))
        }
    }

    /// The one line under the transcript between meetings. Its *look* is the
    /// transcription's health, not just its words: a reconnect is a spinner in
    /// amber, because it is a pause the recording will come back from, while
    /// the sentence that says live transcription is over gets the icon and the
    /// weight of something the user may want to act on. Both are still only
    /// about the live transcript — the recording itself is unaffected either
    /// way.
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

    /// The one way out of a refused microphone. Plain blue text, because it
    /// is a link to somewhere else rather than a control on this screen, and
    /// a 44pt target so it is not the height of one caption line.
    private var openSettingsControl: some View {
        Button {
            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
        } label: {
            Text("Open Settings")
                .font(.parley.subheadlineEmphasized)
                .foregroundStyle(Theme.primary)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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

    // MARK: - Record controls

    /// Everything below the transcript between meetings, top to bottom: how
    /// long (nothing yet), whether it hears anything (nothing yet), what
    /// happened to the last one, and the button.
    /// The meeting's dock before the meeting: the same three lines in the
    /// same places — clock and microphone, the waveform, the actions — so
    /// pressing record changes what is in the dock, not where anything is.
    /// The clock reads 0:00 behind a still grey dot and the waveform lies
    /// flat; the actions are one button, Start recording.
    private var idleDock: some View {
        VStack(spacing: 8) {
            HStack(spacing: 6) {
                idleClockPill
                Spacer(minLength: 8)
                micChip
            }
            WaveformView(level: recorder.micLevel, sample: recorder.micSample, isActive: false)
                .frame(height: 30)
                .accessibilityHidden(true)
            if let status = recorder.status {
                statusLine(status)
            }
            // Only while the refusal stands: asking again cannot help once
            // someone has said no, because iOS never shows the prompt twice.
            if recorder.micDenied {
                openSettingsControl
            }
            if !app.hasAccount {
                Text("Your session expired. Sign in with the button above and recording works again.")
                    .font(.parley.caption)
                    .foregroundStyle(Color(.secondaryLabel))
                    .multilineTextAlignment(.center)
            }
            recordControl
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 6)
        .overlay(alignment: .top) { hairline }
    }

    /// The clock pill at rest: a still grey dot and 0:00, where the running
    /// meeting's red dot and time will be.
    private var idleClockPill: some View {
        HStack(spacing: 8) {
            Image(systemName: "circle.fill")
                .font(.system(size: 8))
                .foregroundStyle(Color(.tertiaryLabel))
            Text(verbatim: "0:00")
                .font(.parley.clock)
                .foregroundStyle(Color(.secondaryLabel))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
        .background(Capsule().fill(Color(.tertiarySystemFill)))
        .accessibilityHidden(true)
    }

    /// How long this has been running, in ink. `Text(_:style:.timer)` rather
    /// than a string this view refreshes: the system redraws the digits, so a
    /// ticking clock costs no published state. Tabular figures, so it doesn't
    /// shuffle its own digits sideways every second.
    ///
    /// Paused, the digits stand still, in secondary ink so a glance tells the
    /// two apart, and written the way the running timer writes them so they do
    /// not change shape on the tap.
    @ViewBuilder
    private func clockText(font: Font) -> some View {
        if let anchor = recorder.clock?.timerAnchor {
            Text(anchor, style: .timer)
                .font(font)
                .foregroundStyle(Color(.label))
        } else if let clock = recorder.clock {
            Text(verbatim: RecordingClock.timerText(clock.elapsed(at: Date())))
                .font(font)
                .foregroundStyle(Color(.secondaryLabel))
        }
    }

    /// The record button: the universal record glyph, a blue disc with a
    /// white circle inside. There is nothing to read, because there is
    /// nothing to decide. Stopping lives on the meeting screen's End.
    ///
    /// The button is never disabled. Before this, a signed-out launch put a
    /// permanently greyed-out control on screen with no way to act on it — the
    /// bug App Review reported. A button that can't be pressed teaches nothing;
    /// one that opens sign-in does. It *is* inert while the last meeting is
    /// uploading, where there is no action left to take.
    private var recordControl: some View {
        Button(action: toggle) {
            HStack(spacing: 8) {
                inner
                Text(recordLabel)
                    .font(.parley.subheadlineEmphasized)
            }
            // The desktop's light-primary button (its Resume): blue ink on a
            // faint blue wash. A solid blue bar was the loudest thing on a
            // screen that is waiting, not asking.
            .foregroundStyle(Theme.primary)
            .frame(maxWidth: .infinity, minHeight: 42)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(Theme.primary.opacity(0.12)))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(recorder.isBusy ? 0.6 : 1)
        .accessibilityLabel(accessibilityLabel)
    }

    private var recordLabel: LocalizedStringKey {
        if recorder.isBusy { return "Wrapping up…" }
        return app.hasAccount ? "Start recording" : "Sign in again to record"
    }

    /// The glyph before Start recording, in the button's blue ink: a dot
    /// (the record mark), a spinner while the last meeting is still being
    /// saved, or the account glyph when the press opens sign-in.
    @ViewBuilder
    private var inner: some View {
        if recorder.isBusy {
            ProgressView()
                .controlSize(.small)
                .tint(Theme.primary)
        } else if app.hasAccount {
            Circle()
                .fill(Theme.primary)
                .frame(width: 10, height: 10)
        } else {
            // Signed out, the press opens sign-in rather than the microphone, so
            // the glyph says so — the sentence under the control carries the
            // rest.
            Image(systemName: "person.crop.circle")
                .font(.system(size: 15, weight: .regular))
                .foregroundStyle(Theme.primary)
        }
    }

    private var accessibilityLabel: Text {
        if recorder.isBusy { return Text("Wrapping up…") }
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
        guard !recorder.isBusy, !recorder.isInMeeting, app.hasAccount else { return }
        Task { await recorder.start(token: KeychainStore.get(AppState.tokenKey)) }
    }

    private func toggle() {
        guard !recorder.isBusy, !recorder.isInMeeting else { return }
        if app.hasAccount {
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

/// Three tiny bars, after the desktop's mic-chip meter: they move with the
/// microphone's level, and lie flat and grey when nothing is heard — paused,
/// on a call, or a silent room. The large waveform the record screen used to
/// show mid-meeting is gone; this is what is left of its one job, saying the
/// phone hears the room.
private struct ChipMeter: View {
    let level: Float

    var body: some View {
        let p = min(1, Double(level).squareRoot())
        let active = p > 0.03
        HStack(alignment: .bottom, spacing: 2) {
            ForEach([0.7, 1, 0.5], id: \.self) { weight in
                RoundedRectangle(cornerRadius: 1)
                    .fill(active ? Theme.primary : Color(.tertiaryLabel))
                    .frame(width: 3, height: 3 + (9 * min(1, p * weight * 1.6)).rounded())
            }
        }
        .frame(height: 12, alignment: .bottom)
        .animation(.linear(duration: 0.075), value: level)
        .accessibilityHidden(true)
    }
}

/// Tells the live transcript whether its last line is in view, so scrolling
/// back down to it can resume following. iOS 18's scroll geometry is the one
/// clean way to know; on 17 this does nothing and the "Latest" control is the
/// way back. The distance, not a Bool, is what is observed: it changes as the
/// transcript grows as well as when it scrolls, so the first report arrives
/// with the first turn rather than waiting for the first time the answer
/// flips.
private struct ReportsScrollBottom: ViewModifier {
    let report: (Bool) -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollGeometryChange(for: Double.self) { geometry in
                max(0, geometry.contentSize.height - geometry.visibleRect.maxY)
            } action: { _, distance in
                // A few points of slack, for the content inset and for a
                // `scrollTo(.bottom)` that lands a hair short.
                report(distance <= 24)
            }
        } else {
            content
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
