import ParleyKit
import SwiftUI

/// Settings — phone-sized mirror of the desktop Settings window's cloud
/// sections: account (sign in/out), default save location, appearance, and the
/// hosted quota bars. Provider/transcription config stays desktop-side: the
/// phone rides the hosted providers with the account token (design doc D6).
struct SettingsView: View {
    @EnvironmentObject private var app: AppState
    /// Only for the microphone-window rows: how long the keyboard's mic stays
    /// ready is settings, but *whether it is open right now* is live state that
    /// belongs to the thing holding it.
    @ObservedObject private var dictation = DictationCoordinator.shared
    /// The keyboard's typing panes. Read once here and written straight through
    /// to the App Group's defaults, which is where the extension looks for them
    /// on every appearance — there is no live binding across a process boundary.
    @State private var enabled = TypingKeyboards.enabled()
    /// The cleanup pass after dictation. Bound here, read raw by the
    /// coordinator: both sides are `UserDefaults.standard`, and the coordinator
    /// has to be able to answer this in the background with no view alive.
    @AppStorage(DictationCoordinator.polishKey) private var polishEnabled = true
    @State private var personalFolders: [CloudFolder] = []
    @State private var orgFolders: [String: [CloudFolder]] = [:]
    @State private var showDeleteConfirmation = false
    @State private var deletingAccount = false
    @State private var deleteAccountError: String?
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
                    keyboardsSection
                    appearanceSection
                    languageSection
                    aboutSection
                    #if DEBUG
                        debugSection
                    #endif
                }
                // One surface rule across the app: white page, pale-blue
                // grouped surfaces on it — the landing site's white body with
                // `--v2-bg` blocks. Not `Theme.card`, which is #FAFAFA against
                // a #FFFFFF page: a 2% step can't carry a card boundary once
                // the hairline separators are gone.
                //
                // The face has to be set on the whole Form: a settings page is
                // mostly rows nobody styles individually (pickers, links,
                // `LabeledContent`), and each one would otherwise quietly draw
                // in the system font next to a heading that doesn't.
                .font(.parley.body)
                .scrollContentBackground(.hidden)
                .background(Theme.background)
                // Settings is a page of short rows; the default height packs
                // them tighter than anything else in the app.
                .environment(\.defaultMinListRowHeight, 48)
                #if DEBUG
                    .onReceive(ScreenshotDemo.shared.$focusKeyboardSection) { focus in
                        // .center, not .top: scrollTo ignores the navigation
                        // bar's safe-area inset, so a top anchor slides the
                        // section header under the blur.
                        if focus { proxy.scrollTo(Self.keyboardSectionID, anchor: .center) }
                    }
                #endif
            }
            .navigationTitle("Settings")
            .task { await loadFolders() }
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
                            .foregroundStyle(Theme.mutedForeground)
                    }
                }
                .padding(.vertical, 4)
                if !app.orgs.isEmpty {
                    ForEach(app.orgs) { org in
                        HStack {
                            Label(org.name, systemImage: "person.2")
                                .foregroundStyle(Theme.org)
                            Spacer()
                            Text(verbatim: roleLabel(org.role))
                                .font(.parley.caption)
                                .foregroundStyle(Theme.mutedForeground)
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
        .listRowBackground(Theme.tintedSurface)
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
            } else {
                Label("Everything is synced", systemImage: "checkmark.icloud")
                    .foregroundStyle(Theme.success)
            }
        } header: {
            sectionHeader("Sync")
        } footer: {
            sectionFooter("When the network drops, the server goes quiet, or you run out of quota, the phone holds on to finished recordings until they sync.")
        }
        .listRowBackground(Theme.tintedSurface)
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
    @ViewBuilder
    private var signInForm: some View {
        Button {
            app.signIn()
        } label: {
            HStack {
                if app.signingIn { ProgressView().tint(Theme.onBrand).padding(.trailing, 6) }
                Text("Sign in or create an account")
                    .font(.parley.bodyEmphasized)
                    .frame(maxWidth: .infinity)
            }
            .padding(.vertical, 12)
            .foregroundStyle(Theme.onBrand)
            .background(Theme.brandGradient, in: RoundedRectangle(cornerRadius: Theme.radius))
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
        .disabled(app.signingIn)
        if let err = app.signInError {
            Text(verbatim: err).font(.parley.caption).foregroundStyle(Theme.destructive)
        }
        Text("Opens Parley's sign-in page — email and password, Google, and Apple. Once you're in you get live transcription with no API key, plus recording and transcript sync.")
            .font(.parley.caption)
            .foregroundStyle(Theme.mutedForeground)
    }

    /// The disc reverses the page rule: the row it sits on is already the pale
    /// blue, so the avatar is the page colour punched back out of it.
    private func avatar(_ user: CloudUser) -> some View {
        Circle()
            .fill(Theme.background)
            .frame(width: 40, height: 40)
            .overlay(
                Text(String((user.name ?? user.email).prefix(1)).uppercased())
                    .font(.parley.callout.weight(.semibold))
                    .foregroundStyle(Theme.primary))
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
        } footer: {
            sectionFooter("Picking an organization still saves the recording to your personal space and shares a copy there — same as the desktop app.")
        }
        .listRowBackground(Theme.tintedSurface)
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
            .listRowBackground(Theme.tintedSurface)
        }
    }

    private func quotaBar(label: String, used: Double, limit: Double, unit: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(verbatim: label).font(.parley.subheadlineEmphasized)
                Spacer()
                Text(verbatim: String(format: "%.1f / %.0f %@", used, limit, unit))
                    .font(.parley.caption.monospacedDigit())
                    .foregroundStyle(Theme.mutedForeground)
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
        .listRowBackground(Theme.tintedSurface)
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
                        .foregroundStyle(Theme.mutedForeground)
                }
            }
        } footer: {
            sectionFooter("Parley speaks English and Traditional Chinese, and follows your iPhone's language by default. Change it for Parley alone in Settings › Parley › Language.")
        }
        .listRowBackground(Theme.tintedSurface)
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
                        .font(.parley.headline)
                        .foregroundStyle(Theme.primary)
                        .frame(width: 44, height: 44)
                        .background(
                            RoundedRectangle(cornerRadius: Theme.radius)
                                .fill(Theme.background))
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Type by voice in any app")
                            .font(.parley.headline)
                        Text("Tap the mic on the Parley keyboard and your words land at the cursor.")
                            .font(.parley.caption)
                            .foregroundStyle(Theme.mutedForeground)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                } label: {
                    Text("Set up in Settings")
                        .font(.parley.bodyEmphasized)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                        .foregroundStyle(Theme.onBrand)
                        .background(
                            Theme.brandGradient,
                            in: RoundedRectangle(cornerRadius: Theme.radius))
                }
                .buttonStyle(.plain)
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
                Toggle("Polish with AI", isOn: $polishEnabled)
                Text("After dictation ends, AI tidies the wording and punctuation before the text is inserted. The original language is preserved.")
                    .font(.parley.caption)
                    .foregroundStyle(Theme.mutedForeground)
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
        .listRowBackground(Theme.tintedSurface)
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
        } header: {
            sectionHeader("Keyboards")
        } footer: {
            sectionFooter("Swipe sideways on the Parley keyboard to move between the mic and the keyboards you have turned on here. At least one keyboard stays on.")
        }
        .listRowBackground(Theme.tintedSurface)
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
            sectionFooter("After you dictate, Parley can hold the microphone open for a while, so the next tap on the keyboard's mic types where you already are instead of opening Parley.\n\niOS shows the orange microphone dot for the whole time, because Parley really is holding the microphone. It is not listening through it: nothing is recorded, transcribed, or sent until you tap the mic, and sound that arrives before then is thrown away as it comes in. The window ends on its own, and you can end it early here or from the keyboard.")
        }
        .listRowBackground(Theme.tintedSurface)
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
                    .foregroundStyle(Theme.mutedForeground)
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
            Text(number, format: .number)
                .font(.parley.caption.weight(.bold).monospacedDigit())
                .foregroundStyle(Theme.onBrand)
                .frame(width: 24, height: 24)
                .background(Circle().fill(Theme.brandGradient))
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.parley.subheadlineEmphasized)
                Text(detail).font(.parley.caption).foregroundStyle(Theme.mutedForeground)
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
            Link("Support & feedback", destination: URL(string: "https://parley.tw/support/")!)
        } footer: {
            sectionFooter("Live coaching and deep analysis live in the desktop app; the phone handles recording, transcribing, and reading back in-person meetings.")
        }
        .listRowBackground(Theme.tintedSurface)
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
            .listRowBackground(Theme.tintedSurface)
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
/// it pushes so a pushed screen doesn't quietly fall back to the system's look.
enum SettingsSection {
    /// Section headers as the landing site's eyebrow — brand blue and in the
    /// sentence case they were written in, rather than the system's grey
    /// all-caps. It is the one place a `Form` lets a brand speak.
    ///
    /// `primary` rather than `brand`, because this is small text: brand blue is
    /// exactly what the dark palette swaps for sky, on the grounds that it
    /// cannot be read on a navy-black page.
    static func header(_ title: LocalizedStringKey) -> some View {
        Text(title)
            .font(.parley.footnote.weight(.semibold))
            .foregroundStyle(Theme.primary)
            .textCase(nil)
    }

    /// Footers are the quiet half of a settings page: same DM Sans, one step
    /// down, muted.
    static func footer(_ text: LocalizedStringKey) -> some View {
        Text(text)
            .font(.parley.footnote)
            .foregroundStyle(Theme.mutedForeground)
    }
}

extension Bundle {
    var shortVersion: String {
        (infoDictionary?["CFBundleShortVersionString"] as? String) ?? "dev"
    }
}
