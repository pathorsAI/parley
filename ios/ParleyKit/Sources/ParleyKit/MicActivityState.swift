import Foundation

/// What Parley's Live Activity says — the card on the lock screen and in the
/// Dynamic Island for as long as the app is holding the microphone **for voice
/// typing**. A meeting recording holds the same microphone and gets no card;
/// see `derive` for why, and `docs/design/ios-live-activity.md` for the history
/// behind it.
///
/// **There is no `import ActivityKit` here, on purpose.** ActivityKit is iOS
/// only, and this file is where the decisions live: which of the two things
/// the card should show, and when there should be no card. Keeping it to
/// Foundation is what lets `swift test` exercise them on a Mac with no
/// simulator (see `Package.swift`), and it is the reason the type that hands
/// this to ActivityKit is a separate file — `MicActivityAttributes.swift`.
///
/// ## Why one state with two modes rather than two activities
///
/// There is exactly one microphone. The app already enforces that everywhere
/// else — one `AudioCapture`, one `DictationCoordinator`, and a meeting
/// recording that takes the microphone away from a dictation rather than
/// sharing it — so a second Live Activity could only ever describe a situation
/// the app does not allow. Two modes on one card also make the transition
/// free: a standby window that becomes a dictation is an `update()`, not a
/// dismiss and a start, and the user never sees the card blink.
///
/// ## The honesty rule
///
/// Everything on this card is a claim about *right now*, made by a process that
/// may be suspended, jetsammed, or holding a microphone the system has taken
/// back. A card that keeps its clock running through any of that is lying in
/// the one place the user cannot correct it — they are looking at a lock
/// screen, not at Parley. So `trouble` exists to say so, and the card must
/// prefer saying "something is wrong" to continuing to animate. `MicActivityPolicy`
/// is the other half of the same rule: a horizon past which the card stops
/// believing itself even if nobody got the chance to set `trouble`.
public struct MicActivityState: Codable, Hashable, Sendable {
    /// Which of the two ways Parley can be holding the microphone *for voice
    /// typing* this card is about. A meeting recording is a third way of
    /// holding it and is deliberately not a case here — see `derive`.
    ///
    /// `CaseIterable` so the wire-format test iterates the modes rather than
    /// listing them: this type crosses a process boundary into the widget, and
    /// a mode that decodes to something the widget does not draw is silent.
    public enum Mode: String, Codable, Hashable, Sendable, CaseIterable {
        case dictation, standby
    }

    public var mode: Mode
    /// When the clock on the card started running.
    public var since: Date
    /// When the countdown ends. `standby` only — nil for a dictation, which
    /// runs until the user stops it.
    public var until: Date?
    /// The microphone is gone or the relay is down. The card must say so rather
    /// than keep animating — see *The honesty rule* on the type.
    public var trouble: Bool

    public init(
        mode: Mode, since: Date, until: Date? = nil, trouble: Bool = false
    ) {
        self.mode = mode
        self.since = since
        self.until = until
        self.trouble = trouble
    }
}

extension MicActivityState {
    /// What the card should show, given everything the app knows. `nil` means
    /// there should be no card at all.
    ///
    /// Precedence is dictation > standby, and it is not arbitrary: it is the
    /// order in which the app itself hands the microphone over. The window is
    /// the microphone nobody is using — held open only so the keyboard's mic
    /// does not have to leave the app you are typing in — so anything actually
    /// using it outranks it.
    ///
    /// **A meeting recording takes the same microphone and produces no card at
    /// all.** That is the answer to the thing the next reader will notice first:
    /// starting a meeting makes a live card disappear rather than turn red.
    /// `MeetingRecorder.start` calls `DictationCoordinator.yieldMicrophone()`,
    /// which ends the session and closes the window, so both inputs below go nil
    /// and this function correctly returns nil. It is the behaviour, not a bug —
    /// the card carried a meeting mode for one release and it was removed after
    /// the founder used it on a device (see `docs/design/ios-live-activity.md`).
    /// The "one microphone" fact is untouched by that: it is still why there is
    /// one card rather than one per subsystem, and still why a dictation
    /// outranks a standby window.
    ///
    /// A pure function rather than a method on the coordinator because this is
    /// the one place that ordering is written down, and a rule that can only be
    /// exercised by driving a `@MainActor` object through three subsystems is a
    /// rule nobody tests.
    public static func derive(
        dictationStartedAt: Date?,
        window: MicWindowState?,
        trouble: Bool,
        at now: Date = Date()
    ) -> MicActivityState? {
        if let dictationStartedAt {
            return MicActivityState(mode: .dictation, since: dictationStartedAt, trouble: trouble)
        }
        // `isOpen(at:)` is what keeps a window left behind by a killed process
        // off the lock screen: it weighs the heartbeat as well as the expiry,
        // and a stale stamp reads as a window that ended when the process did.
        // It also guarantees both dates below are present.
        if let window, window.isOpen(at: now), let openedAt = window.openedAt {
            return MicActivityState(
                mode: .standby, since: openedAt, until: window.expiresAt, trouble: trouble)
        }
        return nil
    }
}

/// How long the card is allowed to believe itself, and how long the system will
/// keep it at all.
public enum MicActivityPolicy {
    /// How long the card believes itself without a refresh from the app. Past
    /// it the widget draws the state as unverified rather than as live, which
    /// ActivityKit does for us if we hand every `ActivityContent` a
    /// `staleDate`.
    ///
    /// **This constant is the lever for a question the device spike has not
    /// answered yet.** It is not confirmed that `activity.update()` reaches a
    /// Live Activity while Parley is backgrounded holding a recording audio
    /// session; the behaviour is reported to work in the simulator and to fail
    /// on device for apps with the `audio` background mode. If the spike says
    /// background updates do not land, this becomes `nil`: a card that cannot
    /// be refreshed must not carry a claim about when it goes stale, because
    /// the claim would come true on every microphone window longer than three
    /// minutes and mark a perfectly healthy card as doubtful.
    ///
    /// That is survivable only because nothing on the card is a pushed value.
    /// Every clock is a `Text(timerInterval:)`, which the system ticks on its
    /// own from `since` and `until` — so a card that is never updated still
    /// counts correctly. The updates carry `trouble`, not the time.
    public static let staleAfter: TimeInterval? = 180

    /// The system dismisses a Live Activity eight hours after it starts,
    /// whatever the app wants. Not a policy of ours — a fact to be ahead of, so
    /// that Parley lets go of the handle rather than pretending there is a card
    /// left to update.
    ///
    /// Nothing the card describes can plausibly reach it now that meetings are
    /// off it: a dictation stops itself at `dictationLimit` and the longest
    /// microphone window is an hour. The check stays anyway, because it costs
    /// one comparison a minute and it guards the refresh loop, which is the part
    /// that would otherwise push into an activity the system has already taken
    /// away.
    public static let systemLimit: TimeInterval = 8 * 3600

    /// How long one dictation session may run before `DictationCoordinator`
    /// stops the microphone itself — the safety cap that keeps a session
    /// somebody forgot about from burning the hosted quota.
    ///
    /// **It lives here, rather than in the coordinator that enforces it,
    /// because the widget has to know it too.** A `Text(timerInterval:)`
    /// reserves the width of the *widest* value its range can reach, up front,
    /// so the range handed to a dictation clock is what decides whether the
    /// card lays out for `2:00` or for `8:00:00`. The widget extension cannot
    /// import the app target, and a second literal `120` in
    /// `MicActivityWidget.swift` would go stale the first time this number is
    /// tuned — silently, since the only symptom is a clock a little too wide.
    /// So the coordinator reads it from here and the card's range is derived
    /// from the same constant.
    public static let dictationLimit: TimeInterval = 120

    /// The stale horizon for a content update published at `now`. `nil` when
    /// `staleAfter` is — meaning "make no claim", not "stale immediately".
    public static func staleDate(at now: Date = Date()) -> Date? {
        staleAfter.map { now.addingTimeInterval($0) }
    }

    /// An activity started at `since` has outlived what the system will keep.
    public static func outlivesSystemLimit(since: Date, at: Date) -> Bool {
        at.timeIntervalSince(since) >= systemLimit
    }
}
