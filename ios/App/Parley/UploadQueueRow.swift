import SwiftUI

/// The library's line about meetings that are on this phone but not yet in
/// the cloud.
///
/// The library lists what the cloud holds, so a recording still in the upload
/// queue used to be invisible everywhere but Settings — and a recording the
/// server refused was deleted outright. Refused recordings are now kept
/// (`UploadParking`), and this is where the user learns they exist and can
/// open the list where each one can be retried, shared or deleted.
struct UploadQueueRow: View {
    let pending: Int
    let parked: MeetingUploader.ParkedSummary
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            Label {
                Text(message)
                    .font(.parley.caption)
                    .multilineTextAlignment(.leading)
            } icon: {
                Image(systemName: parked.count > 0 ? "exclamationmark.icloud" : "icloud.and.arrow.up")
            }
            .foregroundStyle(Theme.warning)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        .accessibilityHint(Text("Shows the recordings still on this phone"))
    }

    private var message: String {
        if parked.count > 0, parked.waitingForQuota == parked.count {
            return String(
                localized: "\(parked.count) recordings not uploaded — out of quota. Kept on this phone; tap to see them")
        }
        if parked.count > 0 {
            return String(localized: "\(parked.count) recordings not uploaded — tap to see them")
        }
        return String(localized: "\(pending) recordings waiting to sync")
    }
}
