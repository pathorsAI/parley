import Foundation
import ParleyKit
import SwiftUI

/// Where a recording's audio is, from the UI's point of view.
enum AudioDownloadState: Equatable {
    /// In the cloud only. Every recording made on another device starts here.
    case absent
    case downloading(Double)
    /// On this phone, and therefore playable without a network.
    case local
    /// The last attempt failed, with something to show on the row. Failure is
    /// deliberately a *state* rather than an alert: the person tapped
    /// "Download", and the honest answer to a failure is to leave the row
    /// saying so with a way to try again.
    case failed(String)
}

/// One per app: who is downloading what, and what the local store holds.
///
/// Everything about "is this on the phone" is answered from `LocalAudioStore`
/// rather than cached here, so a recording that was kept the moment it finished
/// uploading shows as local with nothing having to tell this object about it.
/// The dictionary holds only the two states a *file* cannot express — in flight,
/// and failed.
@MainActor
final class AudioDownloadModel: ObservableObject {
    private let store: LocalAudioStore
    /// Only `.downloading` and `.failed` live here. See the type comment.
    @Published private var active: [String: AudioDownloadState] = [:]
    /// Bumped whenever the store's contents change, which is what makes the
    /// rows re-read `has(_:)`. The store is a directory, not a publisher.
    @Published private var revision = 0
    /// What the store costs, for the Settings row. Refreshed on demand: a
    /// settings screen asking once is cheaper than every download keeping a
    /// running total that could drift.
    @Published private(set) var storedBytes: Int64 = 0

    init(store: LocalAudioStore = .shared) {
        self.store = store
        refreshSize()
    }

    func state(for id: String) -> AudioDownloadState {
        #if DEBUG
            if ScreenshotDemo.servesFixtures { return ScreenshotDemo.audioState(for: id) }
        #endif
        if let live = active[id] { return live }
        return store.has(id) ? .local : .absent
    }

    /// The file to play, or nil if there is nothing to play yet.
    ///
    /// The fixture branch matters: `state(for:)` already reports the featured
    /// demo recording as `.local`, and without the same hook here the player
    /// would be asked for a file the simulator's empty store does not have — the
    /// two answers have to agree.
    func url(for id: String) -> URL? {
        #if DEBUG
            if ScreenshotDemo.servesFixtures { return ScreenshotDemo.audioURL(for: id) }
        #endif
        return store.has(id) ? store.url(for: id) : nil
    }

    /// Fetch the audio and hand it to the store.
    ///
    /// Written to a temporary file first and then *moved* in, so a download that
    /// dies halfway through can never leave a truncated Ogg in the store under a
    /// name that `has(_:)` would call local.
    func download(_ id: String, cloud: CloudClient) async {
        guard !isDownloading(id) else { return }
        active[id] = .downloading(0)
        do {
            let data = try await cloud.downloadAudio(id: id) { [weak self] fraction in
                Task { @MainActor [weak self] in
                    guard let self, self.isDownloading(id) else { return }
                    self.active[id] = .downloading(fraction)
                }
            }
            let scratch = FileManager.default.temporaryDirectory
                .appendingPathComponent("parley-download-\(UUID().uuidString).ogg")
            try data.write(to: scratch, options: .atomic)
            try store.put(id, from: scratch)
            active[id] = nil
            changed()
        } catch let error as CloudError {
            active[id] = .failed(Self.message(for: error))
        } catch {
            active[id] = .failed(String(localized: "Download failed"))
        }
    }

    /// Give the bytes back. The cloud copy is untouched, which is why this is
    /// not a destructive action anywhere it is offered.
    func removeDownload(_ id: String) {
        store.remove(id)
        active[id] = nil
        changed()
    }

    func removeAllDownloads() {
        store.removeAll()
        active = active.filter { _, state in
            if case .downloading = state { return true }
            return false
        }
        changed()
    }

    func refreshSize() {
        #if DEBUG
            // A simulator running the fixtures has never recorded anything, so
            // the real store is empty and the Settings row would be hidden — on
            // the one screen whose job is to show what that row looks like.
            if ScreenshotDemo.servesFixtures {
                storedBytes = ScreenshotDemo.storedAudioBytes
                return
            }
        #endif
        storedBytes = store.totalBytes()
    }

    /// `128 MB`, in the phone's own locale. `.file` counts the way a storage
    /// setting does — 1 MB is 1,000,000 bytes, matching iOS's own Storage screen
    /// rather than a programmer's power of two.
    var storedSizeLabel: String {
        storedBytes.formatted(.byteCount(style: .file))
    }

    private func isDownloading(_ id: String) -> Bool {
        if case .downloading = active[id] { return true }
        return false
    }

    private func changed() {
        revision += 1
        refreshSize()
    }

    /// A row has one line to say what went wrong, so 401 and 404 are the only
    /// two worth distinguishing: one is fixed by signing in again, the other
    /// means there is nothing to download and a retry cannot help.
    private static func message(for error: CloudError) -> String {
        switch error.status {
        case 401: return String(localized: "Sign in again to download")
        case 404: return String(localized: "No audio stored for this recording")
        default: return String(localized: "Download failed")
        }
    }
}
