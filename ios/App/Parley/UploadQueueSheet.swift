import ParleyKit
import SwiftUI

/// The recordings on this phone that the cloud does not have yet, opened from
/// the library's "not uploaded" row.
///
/// Each one can be sent again, handed to the share sheet as its Ogg — so a
/// meeting the server keeps refusing is never trapped on the phone — or
/// deleted for good after a confirmation.
struct UploadQueueSheet: View {
    @EnvironmentObject private var app: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var items: [MeetingUploader.QueueItem] = []
    @State private var busyId: String?
    @State private var retryingAll = false
    @State private var confirmingDelete: MeetingUploader.QueueItem?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button(action: retryAll) {
                        HStack {
                            Text("Retry all")
                            if retryingAll {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(retryingAll || items.isEmpty)
                }
                Section {
                    ForEach(items) { item in
                        row(item)
                    }
                } footer: {
                    Text("Kept on this phone until it uploads or you delete it.")
                }
            }
            .navigationTitle("Not uploaded")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog(
                "Delete this recording?",
                isPresented: Binding(
                    get: { confirmingDelete != nil },
                    set: { if !$0 { confirmingDelete = nil } }),
                titleVisibility: .visible,
                presenting: confirmingDelete
            ) { item in
                Button("Delete", role: .destructive) { delete(item) }
            } message: { _ in
                Text("It has not reached the cloud. Deleting it cannot be undone.")
            }
        }
        .onAppear(perform: reload)
        .onChange(of: app.pendingUploadCount) { _, _ in reload() }
    }

    private func row(_ item: MeetingUploader.QueueItem) -> some View {
        UploadQueueItemRow(item: item, busy: busyId == item.id)
            .swipeActions(edge: .trailing) {
                Button("Delete", systemImage: "trash", role: .destructive) {
                    confirmingDelete = item
                }
            }
            .contextMenu { actions(for: item) }
            .overlay(alignment: .trailing) {
                Menu {
                    actions(for: item)
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .accessibilityLabel(Text("More"))
                }
                .disabled(busyId != nil)
            }
    }

    @ViewBuilder
    private func actions(for item: MeetingUploader.QueueItem) -> some View {
        Button("Retry", systemImage: "arrow.clockwise") { retry(item) }
        if let url = item.audioURL {
            ShareLink(item: url, preview: SharePreview(item.title)) {
                Label("Save or share audio", systemImage: "square.and.arrow.up")
            }
        }
        Button("Delete", systemImage: "trash", role: .destructive) { confirmingDelete = item }
    }

    private func reload() {
        items = MeetingUploader.queueItems()
    }

    private func retry(_ item: MeetingUploader.QueueItem) {
        busyId = item.id
        Task {
            await app.retryUpload(id: item.id)
            busyId = nil
            reload()
        }
    }

    private func retryAll() {
        retryingAll = true
        Task {
            await app.retryUploadsNow()
            retryingAll = false
            reload()
        }
    }

    private func delete(_ item: MeetingUploader.QueueItem) {
        app.deleteQueuedUpload(id: item.id)
        confirmingDelete = nil
        reload()
        if items.isEmpty { dismiss() }
    }
}

/// Date, length, and why it is still here.
private struct UploadQueueItemRow: View {
    let item: MeetingUploader.QueueItem
    let busy: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: item.title)
                .font(.parley.body)
            Text(verbatim: details)
                .font(.parley.caption)
                .foregroundStyle(Color(.secondaryLabel))
            Text(reason)
                .font(.parley.caption)
                .foregroundStyle(item.parking == nil ? Color(.secondaryLabel) : Theme.warning)
        }
        .padding(.trailing, 32)
        .opacity(busy ? 0.5 : 1)
    }

    private var details: String {
        let date = item.startedAt.formatted(.dateTime.month(.abbreviated).day().hour().minute())
        return "\(date) · \(RecordingDetailView.duration(item.durationMs))"
    }

    private var reason: String {
        guard let parking = item.parking else {
            return String(localized: "Waiting to sync")
        }
        switch parking.reason {
        case .quota:
            return String(localized: "Out of quota")
        case .refused:
            return String(localized: "Refused by the server (HTTP \(parking.httpStatus))")
        }
    }
}
