import AVFoundation
import ParleyKit
import SwiftUI

// The onboarding's steps, one view each, in the order `OnboardingStep` lists
// them. Each mirrors the desktop step of the same name in
// `src/components/Onboarding.tsx` and `src/components/onboarding/`.

// MARK: - 1 · welcome

struct OnboardingIntroStep: View {
    var body: some View {
        ScrollView {
            VStack(spacing: 32) {
                Text("Welcome to Parley!")
                    .font(.parley.title2)
                    .foregroundStyle(OnboardingPalette.ink)
                    .multilineTextAlignment(.center)
                IntroStage()
                    .frame(maxWidth: 420)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 24)
            .padding(.top, 20)
            .padding(.bottom, 24)
        }
        .scrollBounceBehavior(.basedOnSize)
    }
}

// MARK: - 2 · choose how to run Parley

/// Signed out: the Cloud card (sign in here) over the Local card. The phone
/// only runs on Cloud, so the Local card says where Local lives instead of
/// offering a button. Signed in: the desktop's confirmation card.
struct OnboardingAccountStep: View {
    @EnvironmentObject private var app: AppState
    @AppStorage(OnboardingFlag.afterSignInKey) private var afterSignIn = false
    @AppStorage(OnboardingFlag.completedKey) private var completed = false
    @AppStorage(OnboardingFlag.stepKey) private var savedStep = ""
    let onBack: () -> Void

    var body: some View {
        ScrollView {
            Group {
                if app.hasAccount {
                    confirmed
                } else {
                    choosing
                }
            }
            .padding(20)
        }
        .scrollBounceBehavior(.basedOnSize)
    }

    private var confirmed: some View {
        OnboardingConfirmCard(
            pills: [
                OnboardingPill(
                    icon: Image(systemName: "person.crop.circle.badge.checkmark"),
                    label: Text(verbatim: app.user?.email ?? ""), style: .green)
            ],
            title: "You're on Cloud",
            message: "Parley provides the transcription and AI, with a free monthly allowance. Nothing to pay yourself.")
            // The whole page between the header and the footer, less the
            // 20 pt the step pads it by on each side; never under 150 pt.
            .containerRelativeFrame(.vertical) { height, _ in max(150, height - 40) }
    }

    private var choosing: some View {
        VStack(alignment: .leading, spacing: 24) {
            OnboardingChoiceCard(
                primary: true,
                pill: OnboardingPill(icon: Image(systemName: "cloud"), label: Text("Cloud"), style: .blue),
                art: OnboardingLineArt(
                    name: "OnboardingCloudLines", size: CGSize(width: 967, height: 200),
                    offset: CGSize(width: -444, height: 0))
            ) {
                Text("Sign in and use Parley's transcription and AI models, free within a monthly allowance, no keys needed. Claude on the web or your phone can read your recordings through the MCP connector.")
                    .font(.parley.subheadline)
                    .foregroundStyle(OnboardingPalette.ink)
                    .fixedSize(horizontal: false, vertical: true)
            } action: {
                VStack(alignment: .trailing, spacing: 6) {
                    OnboardingBlueButton(
                        title: app.signingIn ? "Signing in…" : "Sign in or create an account",
                        trailingIcon: "rectangle.portrait.and.arrow.right",
                        busy: app.signingIn,
                        action: signIn)
                    if let error = app.signInError {
                        Text(error)
                            .font(.parley.caption)
                            .foregroundStyle(Theme.destructive)
                            .multilineTextAlignment(.trailing)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            OnboardingOrDivider()

            OnboardingChoiceCard(
                primary: false,
                pill: OnboardingPill(icon: Image(systemName: "laptopcomputer"), label: Text("Local")),
                art: OnboardingLineArt(
                    name: "OnboardingLocalLines", size: CGSize(width: 774, height: 105),
                    offset: CGSize(width: 0, height: 38))
            ) {
                Text("Use your own API keys or a model on your computer; your data goes only to the providers you choose. Local is set up in the desktop app.")
                    .font(.parley.subheadline)
                    .foregroundStyle(OnboardingPalette.ink)
                    .fixedSize(horizontal: false, vertical: true)
            } action: {
                Label("Desktop app only", systemImage: "laptopcomputer")
                    .font(.parley.footnote)
                    .foregroundStyle(Color(.secondaryLabel))
                    .padding(.horizontal, 12)
                    .frame(minHeight: 36)
            }

            HStack {
                OnboardingGhostButton(title: "Back", leadingIcon: "chevron.left", action: onBack)
                    .disabled(app.signingIn)
                Spacer()
                Link("Privacy Policy", destination: URL(string: "https://parley.tw/privacy/")!)
                    .font(.parley.caption)
            }
        }
    }

    private func signIn() {
        // Only someone who has never finished the onboarding goes on to the
        // rest of it after signing in, and lands back on this step.
        if !completed { afterSignIn = true }
        savedStep = OnboardingStep.account.rawValue
        app.signIn()
    }
}

// MARK: - 3 · organization

/// Join an organization you were invited to, create one, or carry on as an
/// individual — the desktop's `OrgStep`. Once a member, its confirmation card.
struct OnboardingOrgStep: View {
    @EnvironmentObject private var app: AppState
    @ObservedObject var model: OnboardingOrgModel
    @State private var orgName = ""
    let onBack: () -> Void
    let onContinue: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                content
                if let error = model.actionError {
                    Text(error)
                        .font(.parley.footnote)
                        .foregroundStyle(Theme.destructive)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(20)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
        .task {
            if model.phase == .loading { await model.load(app: app) }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .loading:
            HStack(spacing: 10) {
                ProgressView()
                Text("Checking your organizations…")
                    .font(.parley.subheadline)
                    .foregroundStyle(Color(.secondaryLabel))
            }
        case .failed:
            VStack(alignment: .leading, spacing: 12) {
                Text("Couldn't load your organizations. Retry, or skip for now.")
                    .font(.parley.subheadline)
                    .foregroundStyle(OnboardingPalette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                OnboardingWhiteButton(title: "Retry", trailingIcon: "arrow.clockwise") {
                    Task { await model.load(app: app) }
                }
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(OnboardingPalette.hairline))
            }
        case .joined:
            OnboardingConfirmCard(
                pills: model.joinedNames.map {
                    OnboardingPill(icon: Image(systemName: "person.2"), label: Text(verbatim: $0), style: .green)
                },
                title: "You're in an organization",
                message: "Everyone in the organization can see the recordings shared to it.")
                // Fills the page like the signed-in confirmation: everything
                // between the header and the footer, less the 20 pt padding.
                .containerRelativeFrame(.vertical) { height, _ in max(150, height - 40) }
        case .choosing:
            ForEach(model.invitations) { invitation in
                invitationRow(invitation)
            }
            createCard
            OnboardingOrDivider()
            soloCard
            OnboardingGhostButton(title: "Back", leadingIcon: "chevron.left", action: onBack)
        }
    }

    private func invitationRow(_ invitation: CloudInvitation) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "person.2")
                .font(.system(size: 14))
                .foregroundStyle(Color(.secondaryLabel))
            Text("“\(invitation.organizationName ?? invitation.organizationId)” invited you to join")
                .font(.parley.subheadline)
                .foregroundStyle(OnboardingPalette.ink)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            OnboardingBlueButton(title: "Join", busy: model.busy) {
                Task { await model.accept(invitation, app: app) }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(OnboardingPalette.hairline))
    }

    private var createCard: some View {
        OnboardingChoiceCard(
            primary: true,
            pill: OnboardingPill(
                icon: Image("OnboardingOrgCreateIcon"), label: Text("Create an organization"), style: .blue),
            note: "Invite members by email later in the desktop app, under Settings › Organizations.",
            art: OnboardingLineArt(
                name: "OnboardingCloudLines", size: CGSize(width: 967, height: 200),
                offset: CGSize(width: -444, height: -5))
        ) {
            TextField("Organization name", text: $orgName)
                .font(.parley.subheadline)
                .padding(.horizontal, 12)
                .frame(height: 40)
                .background(Theme.background, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(OnboardingPalette.hairline))
                .submitLabel(.done)
                .onSubmit(create)
        } action: {
            OnboardingBlueButton(title: "Create", trailingIcon: "chevron.right", busy: model.busy, action: create)
        }
    }

    private var soloCard: some View {
        OnboardingChoiceCard(
            primary: false,
            pill: OnboardingPill(icon: Image(systemName: "person.crop.circle"), label: Text("Use the personal edition")),
            note: "Create or join one later in the desktop app, under Settings › Organizations.",
            art: OnboardingLineArt(
                name: "OnboardingSoloLines", size: CGSize(width: 774, height: 117),
                offset: CGSize(width: 0, height: 38))
        ) {
            EmptyView()
        } action: {
            OnboardingWhiteButton(title: "Continue", action: onContinue)
                .disabled(model.busy)
        }
    }

    private func create() {
        Task { await model.create(name: orgName, app: app) }
    }
}

/// What the organization step knows: the user's organizations and the
/// invitations still open to them, and whether a join or create is in flight.
@MainActor
final class OnboardingOrgModel: ObservableObject {
    enum Phase: Equatable { case loading, failed, choosing, joined }

    @Published private(set) var phase: Phase = .loading
    @Published private(set) var invitations: [CloudInvitation] = []
    @Published private(set) var joinedNames: [String] = []
    @Published private(set) var busy = false
    @Published private(set) var actionError: String?

    func load(app: AppState) async {
        phase = .loading
        actionError = nil
        #if DEBUG
            if ScreenshotDemo.isActive {
                loadDemo()
                return
            }
        #endif
        let cloud = app.cloud
        do {
            let orgs = try await cloud.myOrgs()
            let open = try await cloud.myInvitations()
            app.orgs = orgs
            show(orgs: orgs, invitations: open)
        } catch {
            phase = .failed
        }
    }

    func accept(_ invitation: CloudInvitation, app: AppState) async {
        guard !busy else { return }
        busy = true
        actionError = nil
        defer { busy = false }
        #if DEBUG
            if ScreenshotDemo.isActive {
                try? await Task.sleep(for: .milliseconds(600))
                joined([invitation.organizationName ?? invitation.organizationId])
                return
            }
        #endif
        let cloud = app.cloud
        do {
            try await cloud.acceptInvitation(id: invitation.id)
            let orgs = (try? await cloud.myOrgs()) ?? []
            app.orgs = orgs
            joined(orgs.isEmpty ? [invitation.organizationName ?? invitation.organizationId] : orgs.map(\.name))
        } catch {
            actionError = String(localized: "That didn't work. Check your connection and try again.")
        }
    }

    func create(name: String, app: AppState) async {
        guard !busy else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            actionError = String(localized: "Enter a name, or choose the personal edition.")
            return
        }
        busy = true
        actionError = nil
        defer { busy = false }
        #if DEBUG
            if ScreenshotDemo.isActive {
                try? await Task.sleep(for: .milliseconds(600))
                joined([trimmed])
                return
            }
        #endif
        let cloud = app.cloud
        do {
            let created = try await cloud.createOrg(name: trimmed)
            let orgs = (try? await cloud.myOrgs()) ?? [created]
            app.orgs = orgs
            joined([created.name])
        } catch {
            actionError = String(localized: "That didn't work. Check your connection and try again.")
        }
    }

    private func show(orgs: [CloudOrg], invitations open: [CloudInvitation]) {
        if orgs.isEmpty {
            invitations = open
            phase = .choosing
        } else {
            joined(orgs.map(\.name))
        }
    }

    private func joined(_ names: [String]) {
        joinedNames = names
        invitations = []
        phase = .joined
    }

    #if DEBUG
        /// The demo never touches the network: each scenario is a fixture.
        private func loadDemo() {
            switch ScreenshotDemo.shared.onboarding {
            case .orgJoined:
                joined(ScreenshotDemo.orgs.map(\.name))
            case .orgInvited:
                show(orgs: [], invitations: [ScreenshotDemo.onboardingInvitation])
            default:
                show(orgs: [], invitations: [])
            }
        }
    #endif
}

// MARK: - 4 · permissions

/// The microphone, the one grant a phone recording needs — the desktop's
/// permissions step with its macOS-only system-audio row left out. Re-read
/// whenever the app comes back to the front, so a grant made in Settings
/// shows up on its own.
struct OnboardingPermsStep: View {
    @State private var permission = AudioCapture.permission
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Your voice needs microphone access. Parley records the room through the phone's microphone.")
                    .font(.parley.subheadline)
                    .foregroundStyle(OnboardingPalette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                micRow
            }
            .padding(20)
        }
        .scrollBounceBehavior(.basedOnSize)
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { permission = AudioCapture.permission }
        }
    }

    private var micRow: some View {
        HStack(spacing: 12) {
            Image(systemName: "mic")
                .font(.system(size: 15))
            Text("Microphone (your voice)")
                .font(.parley.subheadline)
            Spacer(minLength: 8)
            switch permission {
            case .granted:
                Image(systemName: "checkmark")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(OnboardingPalette.greenInk)
                    .accessibilityLabel(Text("Allowed"))
            case .denied:
                smallButton("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                }
            default:
                smallButton("Grant") {
                    Task {
                        _ = await AudioCapture.requestPermission()
                        permission = AudioCapture.permission
                    }
                }
            }
        }
        .foregroundStyle(OnboardingPalette.ink)
        .padding(20)
        .background(alignment: .topLeading) {
            OnboardingLineArt(
                name: "OnboardingSoloLines", size: CGSize(width: 774, height: 117),
                offset: CGSize(width: -52, height: 37))
        }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(OnboardingPalette.hairline))
    }

    private func smallButton(_ title: LocalizedStringKey, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.parley.caption)
                .padding(.horizontal, 12)
                .frame(minHeight: 30)
                .background(Theme.background, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(OnboardingPalette.hairline))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - 5 · microphone check

/// Read a sentence about yourself aloud: the microphone is checked, and what
/// was said becomes the first line of the speaker background — the desktop's
/// `MicStep`. The desktop also has an AI tidy the sentence into background
/// lines and terms; the phone keeps the sentence as said, which is what the
/// desktop falls back to when no model answers.
struct OnboardingMicStep: View {
    @EnvironmentObject private var app: AppState
    @ObservedObject var check: MicCheckModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Tap “Start test” and read the sentence below to check the microphone picks you up.")
                    .font(.parley.subheadline)
                    .foregroundStyle(Color(.secondaryLabel))
                    .fixedSize(horizontal: false, vertical: true)

                VStack(alignment: .leading, spacing: 6) {
                    Text("Microphone (input device)")
                        .font(.parley.subheadline)
                        .foregroundStyle(OnboardingPalette.ink)
                    HStack {
                        Text(verbatim: check.inputName)
                            .font(.parley.subheadline)
                            .foregroundStyle(OnboardingPalette.ink)
                        Spacer()
                    }
                    .padding(.horizontal, 12)
                    .frame(height: 40)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(OnboardingPalette.hairline))
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("Introduce yourself in a sentence")
                        .font(.parley.subheadline)
                        .foregroundStyle(OnboardingPalette.ink)
                    testCard
                }
            }
            .padding(20)
        }
        .scrollBounceBehavior(.basedOnSize)
        .onAppear { check.refreshInput() }
        // Leaving mid-sentence is the same as Stop, as on the desktop: what
        // was said is still saved, so Next never throws an introduction away.
        .onDisappear { Task { await check.stop() } }
    }

    private var testCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            scriptLine
                .font(.parley.footnote)
                .foregroundStyle(OnboardingPalette.ink)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(OnboardingPalette.bubble, in: RoundedRectangle(cornerRadius: 10))

            HStack(spacing: 10) {
                // Its own width, always: the track takes what is left.
                testButton
                    .fixedSize()
                OnboardingMicTrack(levels: check.levels, running: check.phase == .listening)
                    .frame(height: 36)
            }

            if !check.text.isEmpty {
                Text(verbatim: check.text)
                    .font(.parley.body)
                    .foregroundStyle(OnboardingPalette.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }

            status
        }
        .padding(20)
        .background(alignment: .topLeading) {
            OnboardingLineArt(
                name: "OnboardingSoloLines", size: CGSize(width: 774, height: 117),
                offset: CGSize(width: -8, height: -5))
                .opacity(check.phase == .listening ? 0.7 : 1)
        }
        .background(Theme.background)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(OnboardingPalette.hairline))
    }

    @ViewBuilder
    private var testButton: some View {
        let listening = check.phase == .listening
        let busy = check.phase == .stopping
        Button {
            Task {
                if listening {
                    await check.stop()
                } else {
                    await check.start(cloud: app.cloud)
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: listening ? "stop.fill" : (check.phase == .idle ? "mic" : "arrow.counterclockwise"))
                    .font(.system(size: 12))
                Text(listening ? "Stop recording" : (check.phase == .idle ? "Start test" : "Try again"))
                    .font(.parley.subheadlineEmphasized)
            }
            .padding(.horizontal, 10)
            .frame(minHeight: 36)
            .foregroundStyle(listening ? Theme.recording : Theme.primary)
            .background(Theme.background, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(OnboardingPalette.hairline))
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }

    @ViewBuilder
    private var status: some View {
        switch check.phase {
        case .idle:
            EmptyView()
        case .listening:
            statusLine("Listening…", icon: nil, color: Color(.secondaryLabel))
        case .stopping:
            statusLine("Adding it to your background…", icon: nil, color: Color(.secondaryLabel))
        case .saved:
            statusLine(
                "Added to your background. You can edit it in the next step.", icon: "checkmark",
                color: OnboardingPalette.greenInk)
        case .empty:
            statusLine(
                "Didn't catch anything. Try again, or check the microphone.", icon: "exclamationmark.circle",
                color: Color(.secondaryLabel))
        case .failed(let message):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "exclamationmark.circle")
                Text("Transcription didn't work: \(message)")
            }
            .font(.parley.caption)
            .foregroundStyle(Theme.destructive)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func statusLine(_ text: LocalizedStringKey, icon: String?, color: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if let icon { Image(systemName: icon) }
            Text(text)
        }
        .font(.parley.caption)
        .foregroundStyle(color)
        .fixedSize(horizontal: false, vertical: true)
    }

    /// The sentence to read, with its blanks in grey inside their braces, as
    /// the desktop's `ScriptLine` draws it.
    private var scriptLine: Text {
        let template = String(localized: "I'm {role} at {company}, and I use Parley to {purpose}.")
        var out = Text(verbatim: "")
        var rest = Substring(template)
        while let open = rest.firstIndex(of: "{"), let close = rest[open...].firstIndex(of: "}") {
            let key = String(rest[rest.index(after: open)..<close])
            out = out + Text(verbatim: String(rest[..<open])) + Text(verbatim: "{")
                + Text(Self.blank(key)).foregroundStyle(Color(.secondaryLabel)) + Text(verbatim: "}")
            rest = rest[rest.index(after: close)...]
        }
        return out + Text(verbatim: String(rest))
    }

    private static func blank(_ key: String) -> LocalizedStringKey {
        switch key {
        case "company": return "company"
        case "role": return "name / title"
        default: return "what you use it for"
        }
    }
}

/// The waveform beside the test button: a dashed baseline with a caret at
/// rest, the microphone's recent levels while listening.
/// The mic check's level as a recording track, the desktop's `WaveformTrack`:
/// thin bars for what has been said, a dashed line for the rest, and a
/// playhead where the recording is now. The playhead starts at the left edge
/// and walks right as the bars come in; once it reaches the right end it stays
/// and the bars scroll past it, so a long take never outgrows the track. (The
/// desktop stops it at the middle; on the phone's narrower track the walk
/// runs the whole way.)
struct OnboardingMicTrack: View {
    let levels: [CGFloat]
    let running: Bool

    /// A bar and the gap after it.
    private static let bar: CGFloat = 2
    private static let step: CGFloat = 4

    var body: some View {
        GeometryReader { geo in
            // The playhead walks right until the end of the track (less its
            // own width), then the bars scroll.
            let playheadX = min(CGFloat(levels.count) * Self.step, (geo.size.width - 2).rounded(.down))
            let fits = max(0, Int(playheadX / Self.step))
            let shown = levels.suffix(fits)
            ZStack(alignment: .leading) {
                Rectangle()
                    .stroke(style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    .foregroundStyle(OnboardingPalette.hairline)
                    .frame(height: 1)
                HStack(spacing: Self.step - Self.bar) {
                    ForEach(Array(shown.enumerated()), id: \.offset) { _, level in
                        Capsule()
                            .fill(running ? Theme.primary : Theme.primary.opacity(0.4))
                            .frame(width: Self.bar, height: max(2, level * 34))
                    }
                }
                .frame(width: playheadX, alignment: .trailing)
                Capsule()
                    .fill(Theme.primary)
                    .frame(width: 2, height: geo.size.height * 0.75)
                    .offset(x: playheadX)
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .leading)
        }
        .clipped()
        .accessibilityHidden(true)
    }
}

/// One microphone check: capture → the hosted relay → the words said → the
/// speaker background and the dictionary, the desktop's `MicStep` end to end
/// (see `MicIntro`): the sentence is normalized, tidied by the hosted model
/// into background lines and names, appended to the background without
/// touching what is there, and its company and name become terms. Testing
/// again takes the previous run's lines and new terms back out first.
@MainActor
final class MicCheckModel: ObservableObject {
    enum Phase: Equatable { case idle, listening, stopping, saved, empty, failed(String) }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var text = ""
    @Published private(set) var levels: [CGFloat] = []
    @Published private(set) var inputName = ""

    private var capture: AudioCapture?
    private var client: ParleyStreamClient?
    private var cloud: CloudClient?
    private var transcript = MicIntro.Transcript()
    /// What the previous check put into the setup, so a new one replaces it.
    private var lastRun: MicIntro.Run?
    /// Bumped by every start, so a late close or timer from an earlier run
    /// cannot finish the current one.
    private var generation = 0
    /// Set while a run is being saved, so the relay's close and the backstop
    /// timer cannot both save it.
    private var finishing = false
    private var demoTask: Task<Void, Never>?
    private static let maxLevels = 200
    /// A self-introduction takes seconds; the desktop ends the check here so
    /// the microphone and the paid stream are not left open.
    private static let maxDuration: Duration = .seconds(30)
    /// How long Stop waits for the relay to flush its last words.
    private static let closeWait: Duration = .seconds(4)

    func refreshInput() {
        inputName =
            AVAudioSession.sharedInstance().currentRoute.inputs.first?.portName
            ?? String(localized: "iPhone microphone")
    }

    func start(cloud: CloudClient) async {
        guard phase != .listening, phase != .stopping else { return }
        generation += 1
        let run = generation
        undoLastRun()
        self.cloud = cloud
        text = ""
        transcript = MicIntro.Transcript()
        levels = []
        #if DEBUG
            if ScreenshotDemo.isActive {
                runDemo()
                return
            }
        #endif
        guard await AudioCapture.requestPermission() else {
            phase = .failed(String(localized: "Microphone access is off. Allow it in Settings."))
            return
        }
        guard let token = KeychainStore.get(AppState.tokenKey) else {
            phase = .failed(String(localized: "Sign in first."))
            return
        }
        // The product's name first among the recognition terms: the check
        // has the user say it (the desktop's `withProductName`).
        let vocabulary = [MicIntro.productName] + LexiconStore.recognitionTerms().filter { $0 != MicIntro.productName }
        let client = ParleyStreamClient(
            options: .init(
                bearerToken: token, diarization: false,
                vocabulary: vocabulary, feature: "voice_typing")
        ) { [weak self] event in
            Task { @MainActor in self?.handle(event, run: run) }
        }
        let capture = AudioCapture(onChunk: { [weak self] samples, level in
            client.enqueue(pcm: samples)
            Task { @MainActor in self?.push(level: level) }
        })
        self.client = client
        self.capture = capture
        phase = .listening
        do {
            try await client.start()
            try await capture.start()
            refreshInput()
        } catch {
            await cancel()
            phase = .failed(error.localizedDescription)
            return
        }
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: Self.maxDuration)
            guard let self, self.generation == run else { return }
            await self.stop()
        }
    }

    /// Stop listening and save what was said. Also what leaving the step
    /// does; a check that is not listening is left as it is.
    func stop() async {
        guard phase == .listening else { return }
        phase = .stopping
        let run = generation
        #if DEBUG
            if ScreenshotDemo.isActive {
                demoTask?.cancel()
                try? await Task.sleep(for: .milliseconds(700))
                await finish(run: run)
                return
            }
        #endif
        await capture?.stop()
        capture = nil
        await client?.finish()
        // The relay's close normally finishes the run; this is the backstop
        // for a close that never comes.
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: Self.closeWait)
            guard let self, self.generation == run, self.phase == .stopping else { return }
            await self.finish(run: run)
        }
    }

    /// Drop the check without saving: only for a failed start.
    func cancel() async {
        demoTask?.cancel()
        demoTask = nil
        await capture?.stop()
        capture = nil
        await client?.finish()
        client = nil
        if phase == .listening || phase == .stopping { phase = .idle }
    }

    private func handle(_ event: SttRelayEvent, run: Int) {
        guard run == generation else { return }
        switch event {
        case .segment(let segment):
            transcript.accept(segment)
            text = Self.normalized(transcript.text)
        case .closed:
            if phase == .stopping || phase == .listening {
                phase = .stopping
                Task { await finish(run: run) }
            }
        case .error(let message, _):
            switch phase {
            case .listening:
                Task { await cancel() }
                phase = .failed(message)
            case .stopping:
                // The words are in; a failed close does not lose them.
                Task { await finish(run: run) }
            default:
                break
            }
        }
    }

    private func push(level: Float) {
        guard phase == .listening else { return }
        levels.append(CGFloat(min(1, level * 8)))
        if levels.count > Self.maxLevels { levels.removeFirst(levels.count - Self.maxLevels) }
    }

    /// The desktop's `normalizeTranscriptText` + `fixProductName`, with the
    /// user's own replacements.
    private static func normalized(_ raw: String) -> String {
        MicIntro.normalize(raw) { LexiconStore.apply(to: $0) }
    }

    /// The desktop's `finish`: the sentence into the background and the
    /// dictionary. Runs once per check, even after the step has gone.
    private func finish(run: Int) async {
        guard run == generation, phase == .stopping, !finishing else { return }
        finishing = true
        defer { finishing = false }
        client = nil
        let said = Self.normalized(transcript.text).trimmingCharacters(in: .whitespacesAndNewlines)
        text = said
        guard !said.isEmpty else {
            phase = .empty
            return
        }
        var summary = MicIntro.Summary.plain(said)
        if let cloud {
            do {
                summary = try await MicIntro.summarize(said, chinese: Self.chinese, cloud: cloud)
            } catch {
                // The sentence itself still makes a background line.
                AppLog.capture.notice(
                    "onboarding: summarizing the self-introduction failed: \(String(describing: error), privacy: .public)")
            }
        }
        // The company and name always become terms, model or not.
        let intro = MicIntro.complete(summary, transcript: said)
        let defaults = UserDefaults.standard
        let appended = MicIntro.append(
            intro.background, to: defaults.string(forKey: OnboardingFlag.backgroundKey) ?? "")
        defaults.set(appended.text, forKey: OnboardingFlag.backgroundKey)
        let had = Set(LexiconStore.terms().map(\.text))
        var created: [String] = []
        for term in intro.terms {
            let phrase = term.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !phrase.isEmpty, phrase.count <= MicIntro.maxTermCharacters else { continue }
            if !had.contains(phrase) && !created.contains(phrase) { created.append(phrase) }
            LexiconStore.addTerm(phrase)
        }
        lastRun = MicIntro.Run(lines: appended.lines, createdTerms: created)
        if run == generation { phase = .saved }
    }

    /// Testing again replaces the previous result rather than adding to it:
    /// its background lines out, and the terms it created gone.
    private func undoLastRun() {
        guard let last = lastRun else { return }
        lastRun = nil
        let defaults = UserDefaults.standard
        let background = defaults.string(forKey: OnboardingFlag.backgroundKey) ?? ""
        defaults.set(MicIntro.remove(last.lines, from: background), forKey: OnboardingFlag.backgroundKey)
        for term in last.createdTerms { LexiconStore.removeTerm(term) }
    }

    private static var chinese: Bool {
        (Bundle.main.preferredLocalizations.first ?? "en").hasPrefix("zh")
    }

    #if DEBUG
        /// No microphone and no network in the demo: a sentence types itself
        /// in over a made-up waveform until Stop is tapped.
        private func runDemo() {
            phase = .listening
            let sentence = (Bundle.main.preferredLocalizations.first ?? "en").hasPrefix("zh")
                ? "我是派斯科技的設計師王小明，我主要用 Parley 來整理客戶會議。"
                : "I'm Ming, a designer at Pathors, and I use Parley to keep track of customer meetings."
            demoTask = Task { @MainActor [weak self] in
                var shown = 0
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(80))
                    guard let self, self.phase == .listening else { return }
                    self.push(level: Float.random(in: 0.02...0.12))
                    if shown < sentence.count {
                        shown += 1
                        self.transcript.accept(
                            TranscriptSegment(
                                id: "mix-0", source: "mix", speaker: 0,
                                text: String(sentence.prefix(shown)), isFinal: true, startMs: 0, endMs: 0))
                        self.text = Self.normalized(self.transcript.text)
                    }
                }
            }
        }
    #endif
}

// MARK: - 6 · context

/// What every meeting prompt should know about the user — the desktop's
/// `ContextStep`: the speaker background as free text (seeded by the
/// microphone check), and the terms transcription should spell right (the
/// personal dictionary, shared with the voice keyboard and the Mac).
struct OnboardingContextStep: View {
    @AppStorage(OnboardingFlag.backgroundKey) private var background = ""
    @State private var terms: [String] = []
    @State private var newTerm = ""
    @FocusState private var termFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("About you")
                        .font(.parley.subheadline)
                        .foregroundStyle(OnboardingPalette.ink)
                    ZStack(alignment: .topLeading) {
                        TextEditor(text: $background)
                            .font(.parley.subheadline)
                            .scrollContentBackground(.hidden)
                            .padding(6)
                            .frame(minHeight: 240)
                        if background.isEmpty {
                            Text("e.g. I'm a designer at Acme and often talk outbound-calling deals with Globex.")
                                .font(.parley.subheadline)
                                .foregroundStyle(Color(.placeholderText))
                                .padding(.horizontal, 11)
                                .padding(.vertical, 14)
                                .allowsHitTesting(false)
                        }
                    }
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(OnboardingPalette.hairline))
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("Terms")
                        .font(.parley.subheadline)
                        .foregroundStyle(OnboardingPalette.ink)
                    OnboardingWrapLayout(spacing: 8) {
                        ForEach(terms, id: \.self) { term in
                            termChip(term)
                        }
                        HStack(spacing: 10) {
                            TextField("+ Add", text: $newTerm)
                                .font(.parley.subheadline)
                                .focused($termFocused)
                                .submitLabel(.done)
                                .onSubmit(addTerm)
                                .padding(.horizontal, 10)
                                .frame(width: 120, height: 30)
                                .overlay(
                                    Capsule().stroke(
                                        OnboardingPalette.hairline, style: StrokeStyle(lineWidth: 1, dash: [3, 3])))
                            Button("Add", action: addTerm)
                                .font(.parley.footnote)
                                .disabled(newTerm.trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                    }
                }
            }
            .padding(20)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
        .onAppear(perform: reload)
    }

    private func termChip(_ term: String) -> some View {
        HStack(spacing: 6) {
            Text(verbatim: term)
                .font(.parley.subheadline)
            Button {
                LexiconStore.removeTerm(term)
                reload()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Remove \(term)"))
        }
        .foregroundStyle(OnboardingPalette.ink)
        .padding(.horizontal, 10)
        .frame(height: 30)
        .background(OnboardingPalette.bubble, in: Capsule())
    }

    private func addTerm() {
        let term = newTerm.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !term.isEmpty else { return }
        LexiconStore.addTerm(term)
        newTerm = ""
        reload()
    }

    private func reload() {
        terms = LexiconStore.load().termsByRecency.map(\.text)
    }
}

/// Chips that wrap onto as many lines as they need.
struct OnboardingWrapLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > maxWidth {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

// MARK: - 7 · done

struct OnboardingDoneStep: View {
    let finish: (OnboardingExit) -> Void

    var body: some View {
        ScrollView {
            VStack(spacing: 36) {
                ZStack {
                    Circle().fill(OnboardingPalette.greenPill)
                    Image(systemName: "checkmark")
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(OnboardingPalette.greenInk)
                }
                .frame(width: 48, height: 48)
                .accessibilityHidden(true)

                VStack(spacing: 20) {
                    Text("You're all set!")
                        .font(.parley.title2)
                        .foregroundStyle(OnboardingPalette.ink)
                    (Text("Get to know Parley in five minutes:").font(.parley.subheadlineEmphasized)
                        + Text(verbatim: "\n")
                        + Text("Start from a sample recording for a quick tour of filing, replay and AI analysis."))
                        .font(.parley.subheadline)
                        .foregroundStyle(OnboardingPalette.ink)
                        .multilineTextAlignment(.center)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                }

                HStack(spacing: 24) {
                    OnboardingGhostButton(title: "Start recording") { finish(.record) }
                    OnboardingBlueButton(title: "Try the sample") { finish(.sample) }
                        .overlay(alignment: .topTrailing) {
                            OnboardingScribbleArrow()
                                .stroke(Theme.primary, style: StrokeStyle(lineWidth: 1, lineCap: .round, lineJoin: .round))
                                .frame(width: 46, height: 53)
                                .offset(x: 34, y: -52)
                                .allowsHitTesting(false)
                                .accessibilityHidden(true)
                        }
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 24)
            .padding(.top, 72)
            .padding(.bottom, 24)
        }
        .scrollBounceBehavior(.basedOnSize)
    }
}

/// The hand-drawn curly arrow pointing at "Try the sample" — the desktop's
/// `DoneScribbles`, its arrow and arrowhead paths verbatim (46 × 53 box).
struct OnboardingScribbleArrow: Shape {
    private static let arrow =
        "M45.1053 2.79108C45.3527 3.38198 45.8571 5.99669 45.1422 14.6463C44.6467 20.642 40.1849 25.574 37.8872 27.9471C36.0813 29.8122 34.433 30.0106 32.0533 29.9519C31.1936 29.9306 29.473 28.8217 29.1679 27.7333C29.0108 27.1728 29.0235 26.554 29.1028 26.0432C29.1821 25.5324 30.041 24.8943 30.6057 24.6671C32.0186 24.0986 33.3829 24.5965 34.202 24.9101C36.3476 25.7318 37.2276 28.8162 35.8757 32.7159C34.0083 38.1022 30.7533 39.7886 26.7208 42.12C24.537 43.3826 20.7951 44.1904 16.4297 45.5C7.35849 47.7429 3.48971 47.8809 2.32167 47.9405C1.78396 47.9657 1.35795 47.9807 1.21032 48.3674"
    private static let head =
        "M3.68704 44.0928C3.63566 44.2014 3.26855 44.7322 2.2476 46.2443C1.87908 46.7901 0.741917 48.6045 0.499651 48.8477C0.957288 49.048 1.52832 48.4571 3.49006 49.0908C4.23629 49.3319 5.99017 49.8635 6.91468 50.3245"

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let sx = rect.width / 46
        let sy = rect.height / 53
        for data in [Self.arrow, Self.head] {
            path.addPath(Self.parse(data), transform: CGAffineTransform(scaleX: sx, y: sy))
        }
        return path.offsetBy(dx: rect.minX, dy: rect.minY)
    }

    /// Absolute `M`, `L` and `C` commands — all these two paths use.
    private static func parse(_ data: String) -> Path {
        var path = Path()
        var command: Character = "M"
        var numbers: [CGFloat] = []
        var token = ""

        func flushToken() {
            if let value = Double(token) { numbers.append(CGFloat(value)) }
            token = ""
        }
        func emit() {
            switch command {
            case "M":
                var i = 0
                while i + 1 < numbers.count {
                    let p = CGPoint(x: numbers[i], y: numbers[i + 1])
                    if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
                    i += 2
                }
            case "L":
                var i = 0
                while i + 1 < numbers.count {
                    path.addLine(to: CGPoint(x: numbers[i], y: numbers[i + 1]))
                    i += 2
                }
            case "C":
                var i = 0
                while i + 5 < numbers.count {
                    path.addCurve(
                        to: CGPoint(x: numbers[i + 4], y: numbers[i + 5]),
                        control1: CGPoint(x: numbers[i], y: numbers[i + 1]),
                        control2: CGPoint(x: numbers[i + 2], y: numbers[i + 3]))
                    i += 6
                }
            default:
                break
            }
            numbers = []
        }

        for ch in data {
            if ch == "M" || ch == "L" || ch == "C" {
                flushToken()
                if !numbers.isEmpty { emit() }
                command = ch
            } else if ch == " " || ch == "," {
                flushToken()
            } else if ch == "-" && !token.isEmpty && token.last != "e" {
                flushToken()
                token.append(ch)
            } else {
                token.append(ch)
            }
        }
        flushToken()
        if !numbers.isEmpty { emit() }
        return path
    }
}
