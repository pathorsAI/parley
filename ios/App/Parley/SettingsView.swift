import ParleyKit
import SwiftUI

/// Settings — phone-sized mirror of the desktop Settings window's cloud
/// sections: account (sign in/out), default save location, appearance, and the
/// hosted quota bars. Provider/transcription config stays desktop-side: the
/// phone rides the hosted providers with the account token (design doc D6).
struct SettingsView: View {
    @EnvironmentObject private var app: AppState
    /// What the phone is holding. Read here for the size row; written by the
    /// library's download actions.
    @EnvironmentObject private var downloads: AudioDownloadModel
    /// Only for the microphone-window rows: how long the keyboard's mic stays
    /// ready is settings, but *whether it is open right now* is live state that
    /// belongs to the thing holding it.
    @ObservedObject private var dictation = DictationCoordinator.shared
    /// For "Show the getting-started list again", which ends on the Library.
    @EnvironmentObject private var router: TabRouter
    /// The keyboard's typing panes. Read once here and written straight through
    /// to the App Group's defaults, which is where the extension looks for them
    /// on every appearance — there is no live binding across a process boundary.
    @State private var enabled = TypingKeyboards.enabled()
    /// The cleanup pass after dictation: off, tidy or concise. Bound here,
    /// read raw by the coordinator: both sides are `UserDefaults.standard`, and
    /// the coordinator has to be able to answer this in the background with no
    /// view alive. The old on/off switch is folded into this key at launch
    /// (`PolishStyle.migrateLegacySetting`), so the default here is only ever
    /// what someone who never touched either setting sees.
    @AppStorage(DictationCoordinator.polishKey) private var polishStyle = PolishStyle.default
    /// Whether a recording made here keeps its audio after uploading. Read raw
    /// out of the same defaults by `MeetingUploader`, which has no view alive
    /// when it has to decide — see `LocalAudioStore.keepsAudioOnPhone`, which is
    /// where the `true` default is stated for both readers.
    @AppStorage(LocalAudioStore.keepAudioKey) private var keepAudioOnPhone = true
    @State private var showRemoveAudioConfirmation = false
    /// "Keep voice typing history". Bound here, read raw by the store on every
    /// write (`DictationHistoryStore.isEnabled`) — the coordinator keeps a
    /// session with no view alive.
    @AppStorage(DictationHistoryStore.enabledKey) private var keepDictationHistory = true
    @ObservedObject private var dictationHistory = DictationHistory.shared
    @State private var showClearHistoryConfirmation = false
    /// Settings › 剪貼簿. Read once here and written straight through to the
    /// App Group's defaults, where the keyboard reads them on every appearance
    /// — the same arrangement as `enabled` above. See `ClipboardSettings`.
    @State private var clipboardAutoCapture = ClipboardSettings.autoCapture()
    @State private var clipboardRetention = ClipboardSettings.retention()
    @State private var clipboardPreview = ClipboardSettings.previewInStrip()
    @State private var showClearClipboardConfirmation = false
    /// Pushes 常用資訊 when the keyboard's 📋 panel links to it.
    @State private var showSavedInfo = false
    @State private var showResetZhuyinConfirmation = false
    @State private var personalFolders: [CloudFolder] = []
    @State private var orgFolders: [String: [CloudFolder]] = [:]
    @State private var showDeleteConfirmation = false
    @State private var deletingAccount = false
    @State private var deleteAccountError: String?
    /// Settings › Feedback & diagnostics. Read raw by `FeedbackCenter`, which
    /// decides about a crash with no view alive; the `true` default is stated
    /// in both places because `@AppStorage` cannot share one.
    @AppStorage(FeedbackCenter.autoSendCrashReportsKey) private var autoSendCrashReports = true
    /// The queued recording the `sync_failed` prompt is about, if one is stuck
    /// and may be asked about. Found when the screen appears and latched —
    /// see `findStuckUpload`.
    @State private var stuckUpload: MeetingUploader.StuckUpload?
    #if DEBUG
        @State private var devToken = ""
    #endif

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                Form {
                    accountSection
                    if app.signedIn {
                        saveDestinationSection
                        usageSection
                    }
                    // Sync reads only on-device state, so it stays available while
                    // offline — that is exactly when someone needs to see that a
                    // finished recording is queued rather than lost.
                    if app.hasAccount {
                        syncSection
                    }
                    if app.hasAccount {
                        dictationSection.id(Self.keyboardSectionID)
                        micWindowSection
                    }
                    // Also shown signed out while anything is kept: the history
                    // is on this phone, not in the account, and signing out must
                    // not strand the only switch that clears it.
                    if app.hasAccount || !dictationHistory.entries.isEmpty {
                        dictationHistorySection
                    }
                    keyboardsSection
                    // Outside the account gate, like the keyboards: neither the
                    // clipboard nor 常用資訊 needs an account.
                    clipboardSection.id(Self.clipboardSectionID)
                    appearanceSection
                    languageSection
                    // Outside every gate: a report can be sent signed out —
                    // someone whose sign-in is what broke is exactly who needs
                    // to be able to send one.
                    feedbackSection
                    aboutSection
                    #if DEBUG
                        debugSection
                    #endif
                }
                // **This screen keeps the platform's own surfaces.** Everywhere
                // else in the app a fill behind content is gone; here the
                // inset-grouped `Form` keeps its system background and its
                // system row fill, because a grouped list *is* the iOS grammar
                // for settings and a phone owner already knows how to read one.
                // A pale-blue row fill and brand-blue section headers used to
                // sit on top of it, which made the one screen people arrive at
                // with expectations the one screen that broke them.
                //
                // The cost is that this is the one screen whose page is *not*
                // `Theme.background`: in dark mode a grouped list's own page is
                // the system black rather than Parley's navy-black. Taken
                // knowingly — a settings page that reads as the platform's is
                // worth more here than one that reads as the brand's, and
                // repainting the page while keeping the system row fill would
                // land white rows on a white page in light mode.
                //
                // The face is the only thing overridden, and it has to be set on
                // the whole Form: a settings page is mostly rows nobody styles
                // individually (pickers, links, `LabeledContent`), and each one
                // would otherwise quietly draw in the system font next to a
                // heading that doesn't.
                .font(.parley.body)
                // Settings is a page of short rows; the default height packs
                // them tighter than anything else in the app.
                .environment(\.defaultMinListRowHeight, 48)
                // The keyboard's 📋 panel linking here (`SettingsLinkInbox`).
                // Taken, so it is acted on once; .center for the same reason
                // as the screenshot route below.
                .onReceive(SettingsLinkInbox.shared.$request) { request in
                    guard request != nil, let link = SettingsLinkInbox.shared.take() else { return }
                    switch link {
                    case .clipboard:
                        withAnimation { proxy.scrollTo(Self.clipboardSectionID, anchor: .center) }
                    case .snippets:
                        showSavedInfo = true
                    }
                }
                #if DEBUG
                    .onReceive(ScreenshotDemo.shared.$focusKeyboardSection) { focus in
                        // .center, not .top: scrollTo ignores the navigation
                        // bar's safe-area inset, so a top anchor slides the
                        // section header under the blur.
                        if focus { proxy.scrollTo(Self.keyboardSectionID, anchor: .center) }
                    }
                    .onReceive(ScreenshotDemo.shared.$pressResetChecklist) { press in
                        guard press else { return }
                        // A beat on Settings first, the way a person gets there.
                        Task { @MainActor in
                            try? await Task.sleep(for: .milliseconds(600))
                            showGettingStartedAgain()
                        }
                    }
                #endif
            }
            .navigationTitle("Settings")
            .navigationDestination(isPresented: $showSavedInfo) { SavedInfoView() }
            .task { await loadFolders() }
            .task { findStuckUpload() }
            .onChange(of: app.pendingUploadCount) { _, count in
                if count == 0 { stuckUpload = nil }
            }
            // The store is a directory, so its size is only ever as fresh as the
            // last time someone asked. Arriving on this screen is that moment.
            .task { downloads.refreshSize() }
            .confirmationDialog(
                "Remove the audio kept on this phone?",
                isPresented: $showRemoveAudioConfirmation, titleVisibility: .visible
            ) {
                Button("Remove all", role: .destructive) {
                    downloads.removeAllDownloads()
                }
            } message: {
                Text("The recordings themselves stay in the cloud. You can download the audio again whenever you need it.")
            }
            .confirmationDialog(
                "Clear clipboard history?",
                isPresented: $showClearClipboardConfirmation, titleVisibility: .visible
            ) {
                Button("Clear all", role: .destructive) {
                    ClipboardHistoryStore.shared()?.clearAll()
                }
            } message: {
                Text("Everything the keyboard kept from your clipboard is removed from this phone, pinned items included. This can't be undone.")
            }
            .confirmationDialog(
                "Clear voice typing history?",
                isPresented: $showClearHistoryConfirmation, titleVisibility: .visible
            ) {
                Button("Clear all", role: .destructive) {
                    dictationHistory.clearAll()
                }
            } message: {
                Text("Everything you have dictated is removed from this phone. This can't be undone.")
            }
            .confirmationDialog(
                "Delete your account permanently?", isPresented: $showDeleteConfirmation,
                titleVisibility: .visible
            ) {
                Button("Delete my account and personal data", role: .destructive) {
                    Task { await deleteAccount() }
                }
            } message: {
                Text("This permanently removes your Parley account, personal recordings, transcripts, folders, and usage data. Organizations you still own have to be transferred or deleted first.")
            }
        }
    }

    private static let keyboardSectionID = "voice-keyboard"
    private static let clipboardSectionID = "clipboard"

    private func sectionHeader(_ title: LocalizedStringKey) -> some View {
        SettingsSection.header(title)
    }

    private func sectionFooter(_ text: LocalizedStringKey) -> some View {
        SettingsSection.footer(text)
    }

    // MARK: account

    private var accountSection: some View {
        Section {
            if let user = app.user {
                HStack(spacing: 12) {
                    avatar(user)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: user.name ?? user.email).font(.parley.bodyEmphasized)
                        Text(verbatim: user.email).font(.parley.caption)
                            .foregroundStyle(Color(.secondaryLabel))
                    }
                }
                .padding(.vertical, 4)
                if !app.orgs.isEmpty {
                    ForEach(app.orgs) { org in
                        HStack {
                            Label(org.name, systemImage: "person.2")
                            Spacer()
                            Text(verbatim: roleLabel(org.role))
                                .font(.parley.caption)
                                .foregroundStyle(Color(.secondaryLabel))
                        }
                    }
                }
                Button("Sign out", role: .destructive) {
                    Task { await app.signOut() }
                }
                Button("Delete account", role: .destructive) {
                    showDeleteConfirmation = true
                }
                .disabled(deletingAccount)
                if let deleteAccountError {
                    Text(verbatim: deleteAccountError)
                        .font(.parley.caption)
                        .foregroundStyle(Theme.destructive)
                }
            } else if app.hasAccount {
                // Signed in, but `me()` hasn't come back — offline, or the
                // server is unreachable. The session is deliberately kept, so
                // say that instead of showing a sign-in button that implies the
                // account is gone.
                unreachableAccountRow
            } else {
                signInForm
            }
        } header: {
            sectionHeader("Account")
        }
    }

    private var syncSection: some View {
        Section {
            if app.pendingUploadCount > 0 {
                Label(
                    "\(app.pendingUploadCount) recordings waiting to sync",
                    systemImage: "icloud.and.arrow.up"
                )
                .foregroundStyle(Theme.warning)
                Button("Retry sync now") {
                    Task { await app.syncPendingUploads() }
                }
                if let stuckUpload {
                    FeedbackPromptCard(
                        trigger: .syncFailed,
                        recordingId: stuckUpload.id,
                        text: Text("This recording keeps failing to sync."),
                        send: {
                            self.stuckUpload = nil
                            sendSyncReport(stuckUpload)
                        },
                        close: { self.stuckUpload = nil })
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 12))
                }
            } else {
                Label("Everything is synced", systemImage: "checkmark.icloud")
                    .foregroundStyle(Theme.success)
            }
        } header: {
            sectionHeader("Sync")
        } footer: {
            sectionFooter("When the network drops, the server goes quiet, or you run out of quota, the phone holds on to finished recordings until they sync.")
        }
    }

    /// `sync_failed`: the oldest queued recording that has failed three times
    /// running or waited a day, if it may still be asked about. Latched on
    /// appearing rather than recomputed per render, because going on screen is
    /// what spends the prompt's one showing for that recording.
    private func findStuckUpload() {
        guard stuckUpload == nil else { return }
        stuckUpload = MeetingUploader.stuckUploads().first {
            FeedbackCenter.shared.mayOffer(.syncFailed, recordingId: $0.id)
        }
    }

    private func sendSyncReport(_ stuck: MeetingUploader.StuckUpload) {
        let context = FeedbackDiagnostics.Context(
            recordingId: stuck.id, recordingDurationMs: Int(stuck.durationMs),
            transcriptSegments: stuck.segmentCount,
            syncLastError: stuck.lastError)
        Task {
            await FeedbackCenter.shared.send(.syncFailed, recordingId: stuck.id, context: context)
        }
    }

    // MARK: feedback & diagnostics

    /// 「回饋與診斷」: the in-app report (which replaced the old "Support &
    /// feedback" link to the website — the FAQ that link led to is inside the
    /// report sheet now) and the one standing choice about what leaves the
    /// phone without a tap. The footnote is the whole of what a crash report
    /// is, stated where the switch is rather than in a policy page.
    private var feedbackSection: some View {
        Section {
            Button {
                FeedbackCenter.shared.presentReport(.manual)
            } label: {
                Label("Report a problem", systemImage: "exclamationmark.bubble")
            }
            Toggle("Send crash reports automatically", isOn: $autoSendCrashReports)
        } header: {
            sectionHeader("Feedback & diagnostics")
        } footer: {
            sectionFooter("Only the app version, device model, and where it crashed. Never your recordings or transcripts.")
        }
    }

    @ViewBuilder
    private var unreachableAccountRow: some View {
        Label(
            "Can't reach the server right now. Account details refresh automatically.",
            systemImage: "wifi.exclamationmark"
        )
        .font(.parley.subheadline)
        .foregroundStyle(Theme.warning)
        Button("Refresh") {
            Task { await app.refreshSession() }
        }
        Button("Sign out", role: .destructive) {
            Task { await app.signOut() }
        }
    }

    /// One button → the hosted `/sign-in` page (email+password / Google /
    /// Apple, all on our origin). The app never renders credential fields.
    ///
    /// A plain row button, which in a grouped `Form` draws as tinted text — the
    /// platform's own shape for an action in a settings list. The filled
    /// gradient slab this used to be belonged on the onboarding screen, where the
    /// same action really is the only thing on the page; in here it was a banner.
    @ViewBuilder
    private var signInForm: some View {
        Button {
            app.signIn()
        } label: {
            HStack(spacing: 8) {
                if app.signingIn { ProgressView().controlSize(.mini) }
                Text("Sign in or create an account")
                    .font(.parley.bodyEmphasized)
            }
        }
        .disabled(app.signingIn)
        if let err = app.signInError {
            Text(verbatim: err).font(.parley.caption).foregroundStyle(Theme.destructive)
        }
        Text("Opens Parley's sign-in page — email and password, Google, and Apple. Once you're in you get live transcription with no API key, plus recording and transcript sync.")
            .font(.parley.caption)
            .foregroundStyle(Color(.secondaryLabel))
    }

    /// The initial on a system fill — a grouped list's own way of standing an
    /// avatar in for a photo, rather than a punched-out hole in a tinted row.
    private func avatar(_ user: CloudUser) -> some View {
        Circle()
            .fill(Color(.tertiarySystemFill))
            .frame(width: 40, height: 40)
            .overlay(
                Text(String((user.name ?? user.email).prefix(1)).uppercased())
                    .font(.parley.callout.weight(.semibold))
                    .foregroundStyle(Color(.label)))
    }

    private func roleLabel(_ role: String?) -> String {
        switch role {
        case "owner": return String(localized: "Owner")
        case "admin": return String(localized: "Admin")
        default: return String(localized: "Member")
        }
    }

    // MARK: default save destination

    private var saveDestinationSection: some View {
        Section {
            Picker("Default save location", selection: destinationBinding) {
                Text("Personal").tag("personal")
                ForEach(personalFolders.filter { $0.orgId == nil }) { f in
                    Text("Personal · \(f.name)").tag("personal:\(f.id)")
                }
                ForEach(app.orgs) { org in
                    Text(verbatim: org.name).tag("org:\(org.id)")
                    ForEach(orgFolders[org.id] ?? []) { f in
                        Text(verbatim: "\(org.name) · \(f.name)").tag("org:\(org.id):\(f.id)")
                    }
                }
            }
            keepAudioRows
        } footer: {
            sectionFooter("Picking an organization still saves the recording to your personal space and shares a copy there — same as the desktop app.")
        }
    }

    /// Where the audio goes, under where the recording goes.
    ///
    /// In this section rather than one of its own because it answers the same
    /// question the picker above it does — where a finished recording ends up —
    /// and the honest answer since the phone started keeping audio is "the cloud,
    /// and here". The explanation is a caption under the toggle rather than the
    /// section footer: the footer is already spoken for by the picker, and a
    /// section can only have one.
    ///
    /// The size row is hidden at zero, so a phone that keeps nothing never shows
    /// a "0 bytes" row with a Remove all button under it that does nothing.
    @ViewBuilder
    private var keepAudioRows: some View {
        VStack(alignment: .leading, spacing: 4) {
            Toggle("Keep audio on this phone", isOn: $keepAudioOnPhone)
            Text("Recordings made here stay on the phone so you can play them back. Recordings from other devices are downloaded when you ask.")
                .font(.parley.caption)
                .foregroundStyle(Color(.secondaryLabel))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 2)
        if downloads.storedBytes > 0 {
            // One string rather than a `LabeledContent`: the size is part of
            // what the row says, not a value on the far side of the row, and at
            // "0 bytes" the row does not exist at all.
            Text("Downloaded audio · \(downloads.storedSizeLabel)")
            Button("Remove all", role: .destructive) {
                showRemoveAudioConfirmation = true
            }
        }
    }

    /// Same serialization the desktop picker uses internally:
    /// `personal` / `personal:<folderId>` / `org:<orgId>` / `org:<orgId>:<folderId>`.
    private var destinationBinding: Binding<String> {
        Binding(
            get: {
                let d = app.defaultSave
                if d.isOrg, let orgId = d.orgId {
                    return d.folderId.map { "org:\(orgId):\($0)" } ?? "org:\(orgId)"
                }
                return d.folderId.map { "personal:\($0)" } ?? "personal"
            },
            set: { raw in
                let parts = raw.split(separator: ":").map(String.init)
                if parts.first == "org", parts.count >= 2 {
                    app.defaultSave = SaveDestination(
                        scope: "org", orgId: parts[1],
                        folderId: parts.count > 2 ? parts[2] : nil)
                } else {
                    app.defaultSave = SaveDestination(
                        scope: "personal", orgId: nil,
                        folderId: parts.count > 1 ? parts[1] : nil)
                }
                // Choosing a real home for every recording to come — a folder
                // or an organization, not the personal root — is filing.
                if app.defaultSave != .personalRoot {
                    GettingStartedStore.shared.mark(.filed)
                }
            })
    }

    // MARK: usage

    @ViewBuilder
    private var usageSection: some View {
        if let quota = app.quota {
            Section {
                quotaBar(
                    label: String(localized: "Transcription hours"),
                    used: (quota.sttSecondsUsed ?? 0) / 3600,
                    limit: (quota.sttSecondsLimit ?? 0) / 3600,
                    unit: String(localized: "hr", comment: "Short unit for hours, e.g. 2.5 / 10 hr"))
                quotaBar(
                    label: String(localized: "AI credits"),
                    used: quota.llmCreditsUsed ?? 0,
                    limit: quota.llmCreditsLimit ?? 0,
                    unit: String(localized: "credits"))
            } header: {
                sectionHeader("Usage (this period)")
            }
        }
    }

    private func quotaBar(label: String, used: Double, limit: Double, unit: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(verbatim: label).font(.parley.subheadlineEmphasized)
                Spacer()
                Text(verbatim: String(format: "%.1f / %.0f %@", used, limit, unit))
                    .font(.parley.caption.monospacedDigit())
                    .foregroundStyle(Color(.secondaryLabel))
            }
            let over = limit > 0 && used >= limit
            ProgressView(value: limit > 0 ? min(used / limit, 1) : 0)
                .tint(over ? Theme.destructive : Theme.primary)
        }
        .padding(.vertical, 6)
    }

    // MARK: appearance / about

    private var appearanceSection: some View {
        Section {
            Picker("Theme", selection: $app.themeRaw) {
                ForEach(AppTheme.allCases) { t in
                    Text(verbatim: t.label).tag(t.rawValue)
                }
            }
            .pickerStyle(.segmented)
        } header: {
            sectionHeader("Appearance")
        }
    }

    // MARK: language

    /// iOS owns per-app language: once a bundle ships more than one localization
    /// the system Settings page for the app grows a Language picker. Rather than
    /// keep a second, competing switch in here — which could only take effect on
    /// the next launch anyway — this row names the current language and opens the
    /// place that actually changes it.
    private var languageSection: some View {
        Section {
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            } label: {
                HStack {
                    Label("Language", systemImage: "globe")
                    Spacer()
                    Text(verbatim: Self.currentLanguageName)
                        .foregroundStyle(Color(.secondaryLabel))
                }
            }
        } footer: {
            sectionFooter("Parley speaks English and Traditional Chinese, and follows your iPhone's language by default. Change it for Parley alone in Settings › Parley › Language.")
        }
    }

    /// The active localization, named in itself — 繁體中文 rather than
    /// "Chinese, Traditional" when that is the language on screen.
    private static var currentLanguageName: String {
        let code = Bundle.main.preferredLocalizations.first ?? "en"
        let locale = Locale(identifier: code)
        return locale.localizedString(forIdentifier: code)?.capitalized(with: locale) ?? code
    }

    // MARK: voice keyboard

    /// Onboarding for the voice keyboard. Deliberately not a wall of steps:
    /// one line on what it does, one button to the place that actually has the
    /// toggles (a keyboard app's own Settings page carries the Keyboards row
    /// and the Allow Full Access switch), and the detailed steps folded away
    /// for the people who want them. iOS gives no API to flip these for the
    /// user, so a jump plus on-demand steps is as far as it goes.
    private var dictationSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 14) {
                    Image(systemName: "mic.fill")
                        .font(.parley.title3)
                        .foregroundStyle(Color(.secondaryLabel))
                        .frame(width: 32)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Type by voice in any app")
                            .font(.parley.headline)
                        Text("Tap the mic on the Parley keyboard and your words land at the cursor.")
                            .font(.parley.caption)
                            .foregroundStyle(Color(.secondaryLabel))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Button("Set up in Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
                .font(.parley.bodyEmphasized)
            }
            .padding(.vertical, 8)

            DisclosureGroup {
                dictationStep(
                    number: 1, title: "Add the keyboard",
                    detail: "In Keyboards → Add New Keyboard, pick Parley Voice.")
                dictationStep(
                    number: 2, title: "Allow Full Access",
                    detail: "Lets your voice reach your Parley account to be transcribed.")
                dictationStep(
                    number: 3, title: "Action Button (optional)",
                    detail: "Map it to Parley Voice Typing and dictation starts without leaving the app you are in — no round trip at all.")
            } label: {
                Text("Set-up steps").font(.parley.subheadlineEmphasized)
            }

            // Directly above the dictionary, because the two are about the same
            // text and run in this order: the model tidies what was said, then
            // the dictionary has the last word over what it did.
            VStack(alignment: .leading, spacing: 4) {
                Picker("Polish with AI", selection: $polishStyle) {
                    ForEach(PolishStyle.allCases, id: \.self) { style in
                        Text(Self.polishStyleLabel(style)).tag(style)
                    }
                }
                Text(Self.polishStyleCaption(polishStyle))
                    .font(.parley.caption)
                    .foregroundStyle(Color(.secondaryLabel))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 2)

            // Below the set-up, because it is only worth anything once the
            // keyboard is in use: the dictionary fills itself from dictation.
            NavigationLink {
                PersonalDictionaryView()
            } label: {
                Label("Personal dictionary", systemImage: "text.book.closed")
            }
        } header: {
            sectionHeader("Voice keyboard")
        } footer: {
            sectionFooter("Fix a word right after dictating it and Parley learns how you say it. What it has learned is in the personal dictionary, where you can also add names it should get right.")
        }
    }

    /// The picker's name for each polish style.
    static func polishStyleLabel(_ style: PolishStyle) -> LocalizedStringKey {
        switch style {
        case .off: "Polish style: off"
        case .tidy: "Polish style: tidy"
        case .concise: "Polish style: concise"
        }
    }

    /// One line under the picker saying what the chosen style does to the
    /// words — the difference between tidy and concise is the whole choice,
    /// so it is spelled out for the one that is selected.
    static func polishStyleCaption(_ style: PolishStyle) -> LocalizedStringKey {
        switch style {
        case .off:
            "Dictation is inserted exactly as it was transcribed."
        case .tidy:
            "Removes filler, fixes slips of the tongue and lays the text out, keeping every sentence you said."
        case .concise:
            "Also cuts verbal tics and pleasantries, leaving the shortest sentences that still mean the same thing."
        }
    }

    // MARK: voice typing history

    /// The switch and the clear for Library › Voice typing (#290), in the same
    /// shape as "Keep audio on this phone": a toggle with its caption, then the
    /// destructive button behind a confirmation. Its own section, directly under
    /// the two voice-keyboard ones, because it is about what they produce — and
    /// because it has to outlive the account gate they sit behind.
    private var dictationHistorySection: some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Toggle("Keep voice typing history", isOn: $keepDictationHistory)
                Text("What you dictate is kept on this phone for 30 days, up to 200 entries, so you can copy it again from Library › Voice typing if it didn't land. It never leaves the phone. Turning this off keeps what is already there until you clear it.")
                    .font(.parley.caption)
                    .foregroundStyle(Color(.secondaryLabel))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 2)
            Button("Clear all", role: .destructive) {
                showClearHistoryConfirmation = true
            }
            .disabled(dictationHistory.entries.isEmpty)
        } header: {
            sectionHeader("Voice typing history")
        }
    }

    // MARK: which keyboards the swipe track carries

    /// The typing panes on the Parley keyboard, beside the voice pane that is
    /// always there.
    ///
    /// Deliberately outside the `hasAccount` gate the two sections above sit in:
    /// typing needs neither an account nor Full Access, which is the whole
    /// reason the keyboard has typing panes at all (App Review 4.4.1). Someone
    /// who has installed the keyboard and never signed in can still choose
    /// which of them to carry.
    private var keyboardsSection: some View {
        Section {
            ForEach(TypingKeyboard.allCases) { keyboard in
                Toggle(Self.keyboardLabel(keyboard), isOn: keyboardBinding(keyboard))
                    // The last one on can't be turned off. A toggle that won't
                    // move says so before the tap; an alert afterwards would be
                    // the same rule delivered as a telling-off.
                    .disabled(enabled == [keyboard])
            }
            // Here rather than beside the personal dictionary's clear, which
            // sits behind the account gate: the 注音 pane learns with no account
            // and no Full Access, so its reset has to be reachable without
            // them too. Always shown — the app cannot see whether a keyboard
            // without Full Access learned anything, and a reset of nothing is
            // harmless.
            Button("Reset Zhuyin learning", role: .destructive) {
                showResetZhuyinConfirmation = true
            }
            .confirmationDialog(
                "Reset Zhuyin learning?", isPresented: $showResetZhuyinConfirmation,
                titleVisibility: .visible
            ) {
                Button("Reset", role: .destructive) {
                    // Deletes the file and bumps the App Group counter, so a
                    // keyboard holding the old memory drops it instead of
                    // writing it back.
                    ZhuyinMemory.requestReset()
                }
            } message: {
                Text("The Bopomofo keyboard forgets every word it learned from the candidates you picked, and suggests in its original order again.")
            }
        } header: {
            sectionHeader("Keyboards")
        } footer: {
            sectionFooter("Swipe sideways on the Parley keyboard to move between the mic and the keyboards you have turned on here. At least one keyboard stays on.")
        }
    }

    private func keyboardBinding(_ keyboard: TypingKeyboard) -> Binding<Bool> {
        Binding(
            get: { enabled.contains(keyboard) },
            set: { on in
                var next = Set(enabled)
                if on { next.insert(keyboard) } else { next.remove(keyboard) }
                guard !next.isEmpty else { return }
                let ordered = TypingKeyboard.allCases.filter(next.contains)
                TypingKeyboards.setEnabled(ordered)
                enabled = ordered
            })
    }

    /// 注音 is named in its own script in the Chinese localization and spelled
    /// out in the English one — "Bopomofo" is what an English speaker searching
    /// for it would type.
    private static func keyboardLabel(_ keyboard: TypingKeyboard) -> LocalizedStringKey {
        switch keyboard {
        case .english: return "English keyboard"
        case .zhuyin: return "Bopomofo keyboard"
        }
    }

    // MARK: clipboard and saved info

    /// What the keyboard's 📋 panel and strip chips may do with the clipboard,
    /// and the way to 常用資訊.
    ///
    /// Both pasteboard reads that happen without a tap — collecting into the
    /// history, and previewing in the strip — are off until switched on here,
    /// and the how-to under them is the part that makes them bearable: iOS
    /// asks "Allow Paste?" every time unless 「從其他 App 貼上」 is 允許.
    private var clipboardSection: some View {
        Section {
            NavigationLink {
                SavedInfoView()
            } label: {
                Label("Saved info", systemImage: "person.text.rectangle")
            }
            VStack(alignment: .leading, spacing: 4) {
                Toggle("Auto-collect clipboard", isOn: clipboardAutoCaptureBinding)
                Text("When the keyboard appears or Parley opens, keep what you copied so the keyboard's 📋 panel can type it again. Passwords, one-time codes and your ID numbers are never kept. Text you paste from the keyboard's top row is kept either way.")
                    .font(.parley.caption)
                    .foregroundStyle(Color(.secondaryLabel))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 2)
            Picker("Keep for", selection: clipboardRetentionBinding) {
                ForEach(ClipboardRetention.allCases) { retention in
                    Text(Self.retentionLabel(retention)).tag(retention)
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Toggle("Preview clipboard in the top row", isOn: clipboardPreviewBinding)
                Text("The keyboard's paste button shows the first few characters of what you copied instead of just \"Paste text\".")
                    .font(.parley.caption)
                    .foregroundStyle(Color(.secondaryLabel))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 2)
            VStack(alignment: .leading, spacing: 6) {
                Text("Stop iOS asking every time")
                    .font(.parley.subheadlineEmphasized)
                Text("Settings › Parley › Paste from Other Apps › Allow. Without it, iOS asks for permission each time Parley reads what you copied.")
                    .font(.parley.caption)
                    .foregroundStyle(Color(.secondaryLabel))
                    .fixedSize(horizontal: false, vertical: true)
                Button("Open in Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
                .font(.parley.subheadlineEmphasized)
            }
            .padding(.vertical, 4)
            Button("Clear clipboard history", role: .destructive) {
                showClearClipboardConfirmation = true
            }
        } header: {
            sectionHeader("Clipboard")
        } footer: {
            sectionFooter("The clipboard history stays on this phone. It is never uploaded, and pinned items are kept until you remove them.")
        }
    }

    private var clipboardAutoCaptureBinding: Binding<Bool> {
        Binding(
            get: { clipboardAutoCapture },
            set: { on in
                ClipboardSettings.setAutoCapture(on)
                clipboardAutoCapture = on
            })
    }

    private var clipboardRetentionBinding: Binding<ClipboardRetention> {
        Binding(
            get: { clipboardRetention },
            set: { value in
                ClipboardSettings.setRetention(value)
                clipboardRetention = value
            })
    }

    private var clipboardPreviewBinding: Binding<Bool> {
        Binding(
            get: { clipboardPreview },
            set: { on in
                ClipboardSettings.setPreviewInStrip(on)
                clipboardPreview = on
            })
    }

    private static func retentionLabel(_ retention: ClipboardRetention) -> LocalizedStringKey {
        switch retention {
        case .oneHour: return "1 hour"
        case .oneDay: return "24 hours"
        case .sevenDays: return "7 days"
        }
    }

    // MARK: the microphone window

    /// The setting the whole of #286 is about, and the one place its cost is
    /// stated. Everything here is written to be read *before* agreeing rather
    /// than explained afterwards: an orange microphone indicator nobody expects
    /// is worse than the app switch this replaces.
    private var micWindowSection: some View {
        Section {
            if dictation.window.isOpen() {
                openWindowRow
            }
            Picker("Keep the microphone ready", selection: micWindowBinding) {
                ForEach(MicWindowLength.allCases) { length in
                    Text(Self.micWindowLabel(length)).tag(length)
                }
            }
            if let problem = dictation.windowProblem {
                Label(problem, systemImage: "exclamationmark.triangle")
                    .font(.parley.caption)
                    .foregroundStyle(Theme.warning)
            }
        } header: {
            sectionHeader("Keeping the microphone ready")
        } footer: {
            sectionFooter("After you dictate, Parley can hold the microphone open for a while, so the next tap on the keyboard's mic types where you already are instead of opening Parley. Even when this is off, Parley keeps the microphone for 30 seconds after each dictation, so dictating again right away stays where you are too.\n\niOS shows the orange microphone dot for the whole time, because Parley really is holding the microphone. It is not listening through it: nothing is recorded, transcribed, or sent until you tap the mic, and sound that arrives before then is thrown away as it comes in. The window ends on its own, and you can end it early here or from the keyboard.")
        }
    }

    /// What is true right now, with the way out next to it. The countdown is a
    /// system timer rather than a string this view refreshes: it is the cheap
    /// way to be accurate to the second, and being accurate about when an open
    /// microphone closes is the point.
    @ViewBuilder
    private var openWindowRow: some View {
        HStack(spacing: 10) {
            Image(systemName: "mic.fill")
                .font(.parley.footnote)
                .foregroundStyle(Theme.micWindow)
            Text("The microphone is open")
                .font(.parley.subheadlineEmphasized)
            Spacer(minLength: 8)
            if let expiresAt = dictation.window.expiresAt {
                Text(expiresAt, style: .timer)
                    .font(.parley.caption.monospacedDigit())
                    .foregroundStyle(Color(.secondaryLabel))
            }
        }
        .padding(.vertical, 2)
        Button("End now") {
            Task { await dictation.endWindow() }
        }
    }

    private var micWindowBinding: Binding<MicWindowLength> {
        Binding(
            get: { dictation.window.length },
            set: { length in Task { await dictation.setWindowLength(length) } })
    }

    /// Spelled out rather than "5 min": this picker is the moment someone
    /// decides how long to leave a microphone open, and an abbreviation is a
    /// worse thing to skim.
    private static func micWindowLabel(_ length: MicWindowLength) -> LocalizedStringKey {
        switch length {
        case .off: return "Off"
        case .fiveMinutes: return "5 minutes"
        case .fifteenMinutes: return "15 minutes"
        case .oneHour: return "1 hour"
        }
    }

    private func dictationStep(number: Int, title: LocalizedStringKey, detail: LocalizedStringKey)
        -> some View
    {
        HStack(alignment: .top, spacing: 12) {
            // Just the number. The blue disc it used to sit in made three
            // set-up steps look like three things to press.
            Text(number, format: .number)
                .font(.parley.subheadlineEmphasized.monospacedDigit())
                .foregroundStyle(Color(.secondaryLabel))
                .frame(width: 16, alignment: .trailing)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.parley.subheadlineEmphasized)
                Text(detail).font(.parley.caption).foregroundStyle(Color(.secondaryLabel))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 5)
    }

    private var aboutSection: some View {
        Section {
            LabeledContent("Version", value: Bundle.main.shortVersion)
            Link("Parley for Mac", destination: URL(string: "https://parley.tw")!)
            Link("Privacy Policy", destination: URL(string: "https://parley.tw/privacy/")!)
            // Brings the Library's checklist back, unticked — for someone who
            // closed it with "Not now" and wants the lap after all.
            Button("Show the getting-started list again") {
                showGettingStartedAgain()
            }
        } footer: {
            sectionFooter("Live coaching and deep analysis live in the desktop app; the phone handles recording, transcribing, and reading back in-person meetings. On the Mac, Claude Code can also read your whole recording library over MCP.")
        }
    }

    /// Reset the checklist and go and show it.
    ///
    /// Resetting alone was the bug: the list lives on another tab, so the tap
    /// changed nothing anyone could see, and the owner concluded the button did
    /// nothing. The reset now ends where its result is — the Library, scrolled
    /// to the list — with a success haptic for the tap itself.
    ///
    /// Nothing to pop on this side: the button is on Settings' root page, so
    /// Settings has no pushed screen when it is pressed. The Library pops its
    /// own stack when it takes the request (`LibraryView.revealChecklist`).
    private func showGettingStartedAgain() {
        GettingStartedStore.shared.reset()
        // The lap starts over from the sample: out of the Library with its
        // rename, its folder and its ticks, back to "Walk through it with the
        // sample recording". The bundle keeps the files.
        SampleRecordingStore.shared.remove()
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        router.showGettingStarted()
    }

    #if DEBUG
        private var debugSection: some View {
            Section {
                TextField("Paste a desktop session token", text: $devToken)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Use this token") {
                    Task {
                        await app.adoptToken(devToken)
                        devToken = ""
                    }
                }
                .disabled(devToken.isEmpty)
            } header: {
                sectionHeader("Developer")
            }
        }
    #endif

    private func loadFolders() async {
        guard app.signedIn else { return }
        #if DEBUG
            if ScreenshotDemo.servesFixtures {
                personalFolders = ScreenshotDemo.folders
                return
            }
        #endif
        personalFolders = (try? await app.cloud.listFolders()) ?? []
        for org in app.orgs {
            orgFolders[org.id] = (try? await app.cloud.orgFolders(orgId: org.id)) ?? []
        }
    }

    private func deleteAccount() async {
        deletingAccount = true
        deleteAccountError = nil
        defer { deletingAccount = false }
        do {
            try await app.deleteAccount()
        } catch let error as CloudError where error.status == 409 {
            deleteAccountError = String(
                localized:
                    "You still own at least one organization. Transfer or delete it in the desktop app first, then delete your account."
            )
        } catch {
            deleteAccountError = String(
                localized: "Your account was not deleted. Check your connection and try again.")
        }
    }
}

/// The settings page's section grammar, shared by `SettingsView` and the screens
/// it pushes so a pushed screen doesn't quietly fall back to a different face.
///
/// Both of these are now **only** a font. The colour and the casing come from
/// the system, because a grouped list's header is one of the few pieces of
/// chrome a phone owner reads without looking at it, and a brand-blue one — which
/// is what used to be here — reads as a link. The face stays DM Sans so a header
/// doesn't sit in SF Pro above rows that don't.
enum SettingsSection {
    static func header(_ title: LocalizedStringKey) -> some View {
        Text(title).font(.parley.footnote)
    }

    static func footer(_ text: LocalizedStringKey) -> some View {
        Text(text).font(.parley.footnote)
    }
}

extension Bundle {
    var shortVersion: String {
        (infoDictionary?["CFBundleShortVersionString"] as? String) ?? "dev"
    }
}
