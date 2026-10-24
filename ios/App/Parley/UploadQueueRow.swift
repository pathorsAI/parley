import SwiftUI

/// The library's line about meetings that are on this phone but not yet in
/// the cloud.
///
/// The library lists what the cloud holds, so a recording still in the upload
/// queue used to be invisible everywhere but Settings — and a recording the
/// server refused was deleted outright. Refused recordings are now kept
/// (`UploadParking`), and this is where the user learns they exist and can
/// send them again with a tap.
struct UploadQueueRow: View {
    let pending: Int
    let parked: MeetingUploader.ParkedSummary
    let retry: () -> Void

    var body: some View {
        Button(action: retry) {
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
        .accessibilityHint(Text("Tries the upload again"))
    }

    private var message: String {
        if parked.count > 0, parked.waitingForQuota == parked.count {
            return String(
                localized: "\(parked.count) recordings not uploaded — out of quota. Kept on this phone; tap to retry")
        }
        if parked.count > 0 {
            return String(localized: "\(parked.count) recordings not uploaded — tap to retry")
        }
        return String(localized: "\(pending) recordings waiting to sync")
    }
}
