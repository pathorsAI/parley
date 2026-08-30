import UIKit

/// The two beats a dictation has, in one place so they cannot drift apart.
///
/// They are deliberately different patterns rather than two of the same thump:
/// the start is a single solid impact under the finger that just pressed, and
/// the finish is the system's two-beat success pattern, arriving when the words
/// land in the field. If both ends of a session felt identical the second one
/// would read as a stray tap.
///
/// This lives in the keyboard target because both beats happen there — the tap
/// that starts a dictation, and the one `insertText` that delivers it. The app
/// records in between and hands over nothing, so it has nothing to confirm; if
/// that ever changes, move this to a shared source directory rather than
/// copying it.
///
/// **Full Access.** Inside a keyboard extension the system silently drops
/// haptics unless the user has granted it, so the keyboard's call sites sit
/// behind `UIInputViewController.hasFullAccess` to keep that fact in the code
/// rather than in a bug report. Nothing here is ever load-bearing: a haptic that
/// does not play costs the user nothing, which is what lets the keyboard stay
/// fully usable without Full Access (App Review 4.4.1).
///
/// There is no setting for any of this. A device with haptics turned off in
/// Settings already plays nothing, and a second switch would only be a way to
/// disagree with the system.
enum Haptics {
    /// Held rather than made per call: `prepare()` only helps the generator it
    /// was called on, and a generator created at the moment of the event is
    /// exactly the late one it exists to avoid.
    ///
    /// `nonisolated(unsafe)` because every call site is already on the main
    /// thread — a SwiftUI body and a `UIInputViewController` — which is also
    /// what UIKit requires of feedback generators.
    nonisolated(unsafe) private static let start = UIImpactFeedbackGenerator(style: .medium)
    nonisolated(unsafe) private static let finish = UINotificationFeedbackGenerator()

    /// Warm the engine up before the press that will need it.
    static func prepareForDictation() { start.prepare() }

    /// The microphone is opening: one solid thump, on the press rather than on
    /// the release.
    static func dictationStarted() { start.impactOccurred() }

    /// Warm the engine up for the end of a session that is already finishing.
    static func prepareForDelivery() { finish.prepare() }

    /// The transcript is finished and handed over — fired by whichever process
    /// actually inserts it, which is always the keyboard. Once per session, and
    /// never on the failure path: a session that ended in an error delivered
    /// nothing, and saying "done" with the body would be the wrong news.
    static func dictationDelivered() { finish.notificationOccurred(.success) }
}
