import Foundation
import ParleyKit

/// Mirror of the desktop's `DefaultSaveLocation` (src/lib/types.ts:420):
/// where a finished recording lands by default.
///
/// Desktop rule worth preserving exactly (history.ts:176-215): an org default
/// **never moves the original** — the recording always saves to the personal
/// space first, then auto-shares a copy into the org. A dangling folder falls
/// back to the scope root.
struct SaveDestination: Codable, Equatable {
    var scope: String  // "personal" | "org"
    var orgId: String?
    var folderId: String?

    static let personalRoot = SaveDestination(scope: "personal", orgId: nil, folderId: nil)

    var isOrg: Bool { scope == "org" && orgId != nil }

    func label(orgs: [CloudOrg], folders: [CloudFolder]) -> String {
        if isOrg {
            let orgName = orgs.first { $0.id == orgId }?.name ?? "組織"
            if let folderId, let f = folders.first(where: { $0.id == folderId }) {
                return "\(orgName) · \(f.name)"
            }
            return orgName
        }
        if let folderId, let f = folders.first(where: { $0.id == folderId }) {
            return "個人 · \(f.name)"
        }
        return "個人"
    }
}
