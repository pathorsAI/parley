import ParleyKit
import SwiftUI

/// Library — phone mirror of the desktop History window: personal + org
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
    #if DEBUG
        @ObservedObject private var demo = ScreenshotDemo.shared
    #endif

    var body: some View {
        NavigationStack {
            Group {
                if !app.signedIn {
                    unavailable
                } else {
                    list
                }
            }
            .background(Theme.background)
            .navigationTitle("Library")
            .toolbar { scopeMenu }
            .searchable(text: $search, prompt: Text("Search titles and snippets"))
            .refreshable { await load() }
            .task(id: "\(scope ?? "personal")-\(app.signedIn)") { await load() }
            // `parley://demo/transcript` pushes the demo recording, so the
            // transcript frame is captured through the real navigation stack
            // (back chevron and all) rather than as a detached view.
            #if DEBUG
                .navigationDestination(isPresented: $demo.showTranscript) {
                    RecordingDetailView(summary: ScreenshotDemo.featured, orgId: nil)
                }
            #endif
        }
    }

    /// The library is the account's cloud recordings, so it needs a confirmed
    /// session — not just a stored token. Holding a token but failing `me()`
    /// means offline, which is a different message from being signed out.
    private var unavailable: some View {
        let title: String =
            app.hasAccount
            ? String(localized: "Can't reach the cloud right now")
            : String(localized: "Not signed in")
        let detail: String =
            app.hasAccount
            ? String(localized: "Your recordings load automatically once the network is back.")
            : String(localized: "Sign in under Settings → Account and your cloud recordings show up here.")
        return ContentUnavailableView(
            title, systemImage: "icloud.slash", description: Text(detail))
    }

    // MARK: scope switcher (desktop sidebar, phone-sized)

    private var scopeMenu: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button {
                    scope = nil
                    folderFilter = nil
                } label: {
                    Label("Personal", systemImage: scope == nil ? "checkmark" : "folder")
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
                    Text(verbatim: scopeName)
                }
                .font(.subheadline)
                .foregroundStyle(scope == nil ? Theme.foreground : Theme.org)
            }
        }
    }

    private var scopeName: String {
        scope.flatMap { id in app.orgs.first { $0.id == id }?.name }
            ?? String(localized: "Personal")
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
                    Button("Delete", systemImage: "trash", role: .destructive) {
                        Task { await remove(rec) }
                    }
                }
                .contextMenu { actions(for: rec) }
                .disabled(busyId == rec.id)
                .opacity(busyId == rec.id ? 0.5 : 1)
            }
            if !loading && filtered.isEmpty && error == nil {
                Text(search.isEmpty ? "No recordings here yet." : "No matches.")
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
                chip(String(localized: "All"), selected: folderFilter == nil) { folderFilter = nil }
                chip(String(localized: "Unfiled"), selected: folderFilter == "root") {
                    folderFilter = "root"
                }
                ForEach(folders) { f in
                    chip(f.name, selected: folderFilter == f.id) { folderFilter = f.id }
                }
            }
            .padding(.vertical, 2)
        }
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    /// `label` is either an already-localized chip name or a user-created folder
    /// name, so it renders verbatim either way.
    private func chip(_ label: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(verbatim: label)
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
            Menu("Move to folder") {
                Button("Unfiled (top level)") { Task { await moveToFolder(rec, folderId: nil) } }
                ForEach(folders) { f in
                    Button(f.name) { Task { await moveToFolder(rec, folderId: f.id) } }
                }
            }
        }
        if scope == nil && !app.orgs.isEmpty {
            Menu("Share to organization (copy)") {
                ForEach(app.orgs) { org in
                    Button(org.name) { Task { await shareToOrg(rec, org: org, thenDelete: false) } }
                }
            }
            Menu("Move to organization") {
                ForEach(app.orgs) { org in
                    Button(org.name) { Task { await shareToOrg(rec, org: org, thenDelete: true) } }
                }
            }
        }
        Button("Delete", systemImage: "trash", role: .destructive) {
            Task { await remove(rec) }
        }
    }

    // MARK: data ops

    private func load() async {
        guard app.signedIn else { return }
        #if DEBUG
            if ScreenshotDemo.servesFixtures {
                recordings = ScreenshotDemo.recordings
                folders = ScreenshotDemo.folders
                loading = false
                return
            }
        #endif
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
            error =
                e.isAuthExpired
                ? String(localized: "Your session expired. Please sign in again.")
                : String(localized: "Couldn't load (\(e.status))")
        } catch {
            self.error = String(localized: "Couldn't load — offline or the server isn't responding")
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
            self.error = String(localized: "Move failed: \(error.localizedDescription)")
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
            error = String(localized: "You don't have permission to share to “\(org.name)”")
        } catch {
            self.error = String(localized: "Share failed: \(error.localizedDescription)")
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
            error = String(localized: "Only the uploader or an admin can delete this recording")
        } catch {
            self.error = String(localized: "Delete failed: \(error.localizedDescription)")
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
                Text(
                    verbatim: summary.title.isEmpty
                        ? String(localized: "Untitled recording") : summary.title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(2)
            }
            if let snippet = summary.snippet, !snippet.isEmpty {
                Text(verbatim: snippet)
                    .font(.caption)
                    .foregroundStyle(Theme.mutedForeground)
                    .lineLimit(2)
            }
            // Everything here is short and fixed except the folder name, so the
            // fixed parts are pinned and only the folder is allowed to
            // truncate. Without this the row wraps mid-value — "18:4 / 2" for a
            // duration, "New busi- / ness" for a folder — which it did in both
            // languages, worst in Chinese where the labels are widest.
            HStack(spacing: 10) {
                Label(
                    RecordingDetailView.duration(summary.durationMs), systemImage: "clock"
                )
                .fixedSize()
                if let n = summary.speakerCount, n > 0 {
                    Label("\(n)", systemImage: "person.2").fixedSize()
                }
                if let n = summary.findingsCount, n > 0 {
                    Label("\(n)", systemImage: "sparkles").fixedSize()
                }
                if let fid = summary.folderId, let f = folders.first(where: { $0.id == fid }) {
                    Label(f.name, systemImage: "folder")
                        .truncationMode(.tail)
                }
                Spacer(minLength: 4)
                Text(verbatim: Self.dateLabel(summary.createdAt)).fixedSize()
                if summary.hasAudio {
                    Image(systemName: "speaker.wave.2")
                }
            }
            .font(.caption2)
            .lineLimit(1)
            // Under pressure `Label` quietly falls back to icon-only, which
            // leaves a row of glyphs with no values at all — worse than the
            // wrapping it replaced. Pin the style so the numbers always show.
            .labelStyle(.titleAndIcon)
            .foregroundStyle(Theme.mutedForeground)
        }
        .padding(.vertical, 3)
    }

    private var badge: some View {
        let live = summary.source == "live"
        return Text(live ? "LIVE" : "UPLOAD")
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(
                (live ? Theme.recording : Theme.org).opacity(0.15),
                in: RoundedRectangle(cornerRadius: 5))
            .foregroundStyle(live ? Theme.recording : Theme.org)
    }

    /// Locale-formatted rather than one hard-coded `M/d HH:mm`: an English phone
    /// expects Aug 9, 3:20 PM where a Chinese one expects 8月9日 下午3:20.
    static func dateLabel(_ epochMs: Double) -> String {
        Date(timeIntervalSince1970: epochMs / 1000)
            .formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }
}
