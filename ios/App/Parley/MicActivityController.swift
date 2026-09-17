import ActivityKit
import Foundation
import ParleyKit
import os

/// The app's one handle on the microphone card: the Live Activity that says
/// Parley is holding the microphone while the screen is off or another app is
/// in front of this one.
///
/// ## Two halves, one card
///
/// There is one card and two objects that know whether it should exist.
/// `MeetingRecorder` owns the meeting; `DictationCoordinator` owns the
/// dictation session and the microphone window. Neither can see the other's
/// half and neither should have to — a recorder that had to ask about
/// microphone windows before it could say "I am recording" would be a second
/// place the precedence rule is written, and the two would eventually disagree.
/// So each pushes only what it knows, this object holds the two halves side by
/// side, and `MicActivityState.derive` decides which of them the card is about.
/// That function is a free function in ParleyKit for exactly this reason: the
/// rule is worth testing, and it cannot be tested through a `@MainActor` object
/// that needs a microphone and a device.
///
/// ## Nothing here is load-bearing
///
/// Every path that talks to ActivityKit is swallowed. The user can turn Live
/// Activities off for the app, `Activity.request` is refused outright from the
/// background, and the system takes the card away after eight hours whatever
/// anyone wants. None of that may reach a recording: the app has to behave
/// identically with no card at all — which is how it behaved before this file
/// existed, so "inert on failure" is a property worth keeping rather than a
/// concession. The breadcrumbs below are for a developer reading Console; the
/// app never branches on them.
@MainActor
final class MicActivityController {
    static let shared = MicActivityController()

    /// The one activity. Not an array: there is one microphone (see
    /// `MicActivityState`), and a second card could only ever describe a
    /// situation the app does not allow.
    private var activity: Activity<MicActivityAttributes>?
    /// What the card is currently carrying, so an unchanged state is not pushed
    /// again.
    ///
    /// This matters more than it looks. The dictation hook hangs off
    /// `DictationCoordinator.publish()`, which fires on every partial word —
    /// dozens a minute — and the card deliberately carries none of those words
    /// (a lock screen is a public surface; see the design doc). So almost every
    /// call derives a state identical to the last one, and without this the
    /// card would be updated at transcript speed to say exactly what it already
    /// said.
    private var pushed: MicActivityState?
    /// When *the card* started, which is not when the recording did for one
    /// adopted from a previous process. Only `refreshLoop` reads it, to notice
    /// the eight-hour limit.
    private var cardStartedAt: Date?
    private var refresh: Task<Void, Never>?

    /// `MeetingRecorder`'s half.
    private var meetingStartedAt: Date?
    private var meetingTitle: String?
    private var meetingTrouble = false
    /// `DictationCoordinator`'s half.
    private var dictationStartedAt: Date?
    private var window: MicWindowState?
    private var dictationTrouble = false

    private let log = Logger(subsystem: "com.pathors.parley", category: "MicActivity")

    private init() {
        adoptExisting()
    }

    // MARK: the two halves

    /// `MeetingRecorder`'s half of the story. `startedAt` is nil whenever the
    /// recorder does not hold the microphone.
    func meetingChanged(startedAt: Date?, title: String?, trouble: Bool) {
        meetingStartedAt = startedAt
        meetingTitle = title
        meetingTrouble = trouble
        sync()
    }

    /// `DictationCoordinator`'s half. `startedAt` is nil unless a session is
    /// live; `window` is the microphone window as it stands, open or not.
    func dictationChanged(startedAt: Date?, window: MicWindowState?, trouble: Bool) {
        dictationStartedAt = startedAt
        self.window = window
        dictationTrouble = trouble
        sync()
    }

    // MARK: the card

    /// Re-derive from both halves and do the one thing that follows: start,
    /// update, or end.
    private func sync() {
        let now = Date()
        let next = MicActivityState.derive(
            meetingStartedAt: meetingStartedAt,
            meetingTitle: meetingTitle,
            dictationStartedAt: dictationStartedAt,
            window: window,
            trouble: troubleOfWhicheverHalfWins,
            at: now)

        guard let next else {
            // `derive` returning nil is the whole of "there should be no card".
            end()
            return
        }
        if let activity {
            guard next != pushed else { return }
            push(next, to: activity, at: now)
        } else {
            begin(next, at: now)
        }
    }

    /// `derive` takes one `trouble` because the card has one, but the app has
    /// two sources for it and only the half that wins the card may set it.
    ///
    /// Mirroring `derive`'s precedence here rather than OR-ing the two is not
    /// pedantry: `MeetingRecorder.start` calls
    /// `DictationCoordinator.yieldMicrophone()`, so a meeting beginning while a
    /// dictation is up is *the* sequence that leaves a dictation in a terminal
    /// state next to a healthy recording. OR-ing would put the dictation's
    /// obituary on the meeting's card every single time.
    private var troubleOfWhicheverHalfWins: Bool {
        if meetingStartedAt != nil { return meetingTrouble }
        // Dictation owns the standby window too — it is the object that opened
        // it and the only one that can tell you the microphone is gone.
        return dictationTrouble
    }

    /// Start a card.
    ///
    /// **This only works in the foreground**, and ActivityKit says so by
    /// throwing rather than by letting us ask first. That is survivable because
    /// of where the foreground moments are: a meeting is started by a tap on
    /// the Record tab, and a microphone window "never starts; it continues" —
    /// it is always opened with the app in front (see
    /// `docs/design/ios-voice-keyboard.md`), because iOS will not let a
    /// backgrounded process open a microphone either. So every state that
    /// deserves a card is born in the foreground, the card is born with it, and
    /// everything that happens afterwards — backgrounded, screen locked — is an
    /// `update`, which has no such rule.
    ///
    /// There is deliberately no retry. A request that failed failed because the
    /// app was not in front, and it will still not be in front a second later;
    /// a loop would spend battery discovering that. The breadcrumb names the
    /// mode so the next person to read Console knows which of the three paths
    /// found itself in the background.
    private func begin(_ state: MicActivityState, at now: Date) {
        // The gate is on starting only. A user who turns Live Activities off
        // mid-recording should still have the card they already have taken
        // down, and `end()` below is what does that.
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        do {
            activity = try Activity.request(
                attributes: MicActivityAttributes(),
                content: ActivityContent(
                    state: state, staleDate: MicActivityPolicy.staleDate(at: now)))
            pushed = state
            cardStartedAt = now
            armRefresh()
        } catch {
            let mode = state.mode.rawValue
            let why = error.localizedDescription
            log.notice("no \(mode, privacy: .public) card: \(why, privacy: .public)")
        }
    }

    /// Push new content.
    ///
    /// Every content this type ever hands ActivityKit carries a `staleDate`,
    /// and that — not termination detection — is how a force-quit is handled. A
    /// backgrounded app the user swipes away is not guaranteed to run any
    /// teardown at all, so nothing can be relied on to notice its own death.
    /// Instead the card is vouched for for `MicActivityPolicy.staleAfter` at a
    /// time; when the process is gone, the vouching stops and the widget draws
    /// the honest face by itself. See `MicActivityPolicy.staleAfter` for the one
    /// thing that has to be true for this to work.
    private func push(
        _ state: MicActivityState, to activity: Activity<MicActivityAttributes>, at now: Date
    ) {
        pushed = state
        let content = ActivityContent(
            state: state, staleDate: MicActivityPolicy.staleDate(at: now))
        enqueue { await activity.update(content) }
    }

    /// Take the card down now.
    ///
    /// `.immediate` rather than the default: the default leaves a Live Activity
    /// on the lock screen for up to four hours after it ends, and this card's
    /// whole subject is whether the microphone is open *right now*. A stopped
    /// recording that keeps a card is the exact lie the feature exists to
    /// prevent.
    private func end() {
        guard let activity else { return }
        self.activity = nil
        pushed = nil
        cardStartedAt = nil
        refresh?.cancel()
        refresh = nil
        // No `staleDate` on the last content: it is a claim about how long this
        // content can be believed, and this content is being dismissed in the
        // same breath.
        let final = ActivityContent(state: activity.content.state, staleDate: nil)
        enqueue { await activity.end(final, dismissalPolicy: .immediate) }
    }

    /// A card left behind by a previous process.
    ///
    /// **This is the normal case, not the exceptional one.** A Live Activity
    /// outlives the app that started it by design — that is what makes it worth
    /// having — so a cold launch after a jetsam, a crash, or a swipe away will
    /// routinely find one still on the lock screen. Adopting it means the next
    /// `sync()` updates or ends the card the user is actually looking at; not
    /// adopting it means starting a second one beside it, and the first would
    /// then sit there until the system's own eight hours ran out.
    ///
    /// `first` rather than a search: there is only ever one (see `activity`),
    /// and if a bug ever produced two, adopting one and leaving the other is no
    /// worse than adopting neither.
    private func adoptExisting() {
        guard let existing = Activity<MicActivityAttributes>.activities.first else { return }
        activity = existing
        pushed = existing.content.state
        // We cannot ask an `Activity` when it was requested, and the closest
        // honest answer is the state's own `since`: this app starts the card in
        // the same breath as the thing it describes, so the card is never older
        // than that. Erring old only makes the eight-hour check in
        // `refreshLoop` fire early, which costs a card that was about to be
        // taken away anyway.
        cardStartedAt = existing.content.state.since
        armRefresh()
    }

    // MARK: keeping the stale horizon ahead of the card

    /// Re-push the current content on a slow beat.
    ///
    /// The dedupe in `sync()` is right about content and wrong about time: a
    /// meeting that runs for an hour changes its derived state perhaps three
    /// times, so without this the last `staleDate` written would fall three
    /// minutes into the recording and the widget would spend the other
    /// fifty-seven saying the recording may have stopped. The content really is
    /// unchanged — every clock on the card is a `Text(timerInterval:)` the
    /// system ticks on its own — so this pushes the same state again purely to
    /// move the horizon.
    ///
    /// A third of `staleAfter`, so two consecutive beats can be missed (a
    /// suspension, a busy main actor) before the card starts doubting itself.
    /// When `staleAfter` is nil there is no horizon to move and no loop to run:
    /// that is the setting the device spike may force (see
    /// `MicActivityPolicy.staleAfter`), and it costs nothing here.
    private func armRefresh() {
        refresh?.cancel()
        guard let staleAfter = MicActivityPolicy.staleAfter else { return }
        let beat = Duration.seconds(staleAfter / 3)
        refresh = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: beat)
                guard !Task.isCancelled else { return }
                // No `await`: a `Task` started from a `@MainActor` method
                // inherits that isolation, so this is already the main actor.
                self?.refreshNow()
            }
        }
    }

    private func refreshNow() {
        guard let activity, let pushed else { return }
        // Past the system's own limit the card is gone whatever we do, and
        // pushing into it forever would be the app pretending there is one to
        // update. Let go of the handle instead: the Record tab is still right,
        // which is the honest interim the design settles for until "what should
        // a nine-hour recording do" is actually answered.
        if let cardStartedAt,
            MicActivityPolicy.outlivesSystemLimit(since: cardStartedAt, at: Date())
        {
            self.activity = nil
            self.pushed = nil
            self.cardStartedAt = nil
            refresh?.cancel()
            refresh = nil
            return
        }
        push(pushed, to: activity, at: Date())
    }

    // MARK: ordering

    /// ActivityKit's `update` and `end` are `async`, and the calls into this
    /// object are not: a `didSet` cannot await. Two changes landing in the same
    /// turn — `MeetingRecorder.start` moves `phase` and then `startedAt` — would
    /// otherwise become two unordered tasks, and the loser would write the
    /// older state last. Chaining each onto the previous one keeps them in the
    /// order they were asked for, which is the only order that is ever right
    /// here: the last thing the app said is what is true.
    private var work: Task<Void, Never> = Task {}

    private func enqueue(_ body: @escaping @Sendable () async -> Void) {
        let previous = work
        work = Task { @MainActor in
            // `.result` rather than `.value`: the value is `Void`, and awaiting
            // a `Void` is what the compiler reads as an `await` with nothing to
            // wait for. The waiting is the entire point here.
            _ = await previous.result
            await body()
        }
    }
}
