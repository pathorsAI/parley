import Foundation

/// The words on the card's buttons, from ParleyKit's own catalog.
///
/// They are here rather than in the widget extension because the app and the
/// widget must not drift, and here rather than on the intents below because
/// **an `AppIntent`'s `title` cannot carry them**. AppIntents extracts its
/// metadata at build time and refuses any `LocalizedStringResource` that names
/// a bundle other than the main one — `appintentsmetadataprocessor` fails the
/// build with "AppIntents requires 'LocalizedStringResource' to use the main
/// bundle" — and ParleyKit's strings live in `Bundle.module`. So each intent's
/// `title` is a bare literal, which is tolerable because it is Shortcuts
/// metadata for an intent that is `isDiscoverable = false` and is not what the
/// card draws; this is what the card draws.
public enum MicActivityCopy {
    /// ⏹ on a meeting card.
    public static var stopRecording: String {
        String(localized: "Stop Recording", bundle: .module)
    }
    /// ⏹ on a dictation card: keep the words.
    public static var finish: String { String(localized: "Finish", bundle: .module) }
    /// ✕ on a dictation card: throw them away.
    public static var discard: String { String(localized: "Discard", bundle: .module) }
    /// The standby card's one button.
    public static var endStandby: String { String(localized: "End Standby", bundle: .module) }
}

// `os(iOS)` rather than `canImport(AppIntents)`: AppIntents.framework is in the
// macOS SDK, so the import succeeds there and `LiveActivityIntent` is then
// `@available(macOS, unavailable)`. Same trap as `MicActivityAttributes.swift`.
#if os(iOS)
    import AppIntents

    // The buttons on the microphone card.
    //
    // They live in ParleyKit because both sides need the type: the widget
    // extension names them in its `Button(intent:)`, and the app is what
    // actually runs them — a `LiveActivityIntent` is performed in the owning
    // app's process, waking it if it is suspended.
    //
    // ## None of them touches the microphone
    //
    // That is the whole reason the card's buttons work at all. An intent
    // performed from the lock screen runs in a process iOS has just woken for a
    // few seconds of background time; it cannot start an `AVAudioSession`, and
    // anything it did to a running one would race the coordinator that owns it.
    // So each of these does exactly one thing — write an App Group mailbox and
    // post its Darwin note — and the real work happens on the app's own actor,
    // in the observer that hears the note. If the app was already awake, that is
    // immediate; if it was not, it is the first thing it does on waking.
    //
    // Three of the four notes already have a listener: `requestObserver` and
    // `windowControlObserver` in `DictationCoordinator` have been serving the
    // keyboard's ⏹, ✕ and "end window" since before the card existed, and these
    // intents deliberately write the very same mailboxes rather than inventing
    // parallel ones — two ways to ask for the same thing is two ways for them to
    // disagree. `StopMeetingRecordingIntent` is the exception: its mailbox is new
    // (`MeetingControlChannel`) and so is its observer.
    //
    // All four are `isDiscoverable = false`. They are card buttons, not
    // shortcuts: "Finish" means nothing in Spotlight, and every one of them is a
    // no-op unless something is already running.

    /// ⏹ on a meeting card: stop the recording and keep it.
    @available(iOS 17.0, *)
    public struct StopMeetingRecordingIntent: LiveActivityIntent {
        public static let title = LocalizedStringResource("Stop Recording")
        public static let isDiscoverable = false

        public init() {}

        public func perform() async throws -> some IntentResult {
            MeetingControlChannel.write(MeetingControl(stopRequestedAt: Date()))
            return .result()
        }
    }

    /// ⏹ on a dictation card: end the session and deliver what was said.
    ///
    /// Reads the uplink and writes it back rather than minting one, because the
    /// uplink carries the session id and the keyboard's insertion high-water
    /// mark — a fresh one would tell the app to stop a session it has never
    /// heard of and would reset the mark to zero, which is how text gets
    /// inserted twice. No uplink at all means no session to finish, and doing
    /// nothing is the honest answer.
    @available(iOS 17.0, *)
    public struct FinishDictationIntent: LiveActivityIntent {
        public static let title = LocalizedStringResource("Finish")
        public static let isDiscoverable = false

        public init() {}

        public func perform() async throws -> some IntentResult {
            guard var uplink = DictationChannel.readUplink() else { return .result() }
            uplink.stopRequested = true
            // Written explicitly rather than left alone: the same mailbox is
            // reused across the session's life, and a ✕ tapped and then
            // reconsidered would otherwise leave `true` behind to throw away a
            // transcript the user asked to keep.
            uplink.cancelRequested = false
            DictationChannel.writeUplink(uplink)
            return .result()
        }
    }

    /// ✕ on a dictation card: end the session and throw the words away.
    ///
    /// Both flags, exactly as the keyboard writes them: `stopRequested` is what
    /// makes this read as "end this" to the whole existing path, and
    /// `cancelRequested` is the only thing that says the transcript goes in the
    /// bin.
    @available(iOS 17.0, *)
    public struct CancelDictationIntent: LiveActivityIntent {
        public static let title = LocalizedStringResource("Discard")
        public static let isDiscoverable = false

        public init() {}

        public func perform() async throws -> some IntentResult {
            guard var uplink = DictationChannel.readUplink() else { return .result() }
            uplink.stopRequested = true
            uplink.cancelRequested = true
            DictationChannel.writeUplink(uplink)
            return .result()
        }
    }

    /// The standby card's one button: close the microphone window now, turning
    /// the system's orange dot off ahead of its timer.
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
