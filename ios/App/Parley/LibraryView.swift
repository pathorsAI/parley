import ParleyKit
import SwiftUI

/// 錄音庫 — phone mirror of the desktop History window: personal + org
/// scopes, one-level folders, and the same move semantics:
/// - share to org  = server-side COPY (original untouched)
/// - move to org   = share, then delete the personal original (that order —
///                   a mid-way failure must leave the original intact)
/// - personal folder move = meta re-push (POST full upsert)
/// - org folder move      = dedicated PATCH …/folder
struct LibraryView: View {
    @EnvironmentObject private var app: AppState

    /// nil = personal scope; else an org id.
    @State private var scope: String?
    @State private var folderFilter: String?
    @State private var recordings: [CloudRecordingSummary] = []
    @State private var folders: [CloudFolder] = []
    @State private var loading = false
    @State private var error: String?
    @State private var busyId: String?
    @State private var search = ""

    var body: some View {
        NavigationStack {
            Group {
                if !app.signedIn {
                    ContentUnavailableView(
                        "尚未登入", systemImage: "icloud.slash",
                        description: Text("到「設定 → 帳號」登入後，這裡會列出你在雲端的錄音。"))
                } else {
                    list
                }
            }
            .background(Theme.background)
            .navigationTitle("錄音庫")
            .toolbar { scopeMenu }
            .searchable(text: $search, prompt: "搜尋標題或摘要")
            .refreshable { await load() }
            .task(id: "\(scope ?? "personal")-\(app.signedIn)") { await load() }
        }
    }

    // MARK: scope switcher (desktop sidebar, phone-sized)

    private var scopeMenu: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button {
                    scope = nil
                    folderFilter = nil
                } label: {
                    Label("個人", systemImage: scope == nil ? "checkmark" : "folder")
                }
                ForEach(app.orgs) { org in
                    Button {
                        scope = org.id
                        folderFilter = nil
                    } label: {
                        Label(
                            org.name,
                            systemImage: scope == org.id ? "checkmark" : "person.2")
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: scope == nil ? "folder" : "person.2")
                    Text(scopeName)
                }
                .font(.subheadline)
                .foregroundStyle(scope == nil ? Theme.foreground : Theme.org)
            }
        }
    }

    private var scopeName: String {
        scope.flatMap { id in app.orgs.first { $0.id == id }?.name } ?? "個人"
    }

    // MARK: list

    private var list: some View {
        List {
            if !folders.isEmpty {
                folderChips
            }
            if let error {
                Text(error).font(.caption).foregroundStyle(Theme.destructive)
            }
            ForEach(filtered) { rec in
                NavigationLink {
                    RecordingDetailView(summary: rec, orgId: scope)
                } label: {
                    RecordingCard(summary: rec, folders: folders)
                }
                .swipeActions(edge: .trailing) {
                    Button("刪除", systemImage: "trash", role: .destructive) {
                        Task { await remove(rec) }
                    }
                }
                .contextMenu { actions(for: rec) }
                .disabled(busyId == rec.id)
                .opacity(busyId == rec.id ? 0.5 : 1)
            }
            if !loading && filtered.isEmpty && error == nil {
                Text(search.isEmpty ? "這裡還沒有錄音。" : "沒有符合的結果。")
                    .font(.subheadline)
                    .foregroundStyle(Theme.mutedForeground)
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .overlay { if loading && recordings.isEmpty { ProgressView() } }
    }

    private var folderChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip("全部", selected: folderFilter == nil) { folderFilter = nil }
                chip("未分類", selected: folderFilter == "root") { folderFilter = "root" }
                ForEach(folders) { f in
                    chip(f.name, selected: folderFilter == f.id) { folderFilter = f.id }
                }
            }
            .padding(.vertical, 2)
        }
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    private func chip(_ label: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.caption.weight(selected ? .semibold : .regular))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(selected ? Theme.primary : Theme.muted, in: Capsule())
                .foregroundStyle(selected ? Theme.primaryForeground : Theme.foreground)
        }
        .buttonStyle(.plain)
    }

    private var filtered: [CloudRecordingSummary] {
        var items = recordings
        if let folderFilter {
            // Desktop orphan→root rule: an id not in the live folder list
            // renders at root.
            let live = Set(folders.map(\.id))
            items = items.filter { rec in
                let fid = rec.folderId.flatMap { live.contains($0) ? $0 : nil }
                return folderFilter == "root" ? fid == nil : fid == folderFilter
            }
        }
        if !search.isEmpty {
            items = items.filter {
                $0.title.localizedCaseInsensitiveContains(search)
                    || ($0.snippet ?? "").localizedCaseInsensitiveContains(search)
            }
        }
        return items.sorted { $0.createdAt > $1.createdAt }
    }

    // MARK: actions (mirror of the desktop MoveMenu / ShareMenu / MoveDialog)

    @ViewBuilder
    private func actions(for rec: CloudRecordingSummary) -> some View {
        if !folders.isEmpty {
            Menu("移到資料夾") {
                Button("未分類（根目錄）") { Task { await moveToFolder(rec, folderId: nil) } }
                ForEach(folders) { f in
                    Button(f.name) { Task { await moveToFolder(rec, folderId: f.id) } }
                }
            }
        }
        if scope == nil && !app.orgs.isEmpty {
            Menu("分享到組織（複製）") {
                ForEach(app.orgs) { org in
                    Button(org.name) { Task { await shareToOrg(rec, org: org, thenDelete: false) } }
                }
            }
            Menu("搬移到組織") {
                ForEach(app.orgs) { org in
                    Button(org.name) { Task { await shareToOrg(rec, org: org, thenDelete: true) } }
                }
            }
        }
        Button("刪除", systemImage: "trash", role: .destructive) {
            Task { await remove(rec) }
        }
    }

    // MARK: data ops

    private func load() async {
        guard app.signedIn else { return }
        loading = true
        error = nil
        do {
            if let orgId = scope {
                async let r = app.cloud.orgRecordings(orgId: orgId)
                async let f = app.cloud.orgFolders(orgId: orgId)
                recordings = try await r
                folders = try await f
            } else {
                async let r = app.cloud.listRecordings()
                async let f = app.cloud.listFolders()
                recordings = try await r
                folders = try await f.filter { $0.orgId == nil }
            }
        } catch let e as CloudError {
            error = e.isAuthExpired ? "登入已過期，請重新登入。" : "載入失敗（\(e.status)）"
        } catch {
            self.error = "載入失敗：離線或伺服器無回應"
        }
        loading = false
    }

    /// Personal: meta re-push (full POST upsert). Org: dedicated PATCH.
    private func moveToFolder(_ rec: CloudRecordingSummary, folderId: String?) async {
        busyId = rec.id
        defer { busyId = nil }
        do {
            if let orgId = scope {
                try await app.cloud.moveOrgRecordingToFolder(
                    orgId: orgId, id: rec.id, folderId: folderId)
            } else {
                var meta = try await app.cloud.recordingMeta(id: rec.id)
                meta.folderId = folderId
                var summary = rec
                summary.folderId = folderId
                try await app.cloud.pushRecording(id: rec.id, summary: summary, meta: meta)
            }
            await load()
        } catch {
            self.error = "搬移失敗：\(error.localizedDescription)"
        }
    }

    /// Copy first; delete the original only after the copy succeeded.
    private func shareToOrg(_ rec: CloudRecordingSummary, org: CloudOrg, thenDelete: Bool) async {
        busyId = rec.id
        defer { busyId = nil }
        do {
            try await app.cloud.shareRecording(id: rec.id, orgId: org.id, folderId: nil)
            if thenDelete {
                try await app.cloud.deleteRecording(id: rec.id)
            }
            await load()
        } catch let e as CloudError where e.status == 403 {
            error = "沒有權限分享到「\(org.name)」"
        } catch {
            self.error = "分享失敗：\(error.localizedDescription)"
        }
    }

    private func remove(_ rec: CloudRecordingSummary) async {
        busyId = rec.id
        defer { busyId = nil }
        do {
            if let orgId = scope {
                try await app.cloud.deleteOrgRecording(orgId: orgId, id: rec.id)
            } else {
                try await app.cloud.deleteRecording(id: rec.id)
            }
            recordings.removeAll { $0.id == rec.id }
        } catch let e as CloudError where e.status == 403 {
            error = "只有上傳者或管理員可以刪除這筆錄音"
        } catch {
            self.error = "刪除失敗：\(error.localizedDescription)"
        }
    }
}

/// Desktop HistoryCard, phone-sized: type badge, title, date, snippet,
/// duration/speakers/findings meta row.
private struct RecordingCard: View {
    let summary: CloudRecordingSummary
    let folders: [CloudFolder]

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                badge
                Text(summary.title.isEmpty ? "未命名錄音" : summary.title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(2)
            }
            if let snippet = summary.snippet, !snippet.isEmpty {
                Text(snippet)
                    .font(.caption)
                    .foregroundStyle(Theme.mutedForeground)
                    .lineLimit(2)
            }
            HStack(spacing: 10) {
                Label(
                    RecordingDetailView.duration(summary.durationMs), systemImage: "clock")
                if let n = summary.speakerCount, n > 0 {
                    Label("\(n)", systemImage: "person.2")
                }
                if let n = summary.findingsCount, n > 0 {
                    Label("\(n)", systemImage: "sparkles")
                }
                if let fid = summary.folderId, let f = folders.first(where: { $0.id == fid }) {
                    Label(f.name, systemImage: "folder")
                }
                Spacer()
                Text(Self.dateLabel(summary.createdAt))
                if summary.hasAudio {
                    Image(systemName: "speaker.wave.2")
                }
            }
            .font(.caption2)
            .foregroundStyle(Theme.mutedForeground)
        }
        .padding(.vertical, 3)
    }

    private var badge: some View {
        let live = summary.source == "live"
        return Text(live ? "LIVE" : "上傳")
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(
                (live ? Theme.recording : Theme.org).opacity(0.15),
                in: RoundedRectangle(cornerRadius: 5))
            .foregroundStyle(live ? Theme.recording : Theme.org)
    }

    static func dateLabel(_ epochMs: Double) -> String {
        let d = Date(timeIntervalSince1970: epochMs / 1000)
        let fmt = DateFormatter()
        fmt.dateFormat = "M/d HH:mm"
        return fmt.string(from: d)
    }
}
