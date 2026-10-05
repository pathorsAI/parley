import Foundation

/// Sweeps away what iOS 1.30's clipboard history and paste chip left in the App
/// Group, now that both are gone.
///
/// **Why they went.** iOS gives a keyboard no background access to the
/// pasteboard, and every read of something another app copied either shows
/// the paste banner or asks "Allow Paste?" — unless the user goes to
/// Settings › Parley › Paste from Other Apps › Allow, and even then a copy made
/// while the keyboard is not on screen is simply never seen. A history that
/// misses most copies and a chip that prompts on the way to being useful were
/// not worth what they asked of the user, so the keyboard no longer reads the
/// pasteboard at all. (Its one pasteboard *write* — tap-to-copy on a finished
/// dictation — stays.)
///
/// **What is removed.** TestFlight builds of 1.30 (build 47) kept copied text
/// in `clipboard-history.json` and five settings in the group's defaults. The
/// file is the one that matters: it may hold things the user copied in other
/// apps, and nothing will ever read it again. It is deleted, and so are the
/// keys.
///
/// Run on every app launch and every keyboard load (with Full Access — without
/// it the container cannot be opened, and the next load with it will do it).
/// Idempotent and cheap: a missing file is one failed `removeItem`, and
/// removing an absent key is a no-op.
public enum RetiredClipboard {
    /// The clipboard history's file name in the App Group container.
    public static let historyFileName = "clipboard-history.json"

    /// Every defaults key the clipboard history and the paste chip used.
    public static let retiredKeys = [
        "clipboard.autoCapture",
        "clipboard.retention",
        "clipboard.previewInStrip",
        "clipboard.pasteOffer",
        "clipboard.lastCapturedChangeCount",
    ]

    /// Delete the history file from the App Group container and the retired
    /// keys from the App Group's defaults — what the app and the keyboard call.
    public static func remove() {
        remove(
            in: DictationChannel.container,
            defaults: UserDefaults(suiteName: DictationChannel.appGroup))
    }

    /// The same, with the directory and defaults handed in, for the tests.
    public static func remove(in directory: URL?, defaults: UserDefaults?) {
        if let directory {
            try? FileManager.default.removeItem(
                at: directory.appendingPathComponent(historyFileName))
        }
        for key in retiredKeys { defaults?.removeObject(forKey: key) }
    }
}
