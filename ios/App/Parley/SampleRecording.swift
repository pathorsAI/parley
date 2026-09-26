import Foundation
import ParleyKit
import SwiftUI

/// The bundled sample recording — a ninety-second first sales call — as a
/// **local-only** entry in the Library.
///
/// ## Why local, and what that costs
///
/// The Library is the account's cloud recordings and nothing else, so the
/// obvious way in would be to upload the sample like an import. That would put
/// a fictional meeting into the user's account, sync it to their Mac, spend
/// transcription on words that are already written down, and leave them to
/// delete it everywhere. Instead the sample never leaves the phone:
///
/// - the audio and the manifest are bundle resources (`public/sample/`, shared
///   with the desktop, referenced from `project.yml`), read in place;
/// - whether it is in the Library, when it was added and which folder it is
///   filed in are three values in `UserDefaults`;
/// - `LibraryView` merges the one entry into the personal scope's list,
///   `RecordingDetailView` reads its transcript from the manifest instead of
///   the cloud, and `AudioDownloadModel` answers "local" with the bundle URL.
///
/// Filing works, locally: moving the sample into a folder records the folder's
/// id here, so the row shows under that folder's chip exactly as a real
/// recording would — but nothing is written to the cloud, and the Mac never
/// sees it. The cloud-only actions (download, re-transcribe, share to an org)
/// are not offered on it.
///
/// Recognised everywhere by its id prefix, `sample-` (`SampleManifest.isSample`),
/// the same rule the desktop uses.
@MainActor
final class SampleRecordingStore: ObservableObject {
    static let shared = SampleRecordingStore()

    /// What is stored about the entry. The manifest itself is not — it is read
    /// from the bundle — so a later build that re-renders the sample updates
    /// the text of an entry that is already in the Library.
    struct Entry: Codable, Equatable {
        /// Which manifest was loaded, `zh-TW` or `en`. Kept so a phone whose
        /// language changes keeps the recording it already has, rather than
        /// swapping the meeting out from under a folder it was filed in.
        var lang: String
        /// Epoch ms. When it was added, which is what it sorts by.
        var addedAt: Double
        var folderId: String?
    }

    private static let entryKey = "sampleRecording.entry"
    /// Where the files sit inside the app bundle: the folder reference in
    /// `project.yml` copies `public/sample` in as `sample/`.
    private static let bundleSubdirectory = "sample"

    @Published private(set) var entry: Entry?

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.entryKey) {
            entry = try? JSONDecoder().decode(Entry.self, from: data)
        }
    }

    // MARK: the bundle

    /// The manifest for the app's language: Traditional Chinese gets the zh-TW
    /// meeting, everything else the English one.
    static var preferredLang: String {
        (Bundle.main.preferredLocalizations.first ?? "en").hasPrefix("zh") ? "zh-TW" : "en"
    }

    /// Whether this build carries the sample at all. False only for a build
    /// made without the `public/sample` assets, where the checklist's "Load
    /// sample" is not offered rather than offered and broken.
    static var isBundled: Bool { manifest(lang: preferredLang) != nil }

    static func manifest(lang: String) -> SampleManifest? {
        guard
            let url = Bundle.main.url(
                forResource: "sample.\(lang)", withExtension: "json",
                subdirectory: bundleSubdirectory),
            let data = try? Data(contentsOf: url)
        else { return nil }
        return try? SampleManifest.decode(data)
    }

    static func audioURL(for manifest: SampleManifest) -> URL? {
        let name = (manifest.audio as NSString).deletingPathExtension
        let ext = (manifest.audio as NSString).pathExtension
        return Bundle.main.url(
            forResource: name, withExtension: ext.isEmpty ? "ogg" : ext,
            subdirectory: bundleSubdirectory)
    }

    // MARK: the entry

    /// The manifest of the entry in the Library, if there is one.
    var manifest: SampleManifest? {
        entry.flatMap { Self.manifest(lang: $0.lang) }
    }

    /// The Library row, or nil when the sample is not in the Library.
    var summary: CloudRecordingSummary? {
        guard let entry, let manifest else { return nil }
        return manifest.summary(createdAt: entry.addedAt, folderId: entry.folderId)
    }

    func isSample(_ id: String) -> Bool { SampleManifest.isSample(id: id) }

    /// The transcript for the detail screen, when `id` is the sample's.
    func meta(for id: String) -> RecordingMeta? {
        guard let entry, let manifest, manifest.id == id else { return nil }
        return manifest.meta(createdAt: entry.addedAt, folderId: entry.folderId)
    }

    /// The bundled audio, when `id` is the sample's.
    func audioURL(for id: String) -> URL? {
        guard let manifest, manifest.id == id else { return nil }
        return Self.audioURL(for: manifest)
    }

    /// Put the sample in the Library. Returns the row, or nil when this build
    /// does not carry it. Loading twice keeps the first entry — its folder and
    /// its place in the list.
    ///
    /// Ticks `recorded`: the checklist's first item is "have a recording to
    /// work with", and the sample is offered as exactly that.
    @discardableResult
    func load() -> CloudRecordingSummary? {
        if entry == nil {
            let lang = Self.preferredLang
            guard Self.manifest(lang: lang) != nil else { return nil }
            entry = Entry(lang: lang, addedAt: Date().timeIntervalSince1970 * 1000, folderId: nil)
            save()
        }
        guard let summary else { return nil }
        GettingStartedStore.shared.mark(.recorded)
        return summary
    }

    /// File the sample. Local only — see the type doc.
    func setFolder(_ folderId: String?) {
        guard entry != nil else { return }
        entry?.folderId = folderId
        save()
    }

    /// Take the sample out of the Library. The bundle keeps the files, so the
    /// checklist can offer it again.
    func remove() {
        entry = nil
        defaults.removeObject(forKey: Self.entryKey)
    }

    private func save() {
        guard let entry, let data = try? JSONEncoder().encode(entry) else { return }
        defaults.set(data, forKey: Self.entryKey)
    }
}
