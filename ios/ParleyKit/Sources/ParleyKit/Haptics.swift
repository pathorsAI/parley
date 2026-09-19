// `os(iOS)` rather than `canImport(UIKit)`, which is the obvious spelling and
// the same trap `MicActivityAttributes.swift` and `MicActivityIntents.swift`
// already document for ActivityKit and AppIntents. ParleyKit builds for macOS
// so its logic can be unit-tested without a simulator (see `Package.swift`),
// and on that side a `canImport` answering yes buys nothing, because what is
// inside is unavailable there anyway. The guard has to be about the platform,
// because that is what the framework's availability is about. This file cost a
// build on the way into the package by being guarded the obvious way; it is the
// third file in ParleyKit to learn it.
#if os(iOS)
    import UIKit

    /// The beats an open microphone has, in one place so they cannot drift
    /// apart.
    ///
    /// Two things in this app open the microphone and both of them ring now: a
    /// keyboard dictation and a meeting recording. Between them the hand has to
    /// tell apart a microphone opening, a transcript being delivered, a session
    /// being thrown away, the keyboard leaving while the session carries on,
    /// and a recording ending — all without the eye. Touch is poor at texture —
    /// a `.medium` and a `.rigid` impact are all but the same event to a phone
    /// in a pocket — and good at exactly one thing: **direction**. So the
    /// events that bracket an open microphone are two-beat patterns that move
    /// opposite ways rather than single thumps distinguished by how hard they
    /// are. The dictation start used to be one `.medium` impact and went unfelt
    /// against the keyclick and the finger's own landing; the dismissal used to
    /// be nothing at all, and so did both ends of a meeting recording.
    ///
    /// ## Five shapes
    ///
    /// A new beat has to be one of these or be a sixth on purpose:
    ///
    /// | Shape | Means |
    /// |---|---|
    /// | rising, tight — `.medium` → `.heavy`, 60 ms | a microphone is opening |
    /// | falling, tight — `.heavy` → `.medium`, 60 ms | it closed, and what it heard was kept |
    /// | falling, slow, to almost nothing — `.heavy` → `.light`, 130 ms | the keyboard is leaving, but something is still listening |
    /// | one hard tick — `.rigid` | thrown away; nothing follows |
    /// | level, tight — `.heavy` → `.heavy`, 60 ms | the microphone was taken away from you |
    ///
    /// The two tight patterns are each other played backwards, which is the
    /// point: a stop is the undoing of the start that opened it, and that is
    /// the most literal thing a hand can be told. The slow fall has to stay a
    /// long way from both, because it means nearly the opposite of an ending —
    /// the microphone stayed behind — and it buys that distance twice over, in
    /// how far it drops and in how long it takes.
    ///
    /// The flat pair is the newest and the odd one, and it earns its place by
    /// what it *lacks*. Direction is this file's carrier of intent: a rise is a
    /// thing the user asked to begin, a fall is a thing they asked to end, and
    /// every one of the first four answers a press. The fifth answers no press
    /// at all — it is something that happened *to* them — so it is the one
    /// shape with nowhere to travel, and going nowhere twice is the only
    /// two-beat pattern left that is neither a rise nor a fall. See
    /// `micTakenBySystem`.
    ///
    /// ## Where this lives
    ///
    /// It used to say here that this lived in the keyboard target because every
    /// beat happened there, with the instruction to move it rather than copy it
    /// if that ever changed. It changed. A meeting recording is the app's other
    /// and more important use of the microphone — the one that runs for an hour
    /// with the screen off — and it is the app target that starts and stops
    /// one. So both targets link the one enum, and the two pairs are decided in
    /// the same file, which is what forced the recording's beats to fit the
    /// vocabulary the dictation's had already established rather than invent a
    /// second one beside it.
    ///
    /// **Full Access, and backgrounded processes.** Inside a keyboard extension
    /// the system silently drops haptics unless the user has granted Full
    /// Access, so the keyboard's call sites sit behind
    /// `UIInputViewController.hasFullAccess` to keep that fact in the code
    /// rather than in a bug report. iOS drops them from a backgrounded app too,
    /// which is the same rule arriving on the meeting side: stopping a
    /// recording from the Record tab is a foreground tap and plays, and
    /// stopping it from the Live Activity's ⏹ on a locked screen runs in a
    /// process iOS woke for a few seconds of background time and plays nothing
    /// at all. Neither is worked around, because **nothing here is ever
    /// load-bearing**: a haptic that does not play costs the user nothing,
    /// which is what lets the keyboard stay fully usable without Full Access
    /// (App Review 4.4.1) and what lets the card's ⏹ end a recording in
    /// silence. Every call site fires and does not care — there is no return
    /// value to check and nothing anywhere waits on one. The two-beat patterns
    /// extend that honestly rather than quietly depending on both halves
    /// arriving — half a pattern is still legible as that pattern's first beat,
    /// so each pair leads with the beat that carries the meaning on its own.
    ///
    /// There is no setting for any of this. A device with haptics turned off in
    /// Settings already plays nothing, and a second switch would only be a way
    /// to disagree with the system.
    public enum Haptics {
        /// Held rather than made per call: `prepare()` only helps the generator
        /// it was called on, and a generator created at the moment of the event
        /// is exactly the late one it exists to avoid. That is also why the
        /// two-beat patterns are built from generators named by style rather
        /// than each owning its own pair: `.heavy` is the loud end of all three
        /// of them, and a generator per pattern would warm the same hardware
        /// three times and keep it warm a third as reliably.
        ///
        /// `nonisolated(unsafe)` because every call site is already on the main
        /// thread — a SwiftUI body, a `UIInputViewController`, and a
        /// `@MainActor` recorder — which is also what UIKit requires of
        /// feedback generators. The delayed beats keep that promise
        /// deliberately; see `beat`.
        nonisolated(unsafe) private static let light = UIImpactFeedbackGenerator(style: .light)
        nonisolated(unsafe) private static let medium = UIImpactFeedbackGenerator(style: .medium)
        nonisolated(unsafe) private static let heavy = UIImpactFeedbackGenerator(style: .heavy)
        nonisolated(unsafe) private static let finish = UINotificationFeedbackGenerator()
        nonisolated(unsafe) private static let discard = UIImpactFeedbackGenerator(style: .rigid)

        /// The gap inside the two tight patterns — the rise that opens a
        /// microphone and the fall that closes one. Short enough that the two
        /// impacts are felt as one event that moves rather than as two taps
        /// that happened to be near each other — around here is where a pair
        /// stops being countable and starts being a shape.
        private static let shortGap: TimeInterval = 0.06

        /// The gap inside the leaving pair, twice the tight one.
        ///
        /// Patterns built from the same handful of impacts can only be told
        /// apart by their shape, and the same 60 ms would have made this a
        /// near-mirror that nobody could name with the phone out of sight. The
        /// length is part of the message: leaving is the slowest of them, and
        /// the fall has room to be felt as a fall. `recordingStopped` is the
        /// other falling pattern and it is deliberately the tight one, so this
        /// gap is half of what keeps *leaving* from being mistaken for *over*.
        private static let leaveGap: TimeInterval = 0.13

        /// Warm the engine up before the press that will need it — every
        /// generator the live-session patterns use, which is all three impact
        /// styles. Both presses: the ✕ appears the moment a session starts, so
        /// the beat that answers it has the same claim on being ready as the
        /// one that opened the microphone. And `dictationContinuesInBackground`
        /// has no press of its own to warm on — by the time it fires the
        /// keyboard is already going away — so here is the only place its two
        /// beats can be readied at all.
        public static func prepareForDictation() {
            light.prepare()
            medium.prepare()
            heavy.prepare()
            discard.prepare()
        }

        /// The microphone is opening: `.medium`, then `.heavy` a breath later.
        /// A beat that grows.
        ///
        /// This was one `.medium` thump, and it was missed entirely — not
        /// because it was too weak but because a lone impact says only
        /// "something happened", and something is always happening under a
        /// finger that just pressed a key. The fix is not a harder thump; the
        /// hand is poor at ranking intensities it never feels side by side. The
        /// fix is a direction.
        ///
        /// So the first beat is the *same* `.medium` that shipped before, and
        /// the `.heavy` after it is the whole change. Starting the rise lower —
        /// from `.light` — would have made a cleaner slope and a worse first
        /// millisecond, which is the one that has to be noticed: the complaint
        /// this answers was never "the shape is unclear", it was "I did not
        /// feel it". Nothing about the moment of the press is allowed to get
        /// quieter.
        ///
        /// The first beat is synchronous, on the press rather than the release,
        /// so nothing about the existing responsiveness regresses; only the
        /// second one is scheduled.
        ///
        /// Leading with the *quieter* beat is safe here in a way it would not
        /// be anywhere else in this file. A truncated pattern is a real risk
        /// when the extension is on its way out (see
        /// `dictationContinuesInBackground`), but this fires on a press that
        /// keeps the keyboard on screen — the session it starts is the whole
        /// reason the keyboard stays — so 60 ms later this process is still
        /// running and still frontmost. The rising shape costs nothing it
        /// cannot pay.
        ///
        /// Unchanged by the arrival of the meeting beats, and it is what they
        /// were fitted to: this is the shape `recordingStarted` reuses outright
        /// and the shape `recordingStopped` reverses.
        public static func dictationStarted() {
            medium.impactOccurred()
            beat(heavy, after: shortGap)
        }

        /// The keyboard is being dismissed while a dictation is still running:
        /// `.heavy`, then `.light`. A beat that fades.
        ///
        /// Swiping the keyboard away mid-dictation takes the live transcript
        /// above the keys with it and leaves the user holding a phone that is
        /// still recording with nothing on screen saying so. This is the only
        /// evidence they get, so it says the one thing worth saying: *leaving,
        /// but still here*.
        ///
        /// Deliberately the mirror of `dictationStarted` — the same `.heavy` at
        /// the other end of the slope — because the two are the two ends of one
        /// question: the keyboard arriving to listen, and the keyboard going
        /// while something else listens on. Sharing the loud beat is what makes
        /// them a pair rather than two unrelated buzzes, and leaves direction as
        /// the only thing that can be missed.
        ///
        /// The quiet ends differ — `.medium` opening, `.light` leaving — and
        /// that is not sloppiness about the mirror. The start's quiet beat is
        /// the one under the finger and may not get any quieter than what
        /// already shipped (see `dictationStarted`); this one is a tail nobody
        /// is waiting for, and a fall reads as a fall in proportion to how far
        /// it drops.
        ///
        /// **The second beat may not arrive.** iOS can suspend a keyboard
        /// extension moments after it starts disappearing, and 130 ms is long
        /// enough for that to happen. Which is why this pair leads with
        /// `.heavy`: if only the first beat lands, the user still feels a firm,
        /// unmistakable thump — the loudest part of the shape, and the part
        /// that carries the meaning — and not a tap so faint it reads as
        /// nothing. Losing the tail costs the *shade* of the message, never the
        /// message.
        ///
        /// Left exactly as it was when the recording gained its own pair, and
        /// deliberately not reused for the recording's end: this pattern's
        /// whole content is that something is *still* listening, which is the
        /// one thing a stopped recording is not. See `recordingStopped`, which
        /// is kept clear of it in both dimensions.
        public static func dictationContinuesInBackground() {
            heavy.impactOccurred()
            beat(light, after: leaveGap)
        }

        /// The system took the microphone: `.heavy`, then `.heavy` again a
        /// breath later. A beat that goes nowhere.
        ///
        /// The moment is the user tapping iOS's own dictation key in the strip
        /// below this keyboard (or a call, or Siri): another process opens a
        /// recording session, Parley stops hearing anything, and the words
        /// carry on being spoken into nothing. It is the one interruption where
        /// the user is *most* likely to keep talking, because they have just
        /// pressed a microphone button and have every reason to think one is
        /// listening. Until now the pane's copy was the only thing that told
        /// them, and the pane is the thing they are not looking at.
        ///
        /// **Why flat.** Every other pattern here moves, and the movement is
        /// what says which way the session went: up to open, down to close,
        /// down-and-away to leave. All four answer a press. This one answers
        /// nothing the user did — it is the phone taking something from them
        /// mid-sentence — and giving it a direction would borrow a meaning it
        /// has no right to. A rise would say a microphone opened, which is true
        /// only for somebody else's process. A fall would say this is over,
        /// and it may not be: recovery is republishing, not resurrection, and
        /// the very same session can come back with the transcript intact. So
        /// the shape is the absence of one: the same beat twice, at the tight
        /// 60 ms gap the other pairs use, so that direction is the *only*
        /// dimension it differs in — which is the dimension the hand actually
        /// reads.
        ///
        /// **Why not the tick, and why not `.warning`.** `.rigid`
        /// (`dictationDiscarded`) means thrown away, and nothing was: the words
        /// already spoken are kept and shown. `UINotificationFeedbackGenerator`'s
        /// `.warning` is the system's "what you just did failed", and the user
        /// did not do this — the design doc is explicit that being interrupted
        /// by the phone's own dictation is not a fault but "the user having
        /// used their phone", which is exactly why the pane shows no red for
        /// it. A haptic that apologised would contradict the copy beside it.
        ///
        /// **Why both beats are `.heavy`.** Flatness fixes the shape, not the
        /// volume, and this is the one event competing with a voice that is
        /// still talking and a screen that is not being looked at. It also
        /// keeps the rule every pattern here follows: lead with the beat that
        /// carries the meaning, because the second may not arrive — this fires
        /// from a drain that can land as the extension is being suspended, and
        /// half of a flat pair is still a firm thump and never a fall.
        ///
        /// Warmed by `prepareForDictation`, which already readies `.heavy` for
        /// the two patterns that use it.
        public static func micTakenBySystem() {
            heavy.impactOccurred()
            beat(heavy, after: shortGap)
        }

        /// Warm the engine up for the end of a session that is already
        /// finishing.
        public static func prepareForDelivery() { finish.prepare() }

        /// The transcript is finished and handed over — fired by whichever
        /// process actually inserts it, which is always the keyboard. Once per
        /// session, and never on the failure path: a session that ended in an
        /// error delivered nothing, and saying "done" with the body would be
        /// the wrong news.
        ///
        /// Left exactly as it was when the other two became two-beat patterns,
        /// and not for want of symmetry. The system's success pattern is
        /// already two beats, already means *that worked*, and the user has
        /// learned it from every other app on the phone. A pattern of our own
        /// would trade a meaning they already own for one they would have to
        /// acquire.
        ///
        /// Untouched by the recording beats for the same reason, from the other
        /// direction: this one is about words landing in a text field, which a
        /// meeting never does, so `recordingStopped` could not borrow it either.
        public static func dictationDelivered() { finish.notificationOccurred(.success) }

        /// The session was thrown away: one short, hard tick, on the press.
        ///
        /// A third pattern rather than a reuse of either of the other two,
        /// because it is a third outcome. The success pattern would be
        /// celebrating a delivery that did not happen; the system's `.warning`
        /// would say something went wrong, and nothing did — the user asked for
        /// this. What is left is the feel of the thing itself: shorter and
        /// harder than the beats that opened the microphone, so the two ends of
        /// a session never blur.
        ///
        /// Also left alone. `.rigid` was already the most distinguishable of
        /// these endings, and it is still the only single-beat event in the set
        /// — which is a shape too: nothing follows it, because nothing follows.
        /// `recordingDiscarded` is the same tick calling this, rather than a
        /// second single-beat event beside it, which is what keeps that true.
        public static func dictationDiscarded() { discard.impactOccurred() }

        /// Warm the engine up for a meeting recording, on the tap that starts
        /// one. The meeting's answer to `prepareForDictation`, and it warms
        /// less because a meeting has fewer beats: the rise, and the tick if
        /// the recording is thrown away.
        ///
        /// It genuinely readies `recordingStarted`, which fires a permission
        /// check and an `AVAudioEngine` start after this — near enough for the
        /// warm-up to still be worth something.
        ///
        /// It does **not** meaningfully ready `recordingStopped`, and saying
        /// otherwise would be the lie worth avoiding: the generator stays warm
        /// for a second or two and the stop may be an hour away. Nor is there a
        /// press to warm it on, the way the ✕ warms on the press that starts a
        /// dictation — the press that ends a recording is the press that plays
        /// the beat. So the stop's first impact may be the late one `prepare()`
        /// exists to avoid, by a few milliseconds nobody is timing. That is the
        /// fire-and-don't-care rule collecting on itself, and the alternative —
        /// a timer re-arming the generator through the meeting — would spend an
        /// hour of wake-ups on a haptic that is allowed not to play at all.
        public static func prepareForRecording() {
            medium.prepare()
            heavy.prepare()
            discard.prepare()
        }

        /// A meeting recording has the microphone: the same `.medium` →
        /// `.heavy` rise that opens a dictation, and deliberately not a shape
        /// of its own.
        ///
        /// Whether it should exist at all was the real question, because the
        /// honest objection is that this one is not needed — the Record tab's
        /// button flips to a stop glyph under the finger and a timer starts
        /// counting, which is confirmation the keyboard's mic key cannot give.
        /// But that argues about the *press*, and the press is not what the
        /// beat is for. The button flips synchronously on the tap, before
        /// permission and before the capture comes up, and it has to (see
        /// `MeetingRecorder`'s type doc — a button that waited for the truth is
        /// how the same meeting got recorded twice). So what the screen
        /// confirms is that the tap was heard. This fires from the far side of
        /// that gap, where the microphone is actually open, and it is the only
        /// thing in the app that says *that* to a hand.
        ///
        /// Identical to the dictation rise rather than a fifth pattern because
        /// a microphone opening is one event that the user happens to meet in
        /// two places, and two textures for one meaning is the mistake this
        /// file's first paragraph is about. The separate name is for whoever
        /// reads the call site — `dictationStarted` in `MeetingRecorder` would
        /// be a lie about which of the two this is — and it is a call into the
        /// same body so the two can never come apart in fact.
        ///
        /// It is also what makes `recordingStopped` legible. A fall reads as a
        /// fall against a rise the same hand has felt, and a recording that
        /// only ever buzzed at the end would be back to a lone thump carrying a
        /// direction by itself.
        public static func recordingStarted() { dictationStarted() }

        /// A meeting recording has ended and is kept: `.heavy`, then `.medium`
        /// a breath later. `recordingStarted` played backwards.
        ///
        /// This is the beat the file was missing. Opening the microphone had
        /// two beats and closing it had none, on the app's more important use
        /// of the microphone.
        ///
        /// None of the three existing endings could be borrowed, and each fails
        /// for its own reason:
        ///
        /// - `.success` (`dictationDelivered`) means *the words are in your
        ///   field*. A meeting hands nothing to anything; reusing it would make
        ///   two unlike things feel alike, which is the one thing this file
        ///   spends all its length avoiding.
        /// - `.rigid` (`dictationDiscarded`) means *thrown away*. A stopped
        ///   recording is saved and uploaded — the opposite claim, and the one
        ///   that would matter most to get wrong.
        /// - `.heavy` → `.light` (`dictationContinuesInBackground`) is a fall,
        ///   and a fall is right, but that fall already means *leaving, and
        ///   something is still listening*. Here nothing is.
        ///
        /// So: a fall, because the thing is over, and a fall that comes to rest
        /// instead of trailing away. It stops at `.medium` rather than dropping
        /// to `.light`, and it takes 60 ms rather than 130, and those two
        /// differences are what keep it clear of the leaving pattern in the only
        /// dimensions the hand actually reads. What that leaves is the exact
        /// reverse of the rise that opened the recording — the end of the thing
        /// that beat began, said the most direct way touch can say it.
        ///
        /// Leads with `.heavy`, like every pattern here that could be cut short.
        /// This one is unlikely to be — either the app is frontmost or the beat
        /// was never going to play at all (see the type doc) — but the loud beat
        /// is the one carrying the meaning and the rule costs nothing to keep.
        public static func recordingStopped() {
            heavy.impactOccurred()
            beat(medium, after: shortGap)
        }

        /// A meeting recording was thrown away: the same single `.rigid` tick
        /// as the dictation ✕.
        ///
        /// A beat rather than silence, because discarding is an ending and a
        /// silent ending is the complaint this whole change answers. The
        /// confirmation dialog in front of it means the user is certainly
        /// looking at the screen, so this confirms something already visible —
        /// which costs nothing, against a third way out of a recording that
        /// would otherwise feel unlike the other two for no reason a hand could
        /// name.
        ///
        /// The same tick rather than a shape of its own, because *thrown away*
        /// is one meaning. Dictation's ✕ earned a pattern by being a third
        /// outcome instead of a flavour of stopping, and a meeting's `discard()`
        /// is that same third outcome, only more so: it deletes an audio file.
        /// Two names, one beat — the name is for the call site, the shared body
        /// is what stops them drifting.
        public static func recordingDiscarded() { dictationDiscarded() }

        /// The second half of a two-beat pattern.
        ///
        /// `DispatchQueue.main.asyncAfter` rather than a `Task` or a timer,
        /// because the statics above are `nonisolated(unsafe)` on the promise
        /// that nothing ever touches them off the main thread, and this is the
        /// one place in the file that could break it. Nothing is retained that
        /// would need cancelling: the generator is a static, and a beat that
        /// plays a moment after its pattern was overtaken is a beat, not a bug.
        private static func beat(_ generator: UIImpactFeedbackGenerator, after gap: TimeInterval) {
            DispatchQueue.main.asyncAfter(deadline: .now() + gap) { generator.impactOccurred() }
        }
    }
#endif
