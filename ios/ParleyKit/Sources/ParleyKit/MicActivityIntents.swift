import Foundation

/// The word on the standby card's one button, from ParleyKit's own catalog.
///
/// It is here rather than on the intent below because **an `AppIntent`'s `title`
/// cannot carry it**. AppIntents extracts its metadata at build time and refuses
/// any `LocalizedStringResource` that names a bundle other than the main one —
/// `appintentsmetadataprocessor` fails the build with "AppIntents requires
/// 'LocalizedStringResource' to use the main bundle" — and ParleyKit's strings
/// live in `Bundle.module`. So the intent's `title` is a bare literal, which is
/// tolerable because it is Shortcuts metadata for an intent that is
/// `isDiscoverable = false` and is not what the card draws; this is what the
/// card draws.
public enum MicActivityCopy {
    /// The standby card's one button.
    public static var endStandby: String { String(localized: "End Standby", bundle: .module) }
}

// `os(iOS)` rather than `canImport(AppIntents)`: AppIntents.framework is in the
// macOS SDK, so the import succeeds there and `LiveActivityIntent` is then
// `@available(macOS, unavailable)`. Same trap as `MicActivityAttributes.swift`.
#if os(iOS)
    import AppIntents

    /// The standby card's one button: close the microphone window now, turning
    /// the system's orange dot off ahead of its timer.
    ///
    /// ## Why this is the only button left
    ///
    /// The dictation card's ⏹ and ✕ were removed deliberately: the founder did
    /// not want to decide what happens to a transcript from a lock screen, and a
    /// card you read is a different object from a card you operate.
    ///
    /// This one survives that, and the distinction is not a loophole. ⏹ and ✕
    /// decided the fate of *words* — deliver them, or throw them away — which is
    /// a judgement about content you cannot see on the card. Ending standby
    /// decides nothing about content, because standby is precisely the state in
    /// which **nothing is being recorded**. It turns off a microphone that is
    /// open, and the design has held since the window shipped that every surface
    /// which announces a window must also be a way to end it: the Settings
    /// picker, the Record tab's bar, and the keyboard's chip all are. The card is
    /// the fourth, and it is the only one visible from a locked screen — which is
    /// exactly where someone who has just noticed an unexplained orange dot is
    /// looking.
    ///
    /// ## It does not touch the microphone
    ///
    /// Like the keyboard's chip, it writes a timestamp to the App Group and posts
    /// a Darwin note; `DictationCoordinator.windowControlObserver` has been
    /// serving that same mailbox since before this card existed. An intent
    /// performed from a lock screen runs in a process iOS has just woken for a
    /// few seconds, which could not start an `AVAudioSession` and must not race
    /// the one that owns it.
    @available(iOS 17.0, *)
    public struct EndMicWindowIntent: LiveActivityIntent {
        public static let title = LocalizedStringResource("End Standby")
        public static let isDiscoverable = false

        public init() {}

        public func perform() async throws -> some IntentResult {
            DictationChannel.writeWindowControl(MicWindowControl(closeRequestedAt: Date()))
            return .result()
        }
    }
#endif
