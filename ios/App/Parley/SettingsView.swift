import ParleyKit
import SwiftUI

/// Settings — phone-sized mirror of the desktop Settings window's cloud
/// sections: account (sign in/out), default save location, appearance, and the
/// hosted quota bars. Provider/transcription config stays desktop-side: the
/// phone rides the hosted providers with the account token (design doc D6).
struct SettingsView: View {
    @EnvironmentObject private var app: AppState
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
                    }
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

    /// Section headers as the landing site's eyebrow — brand blue and in the
    /// sentence case they were written in, rather than the system's grey
    /// all-caps. It is the one place a `Form` lets a brand speak.
    ///
    /// `primary` rather than `brand`, because this is small text: brand blue is
    /// exactly what the dark palette swaps for sky, on the grounds that it
    /// cannot be read on a navy-black page.
    private func sectionHeader(_ title: LocalizedStringKey) -> some View {
        Text(title)
            .font(.parley.footnote.weight(.semibold))
            .foregroundStyle(Theme.primary)
            .textCase(nil)
    }

    /// Footers are the quiet half of a settings page: same DM Sans, one step
    /// down, muted.
    private func sectionFooter(_ text: LocalizedStringKey) -> some View {
        Text(text)
            .font(.parley.footnote)
            .foregroundStyle(Theme.mutedForeground)
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
                    detail: "Map it to Parley Voice Typing to start dictation without switching keyboards.")
            } label: {
                Text("Set-up steps").font(.parley.subheadlineEmphasized)
            }
        } header: {
            sectionHeader("Voice keyboard")
        }
        .listRowBackground(Theme.tintedSurface)
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

extension Bundle {
    var shortVersion: String {
        (infoDictionary?["CFBundleShortVersionString"] as? String) ?? "dev"
    }
}
