import Foundation

/// The audio this phone is holding on to, keyed by recording id.
///
/// Until now the phone was a write-only device: a finished meeting's Ogg was
/// uploaded and then deleted, so nothing recorded here could ever be played
/// back here. This is where the file lives instead — one flat directory of
/// `<recordingId>.ogg` under Application Support, which is the same container
/// the pending-upload and backfill queues already use, and for the same reason:
/// it survives relaunches and is not swept by the system the way the temporary
/// directory is.
///
/// Two kinds of file end up here and they are deliberately indistinguishable:
/// a recording made on this phone that was kept after uploading, and one made
/// somewhere else that was downloaded. "Is the audio on this phone" is the only
/// question anything asks, so there is only one answer to keep.
///
/// Excluded from iCloud backup. The cloud already holds every one of these
/// files, so backing them up would spend a person's iCloud quota on a second
/// copy of something they can re-download for free.
public final class LocalAudioStore: @unchecked Sendable {
    /// The app's store. A separate instance with its own directory is what the
    /// tests use, which is why nothing here is static.
    public static let shared = LocalAudioStore()

    /// UserDefaults key for "keep the audio of recordings made here".
    ///
    /// Lives next to the store rather than in the view that toggles it because
    /// the upload path has to read it with no view alive — see
    /// `MeetingUploader.upload`.
    public static let keepAudioKey = "keepAudioOnPhone"

    /// **Defaults to true**, which `UserDefaults.bool(forKey:)` cannot express:
    /// an unset key reads as `false` there, which would mean a phone that has
    /// never opened Settings throws its recordings' audio away. So the absence
    /// of the key is read as the default rather than as "off".
    public static var keepsAudioOnPhone: Bool {
        UserDefaults.standard.object(forKey: keepAudioKey) as? Bool ?? true
    }

    /// `Audio/` inside this directory is where the files go.
    private let directory: URL
    private let fileManager = FileManager.default

    /// `base` exists for the tests: a temporary directory in, a real store out,
    /// with no shared state to reset between cases. Production passes nothing
    /// and gets Application Support.
    ///
    /// A container that cannot be resolved falls back to the temporary
    /// directory rather than failing to build: a store that loses its files on
    /// the next sweep is bad, and a store that throws at every call site that
    /// only wants to ask `has(_:)` is worse.
    public init(base: URL? = nil) {
        let root =
            base
            ?? (try? FileManager.default.url(
                for: .applicationSupportDirectory, in: .userDomainMask,
                appropriateFor: nil, create: true))
            ?? FileManager.default.temporaryDirectory
        directory = root.appendingPathComponent("Audio", isDirectory: true)
    }

    /// Where this recording's audio would be, whether or not it is there. The
    /// player takes this; `has(_:)` answers whether it is worth taking.
    public func url(for id: String) -> URL {
        directory.appendingPathComponent("\(Self.fileName(for: id)).ogg")
    }

    public func has(_ id: String) -> Bool {
        fileManager.fileExists(atPath: url(for: id).path)
    }

    /// Where this recording's overview waveform is cached — `<id>.peaks`, beside
    /// the audio it was computed from.
    ///
    /// Here rather than in a cache directory of its own precisely so it shares
    /// the audio's lifetime: the file is derived from the Ogg and is worthless
    /// without it, so `remove(_:)` takes both and nothing can leave a stale
    /// waveform behind to be drawn over the next file that reuses the id.
    public func peaksURL(for id: String) -> URL {
        directory.appendingPathComponent("\(Self.fileName(for: id)).peaks")
    }

    /// Read back a cached overview, or nil if there is none or it is unreadable.
    ///
    /// A corrupt cache is a *nil*, not an error: the only thing a caller could
    /// do with the error is recompute, which is what nil already asks for.
    public func peaks(for id: String) -> AudioPeaks.Overview? {
        guard let data = try? Data(contentsOf: peaksURL(for: id)) else { return nil }
        return try? AudioPeaks.decode(data)
    }

    public func putPeaks(_ overview: AudioPeaks.Overview, for id: String) {
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        excludeFromBackup()
        try? AudioPeaks.encode(overview).write(to: peaksURL(for: id), options: .atomic)
    }

    /// Take ownership of an Ogg: a **move**, not a copy.
    ///
    /// The callers are the upload path, which is done with the file, and the
    /// download path, which wrote it to a temporary location. Copying would
    /// leave two copies of an hour of audio on a phone, and whichever of them
    /// was forgotten would be the one that never gets cleaned up.
    public func put(_ id: String, from source: URL) throws {
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        excludeFromBackup()
        let destination = url(for: id)
        if fileManager.fileExists(atPath: destination.path) {
            try fileManager.removeItem(at: destination)
        }
        try fileManager.moveItem(at: source, to: destination)
    }

    /// The audio and everything derived from it. See `peaksURL(for:)`.
    public func remove(_ id: String) {
        try? fileManager.removeItem(at: url(for: id))
        try? fileManager.removeItem(at: peaksURL(for: id))
    }

    /// Everything, for the "Remove all" action in Settings. The directory
    /// itself goes too — `put` recreates it, and an empty directory left behind
    /// would make `totalBytes()` and a fresh install disagree about nothing.
    public func removeAll() {
        try? fileManager.removeItem(at: directory)
    }

    /// What the store costs, in bytes. Summed on demand rather than tracked:
    /// files arrive by two paths and leave by three, and a counter that drifts
    /// would be worse than a directory scan a settings screen runs once.
    public func totalBytes() -> Int64 {
        guard
            let files = try? fileManager.contentsOfDirectory(
                at: directory, includingPropertiesForKeys: [.fileSizeKey])
        else { return 0 }
        return files.reduce(into: Int64(0)) { total, url in
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
            total += Int64(size)
        }
    }

    /// The cloud is the backup. See the type comment.
    private func excludeFromBackup() {
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var url = directory
        try? url.setResourceValues(values)
    }

    /// Recording ids are minted as lowercased UUIDs, so this is a no-op for
    /// every id the app produces. It exists because the id reaches here from a
    /// server response too, and an id carrying a `/` or a leading `.` would
    /// otherwise write outside the store — a path, not a file name.
    static func fileName(for id: String) -> String {
        let safe = String(
            id.map { character in
                character.isLetter || character.isNumber || character == "-" || character == "_"
                    ? character : "-"
            })
        return safe.isEmpty ? "unnamed" : safe
    }
}
