import Foundation

/// Reading and writing the small JSON files that hold things a person would not
/// want read off a locked phone: the keyboard's clipboard history and the
/// 常用資訊 (snippets) the user saved.
///
/// Both live in the App Group container because both processes need them —
/// the app edits the snippets and captures the clipboard when it comes to the
/// front, the keyboard shows and inserts them — and both are written with
/// `FileProtectionType.complete`: the file's key is discarded a few seconds
/// after the phone locks, so nothing (a backup tool, a forensic image, another
/// process in the group) can read it until the user unlocks again. That is
/// stricter than `DictationHistoryStore`'s "until first unlock", on purpose:
/// that history has to be writable from a session that ends with the phone
/// locked, while nothing here is ever written without the user in front of an
/// unlocked phone — a keyboard is never on screen over the lock screen, and the
/// app captures only on becoming active.
///
/// Excluded from iCloud backup for the same promise the privacy label makes
/// about the voice-typing history: these are on this phone and nowhere else.
///
/// The Keychain was the other candidate for the snippets and was ruled out:
/// sharing an item between the app and the keyboard needs a keychain access
/// group, which is an entitlement and signing change on both targets for what a
/// protected file in the group the two already share gives just as well.
enum ProtectedFile {
    static func read(_ url: URL) -> Data? {
        try? Data(contentsOf: url)
    }

    /// Atomic, so a reader in the other process sees the old file or the new
    /// one and never half of each.
    static func write(_ data: Data, to url: URL) {
        let fm = FileManager.default
        try? fm.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        var options: Data.WritingOptions = [.atomic]
        #if os(iOS)
            options.insert(.completeFileProtection)
        #endif
        guard (try? data.write(to: url, options: options)) != nil else { return }
        var target = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? target.setResourceValues(values)
    }

    static func remove(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }

    // Dates in the default encoding (seconds since the reference date, as a
    // Double): ISO 8601 would round every stamp to the second and make an item
    // read back unequal to the one written.
    static let encoder = JSONEncoder()
    static let decoder = JSONDecoder()
}
