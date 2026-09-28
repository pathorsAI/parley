import Foundation
import ParleyKit
import SwiftUI

/// The app's live view of `DictationHistoryStore`: what the Library's Voice
/// typing list draws, and what `DictationCoordinator` writes through.
///
/// One instance for the process, so a dictation that finishes while the Library
/// is on screen shows up in it without a reload. The store underneath is built
/// over **this app's sandbox** Application Support, never the App Group — see
/// `DictationHistoryStore` for why the keyboard must not be able to read it.
@MainActor
final class DictationHistory: ObservableObject {
    static let shared = DictationHistory()

    /// Newest first, already inside retention.
    @Published private(set) var entries: [DictationHistoryEntry] = []

    private let store: DictationHistoryStore

    private init() {
        store = DictationHistoryStore(
            directory: DictationHistoryStore.defaultDirectory(),
            isEnabled: { DictationHistoryStore.isEnabled() })
        entries = store.load()
    }

    /// Keep a finished or failed session. A no-op when the switch in Settings
    /// is off or the text is blank — the store decides both.
    ///
    /// `rawText` and `polish` are what the row's "Polished" / "Original ·
    /// reason" label and its "Show original" toggle are drawn from; the entry
    /// drops `rawText` when it is the same as `text`.
    func record(
        text: String, startedAt: Date, source: DictationHistoryEntry.Source,
        hostBundleID: String?, rawText: String? = nil, polish: PolishOutcome? = nil
    ) {
        let ms = max(0, Int(Date().timeIntervalSince(startedAt) * 1000))
        let entry = DictationHistoryEntry(
            text: text, startedAt: startedAt, durationMs: ms, source: source,
            hostBundleID: hostBundleID, rawText: rawText, polish: polish)
        if let kept = store.append(entry) { entries = kept }
    }

    #if DEBUG
        /// ScreenshotDemo (`-ParleyDemoRoute voicehistory`): replace the
        /// history with fixtures, one per polish outcome, so the labels can be
        /// looked at without dictating nine times into a flaky network. Goes
        /// through the real store — this is the simulator's own sandbox — so
        /// the list's `reload()` on appearing reads the same thing back.
        func seedDemo(_ fixtures: [DictationHistoryEntry]) {
            guard ScreenshotDemo.isActive else { return }
            store.clearAll()
            for entry in fixtures { store.append(entry) }
            entries = store.load()
        }
    #endif

    func delete(_ id: UUID) {
        entries = store.remove(id: id)
    }

    func clearAll() {
        store.clearAll()
        entries = []
    }

    /// Re-read, which also prunes what aged out while nobody was looking.
    func reload() {
        entries = store.load()
    }

    // MARK: presentation

    /// The app a dictation went to, for the handful of hosts people actually
    /// dictate into. Anything else — and the common case since iOS 26.4, where
    /// keyboards stopped being told the host at all — shows nothing rather than
    /// a bundle id nobody reads.
    static func appName(for bundleID: String?) -> String? {
        guard let bundleID else { return nil }
        switch bundleID {
        case "com.apple.mobilenotes": return String(localized: "Notes")
        case "com.apple.MobileSMS": return String(localized: "Messages")
        case "com.apple.mobilemail": return String(localized: "Mail")
        case "com.apple.mobilesafari": return "Safari"
        case "com.apple.reminders": return String(localized: "Reminders")
        case "jp.naver.line": return "LINE"
        case "com.anthropic.claude": return "Claude"
        case "com.tinyspeck.chatlyio": return "Slack"
        default: return nil
        }
    }

    /// The row's polish label: "Polished", or "Original · <why>". Short on
    /// purpose — it sits under the text in caption size, and it answers one
    /// question ("was this polished, and if not, why not") rather than
    /// explaining the pipeline. The reasons are worded as the user would put
    /// them, not as the code does: "you skipped it", not "skipped by user".
    static func polishLabel(_ outcome: PolishOutcome) -> String {
        switch outcome {
        case .polished: String(localized: "Polished")
        case .tooShort: String(localized: "Original · too short")
        case .off: String(localized: "Original · polish is off")
        case .skipped: String(localized: "Original · you skipped it")
        case .timedOut: String(localized: "Original · timed out")
        case .rejectedScript: String(localized: "Original · model replied in Simplified")
        case .rejectedLength: String(localized: "Original · length changed too much")
        case .failed: String(localized: "Original · connection failed")
        case .overdue: String(localized: "Original · took too long")
        }
    }

    /// "0:42" — the same clock format the meeting rows use.
    static func duration(_ ms: Int) -> String {
        RecordingDetailView.duration(Double(ms))
    }
}
