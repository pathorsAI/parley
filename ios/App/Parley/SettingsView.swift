import ParleyKit
import SwiftUI

/// Settings — phone-sized mirror of the desktop Settings window's cloud
/// sections: 帳號 (sign in/out)、預設儲存位置、外觀 (theme)、用量 (hosted
/// quota bars). Provider/transcription config stays desktop-side: the phone
/// rides the hosted providers with the account token (design doc D6).
struct SettingsView: View {
    @EnvironmentObject private var app: AppState
    @State private var personalFolders: [CloudFolder] = []
    @State private var orgFolders: [String: [CloudFolder]] = [:]
    #if DEBUG
        @State private var devToken = ""
    #endif

    var body: some View {
        NavigationStack {
            Form {
                accountSection
                if app.signedIn {
                    saveDestinationSection
                    usageSection
                }
                appearanceSection
                aboutSection
                #if DEBUG
                    debugSection
                #endif
            }
            .navigationTitle("設定")
            .task { await loadFolders() }
        }
    }

    // MARK: account

    private var accountSection: some View {
        Section("帳號") {
            if let user = app.user {
                HStack(spacing: 12) {
                    avatar(user)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(user.name ?? user.email).font(.body.weight(.medium))
                        Text(user.email).font(.caption).foregroundStyle(Theme.mutedForeground)
                    }
                }
                if !app.orgs.isEmpty {
                    ForEach(app.orgs) { org in
                        HStack {
                            Label(org.name, systemImage: "person.2")
                                .foregroundStyle(Theme.org)
                            Spacer()
                            Text(roleLabel(org.role))
                                .font(.caption)
                                .foregroundStyle(Theme.mutedForeground)
                        }
                    }
                }
                Button("登出", role: .destructive) {
                    Task { await app.signOut() }
                }
            } else {
                Button {
                    app.signIn()
                } label: {
                    HStack {
                        if app.signingIn { ProgressView().padding(.trailing, 6) }
                        Text("使用 Google 登入")
                    }
                }
                .disabled(app.signingIn)
                if let err = app.authError {
                    Text(err).font(.caption).foregroundStyle(Theme.destructive)
                }
                Text("登入後即可即時轉錄（免帶 API key）、同步錄音與逐字稿。")
                    .font(.caption)
                    .foregroundStyle(Theme.mutedForeground)
            }
        }
    }

    private func avatar(_ user: CloudUser) -> some View {
        Circle()
            .fill(Theme.muted)
            .frame(width: 36, height: 36)
            .overlay(
                Text(String((user.name ?? user.email).prefix(1)).uppercased())
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(Theme.mutedForeground))
    }

    private func roleLabel(_ role: String?) -> String {
        switch role {
        case "owner": return "擁有者"
        case "admin": return "管理員"
        default: return "成員"
        }
    }

    // MARK: default save destination

    private var saveDestinationSection: some View {
        Section {
            Picker("預設儲存位置", selection: destinationBinding) {
                Text("個人").tag("personal")
                ForEach(personalFolders.filter { $0.orgId == nil }) { f in
                    Text("個人 · \(f.name)").tag("personal:\(f.id)")
                }
                ForEach(app.orgs) { org in
                    Text(org.name).tag("org:\(org.id)")
                    ForEach(orgFolders[org.id] ?? []) { f in
                        Text("\(org.name) · \(f.name)").tag("org:\(org.id):\(f.id)")
                    }
                }
            }
        } footer: {
            Text("選擇組織時，錄音仍會保存在個人空間，並自動分享一份到該組織——與桌面版行為一致。")
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
            })
    }

    // MARK: usage

    @ViewBuilder
    private var usageSection: some View {
        if let quota = app.quota {
            Section("用量（本期）") {
                quotaBar(
                    label: "轉錄時數",
                    used: (quota.sttSecondsUsed ?? 0) / 3600,
                    limit: (quota.sttSecondsLimit ?? 0) / 3600,
                    unit: "小時")
                quotaBar(
                    label: "AI 額度",
                    used: quota.llmCreditsUsed ?? 0,
                    limit: quota.llmCreditsLimit ?? 0,
                    unit: "credits")
            }
        }
    }

    private func quotaBar(label: String, used: Double, limit: Double, unit: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(label).font(.subheadline)
                Spacer()
                Text(String(format: "%.1f / %.0f %@", used, limit, unit))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(Theme.mutedForeground)
            }
            let over = limit > 0 && used >= limit
            ProgressView(value: limit > 0 ? min(used / limit, 1) : 0)
                .tint(over ? Theme.destructive : Theme.foreground)
        }
        .padding(.vertical, 2)
    }

    // MARK: appearance / about

    private var appearanceSection: some View {
        Section("外觀") {
            Picker("主題", selection: $app.themeRaw) {
                ForEach(AppTheme.allCases) { t in
                    Text(t.label).tag(t.rawValue)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    private var aboutSection: some View {
        Section {
            LabeledContent("版本", value: Bundle.main.shortVersion)
            Link("Parley 桌面版", destination: URL(string: "https://parley.tw")!)
        } footer: {
            Text("即時教練與深度分析以桌面版為主；手機負責面對面會議的錄音、轉錄與瀏覽。")
        }
    }

    #if DEBUG
        private var debugSection: some View {
            Section("開發") {
                TextField("貼上桌機的 session token", text: $devToken)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("使用此 token") {
                    Task {
                        await app.adoptToken(devToken)
                        devToken = ""
                    }
                }
                .disabled(devToken.isEmpty)
            }
        }
    #endif

    private func loadFolders() async {
        guard app.signedIn else { return }
        personalFolders = (try? await app.cloud.listFolders()) ?? []
        for org in app.orgs {
            orgFolders[org.id] = (try? await app.cloud.orgFolders(orgId: org.id)) ?? []
        }
    }
}

extension Bundle {
    var shortVersion: String {
        (infoDictionary?["CFBundleShortVersionString"] as? String) ?? "dev"
    }
}
