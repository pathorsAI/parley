import Foundation

/// "Start a meeting recording now", as a URL — what the lock-screen control,
/// the lock-screen widget and the Siri shortcut all open.
///
/// ## Why the app is brought forward rather than recording in the background
///
/// Voice typing starts without Parley ever coming forward
/// (`StartDictationIntent`), and it would be possible to do the same for a
/// meeting. It is deliberately not done. iOS only lets an
/// `AudioRecordingIntent` keep recording if the app puts up a Live Activity for
/// the length of it, and a meeting recording has no card by decision (see
/// `docs/design/ios-live-activity.md`, *What was removed, and why*). More
/// simply: a meeting is something you look at — the timer, the waveform, the
/// transcript arriving — and a recording that started somewhere you cannot see
/// is one you cannot tell is working. So the shortcut's whole job is to remove
/// the taps between the lock screen and the red circle, and the unlock it
/// costs is the one tap iOS will not let anything skip.
///
/// ## A request goes stale
///
/// The URL is honoured once, and only soon after it arrived. On a cold launch
/// it lands before the app knows whether anyone is signed in; if nobody is,
/// the sign-in page comes up, and a request that waited through it would start
/// recording by itself some minutes later, on a screen the user reached for a
/// different reason. `QuickRecord.freshness` is how long the app treats the tap
/// as still being what the user wants.
public enum QuickRecord {
    public static let url = URL(string: "parley://record")!

    /// Is this the start-a-recording URL? Nothing else about the URL is read:
    /// there are no parameters, and a meeting started this way is the same as
    /// one started from the red circle.
    public static func isRequest(_ url: URL) -> Bool {
        url.scheme == "parley" && url.host == "record"
    }

    /// How long a request stays worth acting on. Long enough for a cold launch,
    /// a Face ID retry and the account check; short enough that a request which
    /// waited on a sign-in page is dropped rather than obeyed.
    public static let freshness: TimeInterval = 30

    /// Should a request made at `requestedAt` still start a recording at `now`?
    public static func isFresh(requestedAt: Date, now: Date = Date()) -> Bool {
        let age = now.timeIntervalSince(requestedAt)
        return age >= 0 && age <= freshness
    }
}
