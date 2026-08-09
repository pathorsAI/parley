import AppIntents

/// Start Parley dictation from the Action Button, Control Center, or Back Tap —
/// without leaving the app you're in.
///
/// This is the friction-free trigger the keyboard round trip can't be: an
/// `AudioRecordingIntent` runs in the app's process in the background and is
/// granted a recording assertion, so the mic opens without Parley ever coming
/// to the foreground. Whatever Parley keyboard is frontmost then inserts the
/// text exactly as it does for the keyboard-button flow. Requires iOS 18, where
/// `AudioRecordingIntent` was introduced.
@available(iOS 18.0, *)
struct StartDictationIntent: AppIntent, AudioRecordingIntent {
    static var title: LocalizedStringResource = "開始語音輸入"
    static var description = IntentDescription("在目前的 App 直接開始 Parley 語音輸入，不用切換畫面。")

    /// The whole point: do not bring the app forward.
    static var openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult {
        await DictationCoordinator.shared.beginFromIntent()
        return .result()
    }
}

/// Surfaces the intent for the Action Button and Shortcuts.
@available(iOS 18.0, *)
struct ParleyShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartDictationIntent(),
            phrases: [
                "用 \(.applicationName) 語音輸入",
                "\(.applicationName) 語音輸入",
            ],
            shortTitle: "語音輸入",
            systemImageName: "mic.fill")
    }
}
