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
    @State private var showDeleteConfirmation = false
    @State private var deletingAccount = false
    @State private var deleteAccountError: String?
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
                // Sync reads only on-device state, so it stays available while
                // offline — that is exactly when someone needs to see that a
                // finished recording is queued rather than lost.
                if app.hasAccount {
                    syncSection
                }
                if app.hasAccount {
                    dictationSection
                }
                appearanceSection
                aboutSection
                #if DEBUG
                    debugSection
                #endif
            }
            .navigationTitle("設定")
            .task { await loadFolders() }
            .confirmationDialog(
                "永久刪除帳號？", isPresented: $showDeleteConfirmation,
                titleVisibility: .visible
            ) {
                Button("永久刪除我的帳號與個人資料", role: .destructive) {
                    Task { await deleteAccount() }
                }
            } message: {
                Text("這會永久移除你的 Parley 帳號、個人錄音、逐字稿、資料夾與使用資料。你仍是擁有者的組織必須先移轉或刪除。")
            }
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
                Button("刪除帳號", role: .destructive) {
                    showDeleteConfirmation = true
                }
                .disabled(deletingAccount)
                if let deleteAccountError {
                    Text(deleteAccountError)
                        .font(.caption)
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
        }
    }

    private var syncSection: some View {
        Section {
            if app.pendingUploadCount > 0 {
                Label("\(app.pendingUploadCount) 筆錄音等待同步", systemImage: "icloud.and.arrow.up")
                    .foregroundStyle(Theme.warning)
                Button("立即重試同步") {
                    Task { await app.syncPendingUploads() }
                }
            } else {
                Label("所有錄音都已同步", systemImage: "checkmark.icloud")
                    .foregroundStyle(Theme.success)
            }
        } header: {
            Text("同步")
        } footer: {
            Text("網路中斷、伺服器暫時無回應或額度不足時，手機會保留完成的錄音，直到同步成功。")
        }
    }

    @ViewBuilder
    private var unreachableAccountRow: some View {
        Label("目前連不上伺服器，帳號資訊稍後會自動更新。", systemImage: "wifi.exclamationmark")
            .font(.subheadline)
            .foregroundStyle(Theme.warning)
        Button("重新整理") {
            Task { await app.refreshSession() }
        }
        Button("登出", role: .destructive) {
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
                if app.signingIn { ProgressView().padding(.trailing, 6) }
                Text("登入或註冊")
                    .font(.body.weight(.medium))
                    .frame(maxWidth: .infinity)
            }
        }
        .disabled(app.signingIn)
        if let err = app.signInError {
            Text(err).font(.caption).foregroundStyle(Theme.destructive)
        }
        Text("會開啟 Parley 的登入頁——支援信箱密碼、Google 與 Apple。登入後即可即時轉錄（免帶 API key）、同步錄音與逐字稿。")
            .font(.caption)
            .foregroundStyle(Theme.mutedForeground)
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

    // MARK: voice keyboard

    /// How to turn on the Parley keyboard and the Action Button trigger. Both
    /// live in the system Settings app, so this section explains the steps and
    /// jumps there — iOS gives no API to toggle them for the user.
    private var dictationSection: some View {
        Section {
            dictationStep(
                number: "1", title: "加入 Parley 鍵盤",
                detail: "設定 › 一般 › 鍵盤 › 鍵盤 › 加入新鍵盤，選 Parley 語音。")
            dictationStep(
                number: "2", title: "開啟「允許完整取用權限」",
                detail: "語音要送到你的 Parley 帳號轉錄，需要這項權限才能運作。")
            dictationStep(
                number: "3", title: "（選用）設定動作按鈕免切換直接說",
                detail: "設定 › 動作按鈕 › 快捷指令 › Parley 語音輸入，在任何 App 一按就開始，不用切鍵盤。")
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            } label: {
                Label("打開系統設定", systemImage: "keyboard")
            }
        } header: {
            Text("語音鍵盤")
        } footer: {
            Text("在任何 App 的輸入框切到 Parley 鍵盤，按麥克風就會跳到 Parley 開始聽寫；回到輸入框後，文字會即時打進去。")
        }
    }

    private func dictationStep(number: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(number)
                .font(.caption.weight(.bold).monospacedDigit())
                .foregroundStyle(Theme.primaryForeground)
                .frame(width: 22, height: 22)
                .background(Circle().fill(Theme.primary))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.medium))
                Text(detail).font(.caption).foregroundStyle(Theme.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 2)
    }

    private var aboutSection: some View {
        Section {
            LabeledContent("版本", value: Bundle.main.shortVersion)
            Link("Parley 桌面版", destination: URL(string: "https://parley.tw")!)
            Link("隱私權政策", destination: URL(string: "https://parley.tw/privacy/")!)
            Link("支援與問題回報", destination: URL(string: "https://parley.tw/support/")!)
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

    private func deleteAccount() async {
        deletingAccount = true
        deleteAccountError = nil
        defer { deletingAccount = false }
        do {
            try await app.deleteAccount()
        } catch let error as CloudError where error.status == 409 {
            deleteAccountError = "你仍是至少一個組織的擁有者。請先在桌面版移轉或刪除該組織，再刪除帳號。"
        } catch {
            deleteAccountError = "帳號尚未刪除。請確認網路後再試一次。"
        }
    }
}

extension Bundle {
    var shortVersion: String {
        (infoDictionary?["CFBundleShortVersionString"] as? String) ?? "dev"
    }
}
