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
            let orgName = orgs.first { $0.id == orgId }?.name ?? String(localized: "Organization")
            if let folderId, let f = folders.first(where: { $0.id == folderId }) {
                return "\(orgName) · \(f.name)"
            }
            return orgName
        }
        if let folderId, let f = folders.first(where: { $0.id == folderId }) {
            return String(localized: "Personal · \(f.name)")
        }
        return String(localized: "Personal")
    }
}

extension SaveDestination {
    /// A picker's pick as a place to save a new recording. Nil for a folder
    /// that does not exist yet: whoever confirmed the pick creates it first,
    /// and saves into the folder that came back.
    init?(_ destination: FolderDestination) {
        switch destination {
        case .root(let orgId):
            self.init(scope: orgId == nil ? "personal" : "org", orgId: orgId, folderId: nil)
        case .folder(let id, let orgId):
            self.init(scope: orgId == nil ? "personal" : "org", orgId: orgId, folderId: id)
        case .newFolder:
            return nil
        }
    }

    /// The same place, as the folder picker names it.
    var folderDestination: FolderDestination {
        .current(orgId: isOrg ? orgId : nil, folderId: folderId)
    }
}
