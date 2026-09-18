import UIKit

/// The beats a dictation has, in one place so they cannot drift apart.
///
/// Four things can happen to a dictation and the hand has to tell them apart
/// without the eye: it starts, it is delivered, the user throws it away, or the
/// keyboard leaves while it carries on. Touch is poor at texture — a `.medium`
/// and a `.rigid` impact are all but the same event to a phone in a pocket —
/// and good at exactly one thing: **direction**. So the two events that bracket
/// "is the keyboard here" are two-beat patterns that move opposite ways, rising
/// to start and falling to say the microphone stayed behind, rather than two
/// more single thumps distinguished by how hard they are. The start used to be
/// one `.medium` impact and went unfelt against the keyclick and the finger's
/// own landing; the dismissal used to be nothing at all.
///
/// This lives in the keyboard target because every beat happens there — the tap
/// that starts a dictation, the one `insertText` that delivers it, and the
/// keyboard's own disappearance. The app records in between and hands over
/// nothing, so it has nothing to confirm; if that ever changes, move this to a
/// shared source directory rather than copying it.
///
/// **Full Access.** Inside a keyboard extension the system silently drops
/// haptics unless the user has granted it, so the keyboard's call sites sit
/// behind `UIInputViewController.hasFullAccess` to keep that fact in the code
/// rather than in a bug report. Nothing here is ever load-bearing: a haptic that
/// does not play costs the user nothing, which is what lets the keyboard stay
/// fully usable without Full Access (App Review 4.4.1). The two-beat patterns
/// extend that honestly rather than quietly depending on both halves arriving —
/// half a pattern is still legible as that pattern's first beat, so each pair
/// leads with the beat that carries the meaning on its own.
///
/// There is no setting for any of this. A device with haptics turned off in
/// Settings already plays nothing, and a second switch would only be a way to
/// disagree with the system.
enum Haptics {
    /// Held rather than made per call: `prepare()` only helps the generator it
    /// was called on, and a generator created at the moment of the event is
    /// exactly the late one it exists to avoid. That is also why the two-beat
    /// patterns are built from generators named by style rather than each
    /// owning its own pair: `.heavy` is the loud end of both patterns, and a
    /// generator per pattern would warm the same hardware twice and keep it
    /// warm half as reliably.
    ///
    /// `nonisolated(unsafe)` because every call site is already on the main
    /// thread — a SwiftUI body and a `UIInputViewController` — which is also
    /// what UIKit requires of feedback generators. The delayed beats keep that
    /// promise deliberately; see `beat`.
    nonisolated(unsafe) private static let light = UIImpactFeedbackGenerator(style: .light)
    nonisolated(unsafe) private static let medium = UIImpactFeedbackGenerator(style: .medium)
    nonisolated(unsafe) private static let heavy = UIImpactFeedbackGenerator(style: .heavy)
    nonisolated(unsafe) private static let finish = UINotificationFeedbackGenerator()
    nonisolated(unsafe) private static let discard = UIImpactFeedbackGenerator(style: .rigid)

    /// The gap inside the starting pair. Short enough that the two impacts are
    /// felt as one event that grows rather than as two taps that happened to be
    /// near each other — around here is where a pair stops being countable and
    /// starts being a shape.
    private static let startGap: TimeInterval = 0.06

    /// The gap inside the leaving pair, twice the start's.
    ///
    /// Two patterns built from the same two impacts can only be told apart by
    /// their shape, and the same 60 ms would have made this a near-mirror that
    /// nobody could name with the phone out of sight. The length is part of the
    /// message: leaving is the slower of the two, and the fall has room to be
    /// felt as a fall.
    private static let leaveGap: TimeInterval = 0.13

    /// Warm the engine up before the press that will need it — every generator
    /// the live-session patterns use, which is all three impact styles. Both
    /// presses: the ✕ appears the moment a session starts, so the beat that
    /// answers it has the same claim on being ready as the one that opened the
    /// microphone. And `dictationContinuesInBackground` has no press of its own
    /// to warm on — by the time it fires the keyboard is already going away —
    /// so here is the only place its two beats can be readied at all.
    static func prepareForDictation() {
        light.prepare()
        medium.prepare()
        heavy.prepare()
        discard.prepare()
    }

    /// The microphone is opening: `.medium`, then `.heavy` a breath later. A
    /// beat that grows.
    ///
    /// This was one `.medium` thump, and it was missed entirely — not because
    /// it was too weak but because a lone impact says only "something
    /// happened", and something is always happening under a finger that just
    /// pressed a key. The fix is not a harder thump; the hand is poor at
    /// ranking intensities it never feels side by side. The fix is a direction.
    ///
    /// So the first beat is the *same* `.medium` that shipped before, and the
    /// `.heavy` after it is the whole change. Starting the rise lower — from
    /// `.light` — would have made a cleaner slope and a worse first
    /// millisecond, which is the one that has to be noticed: the complaint this
    /// answers was never "the shape is unclear", it was "I did not feel it".
    /// Nothing about the moment of the press is allowed to get quieter.
    ///
    /// The first beat is synchronous, on the press rather than the release, so
    /// nothing about the existing responsiveness regresses; only the second one
    /// is scheduled.
    ///
    /// Leading with the *quieter* beat is safe here in a way it would not be
    /// anywhere else in this file. A truncated pattern is a real risk when the
    /// extension is on its way out (see `dictationContinuesInBackground`), but
    /// this fires on a press that keeps the keyboard on screen — the session it
    /// starts is the whole reason the keyboard stays — so 60 ms later this
    /// process is still running and still frontmost. The rising shape costs
    /// nothing it cannot pay.
    static func dictationStarted() {
        medium.impactOccurred()
        beat(heavy, after: startGap)
    }

    /// The keyboard is being dismissed while a dictation is still running:
    /// `.heavy`, then `.light`. A beat that fades.
    ///
    /// Swiping the keyboard away mid-dictation takes the live transcript above
    /// the keys with it and leaves the user holding a phone that is still
    /// recording with nothing on screen saying so. This is the only evidence
    /// they get, so it says the one thing worth saying: *leaving, but still
    /// here*.
    ///
    /// Deliberately the mirror of `dictationStarted` — the same `.heavy` at the
    /// other end of the slope — because the two are the two ends of one
    /// question: the keyboard arriving to listen, and the keyboard going while
    /// something else listens on. Sharing the loud beat is what makes them a
    /// pair rather than two unrelated buzzes, and leaves direction as the only
    /// thing that can be missed.
    ///
    /// The quiet ends differ — `.medium` opening, `.light` leaving — and that
    /// is not sloppiness about the mirror. The start's quiet beat is the one
    /// under the finger and may not get any quieter than what already shipped
    /// (see `dictationStarted`); this one is a tail nobody is waiting for, and a
    /// fall reads as a fall in proportion to how far it drops.
    ///
    /// **The second beat may not arrive.** iOS can suspend a keyboard extension
    /// moments after it starts disappearing, and 130 ms is long enough for that
    /// to happen. Which is why this pair leads with `.heavy`: if only the first
    /// beat lands, the user still feels a firm, unmistakable thump — the
    /// loudest part of the shape, and the part that carries the meaning — and
    /// not a tap so faint it reads as nothing. Losing the tail costs the *shade*
    /// of the message, never the message.
    static func dictationContinuesInBackground() {
        heavy.impactOccurred()
        beat(light, after: leaveGap)
    }

    /// Warm the engine up for the end of a session that is already finishing.
    static func prepareForDelivery() { finish.prepare() }

    /// The transcript is finished and handed over — fired by whichever process
    /// actually inserts it, which is always the keyboard. Once per session, and
    /// never on the failure path: a session that ended in an error delivered
    /// nothing, and saying "done" with the body would be the wrong news.
    ///
    /// Left exactly as it was when the other two became two-beat patterns, and
    /// not for want of symmetry. The system's success pattern is already two
    /// beats, already means *that worked*, and the user has learned it from
    /// every other app on the phone. A pattern of our own would trade a meaning
    /// they already own for one they would have to acquire.
    static func dictationDelivered() { finish.notificationOccurred(.success) }

    /// The session was thrown away: one short, hard tick, on the press.
    ///
    /// A third pattern rather than a reuse of either of the other two, because
    /// it is a third outcome. The success pattern would be celebrating a
    /// delivery that did not happen; the system's `.warning` would say
    /// something went wrong, and nothing did — the user asked for this. What is
    /// left is the feel of the thing itself: shorter and harder than the beats
    /// that opened the microphone, so the two ends of a session never blur.
    ///
    /// Also left alone. `.rigid` was already the most distinguishable of these
    /// endings, and it is now the only single-beat event in the set — which is
    /// a shape too: nothing follows it, because nothing follows.
    static func dictationDiscarded() { discard.impactOccurred() }

    /// The second half of a two-beat pattern.
    ///
    /// `DispatchQueue.main.asyncAfter` rather than a `Task` or a timer, because
    /// the statics above are `nonisolated(unsafe)` on the promise that nothing
    /// ever touches them off the main thread, and this is the one place in the
    /// file that could break it. Nothing is retained that would need
    /// cancelling: the generator is a static, and a beat that plays a moment
    /// after its pattern was overtaken is a beat, not a bug.
    private static func beat(_ generator: UIImpactFeedbackGenerator, after gap: TimeInterval) {
        DispatchQueue.main.asyncAfter(deadline: .now() + gap) { generator.impactOccurred() }
    }
}
