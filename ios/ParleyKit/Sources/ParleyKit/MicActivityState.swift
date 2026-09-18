import Foundation

/// What Parley's Live Activity says — the card on the lock screen and in the
/// Dynamic Island for as long as the app is holding the microphone. See
/// `docs/design/ios-live-activity.md`.
///
/// **There is no `import ActivityKit` here, on purpose.** ActivityKit is iOS
/// only, and this file is where the decisions live: which of the three things
/// the card should show, and when there should be no card. Keeping it to
/// Foundation is what lets `swift test` exercise them on a Mac with no
/// simulator (see `Package.swift`), and it is the reason the type that hands
/// this to ActivityKit is a separate file — `MicActivityAttributes.swift`.
///
/// ## Why one state with three modes rather than three activities
///
/// There is exactly one microphone. The app already enforces that everywhere
/// else — one `AudioCapture`, one `DictationCoordinator`, and a meeting
/// recording that takes the microphone away from a dictation rather than
/// sharing it — so a second Live Activity could only ever describe a situation
/// the app does not allow. Three modes on one card also make the transitions
/// free: a dictation that becomes a meeting is an `update()`, not a dismiss and
/// a start, and the user never sees the card blink.
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
    /// Which of the three ways Parley can be holding the microphone this card
    /// is about.
    ///
    /// `CaseIterable` so the wire-format test iterates the modes rather than
    /// listing them: this type crosses a process boundary into the widget, and
    /// a mode that decodes to something the widget does not draw is silent.
    public enum Mode: String, Codable, Hashable, Sendable, CaseIterable {
        case meeting, dictation, standby
    }

    public var mode: Mode
    /// When the clock on the card started running.
    public var since: Date
    /// When the countdown ends. `standby` only — nil for the other two.
    public var until: Date?
    /// The meeting's name, when it has one. nil means the widget supplies its
    /// own localized default; the app must not send an English fallback, because
    /// the widget is the only side that knows the reader's language.
    public var title: String?
    /// The microphone is gone or the relay is down. The card must say so rather
    /// than keep animating — see *The honesty rule* on the type.
    public var trouble: Bool

    public init(
        mode: Mode, since: Date, until: Date? = nil, title: String? = nil,
        trouble: Bool = false
    ) {
        self.mode = mode
        self.since = since
        self.until = until
        self.title = title
        self.trouble = trouble
    }
}

extension MicActivityState {
    /// What the card should show, given everything the app knows. `nil` means
    /// there should be no card at all.
    ///
    /// Precedence is meeting > dictation > standby, and it is not arbitrary: it
    /// is the order in which the app itself hands the microphone over.
    /// `MeetingRecorder.start` calls `DictationCoordinator.yieldMicrophone`, so
    /// a running meeting has already ended whatever dictation was in progress —
    /// which means that in the moment where both inputs look true, one of them
    /// is simply a coordinator that has not finished tearing down yet, and it is
    /// never the meeting. Standby comes last for the same reason: the window is
    /// the microphone nobody is using, so anything using it outranks it.
    ///
    /// A pure function rather than a method on the coordinator because this is
    /// the one place that ordering is written down, and a rule that can only be
    /// exercised by driving a `@MainActor` object through three subsystems is a
    /// rule nobody tests.
    public static func derive(
        meetingStartedAt: Date?,
        meetingTitle: String?,
        dictationStartedAt: Date?,
        window: MicWindowState?,
        trouble: Bool,
        at now: Date = Date()
    ) -> MicActivityState? {
        if let meetingStartedAt {
            return MicActivityState(
                mode: .meeting, since: meetingStartedAt, title: meetingTitle, trouble: trouble)
        }
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
    /// the claim would come true on every recording longer than three minutes
    /// and mark a perfectly healthy card as doubtful.
    ///
    /// That is survivable only because nothing on the card is a pushed value.
    /// Every clock is a `Text(timerInterval:)`, which the system ticks on its
    /// own from `since` and `until` — so a card that is never updated still
    /// counts correctly. The updates carry `trouble` and the title, not the
    /// time.
    public static let staleAfter: TimeInterval? = 180

    /// The system dismisses a Live Activity eight hours after it starts,
    /// whatever the app wants. Not a policy of ours — a fact to be ahead of,
    /// since a meeting that runs past it loses its card and Parley has to stop
    /// pretending there is one to update.
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
