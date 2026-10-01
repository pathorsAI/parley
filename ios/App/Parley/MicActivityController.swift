import ActivityKit
import Foundation
import ParleyKit
import os

/// The app's one handle on the microphone card: the Live Activity that says
/// Parley is holding the microphone for voice typing while the screen is off or
/// another app is in front of this one.
///
/// ## One teller, one card
///
/// `DictationCoordinator` owns the dictation session and the microphone window,
/// and it is the only object that pushes anything in here. It used to be two:
/// `MeetingRecorder` pushed a meeting half, this object held both side by side,
/// and `MicActivityState.derive` arbitrated between them — because neither
/// object could see the other's half and neither should have had to. The
/// meeting half was removed after a release on device
/// (`docs/design/ios-live-activity.md`), which is why this now reads as a thin
/// forwarder into a function that still looks like it is deciding something.
/// It is: `derive` remains the one place "dictation, standby, or no card" is
/// written down, and it remains a free function in ParleyKit so the rule can be
/// tested without a `@MainActor` object that needs a microphone and a device.
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
    /// `Activity.request` has been refused, and asking again cannot help until
    /// something outside this object changes.
    ///
    /// The only thing that can change it is the app coming to the front — that
    /// is what the refusal is usually about — so `appBecameActive()` is the one
    /// place it clears. Not cleared in `end()`: a card that could not start is
    /// not a card that ended, and clearing there would re-arm the retry on the
    /// very next word.
    private var requestRefused = false
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

    /// Everything `DictationCoordinator` has told us.
    private var dictationStartedAt: Date?
    private var window: MicWindowState?
    private var dictationTrouble = false

    private let log = Logger(subsystem: "com.pathors.parley", category: "MicActivity")

    private init() {
        adoptExisting()
    }

    // MARK: what the coordinator says

    /// `startedAt` is nil unless a session is live; `window` is the microphone
    /// window as it stands, open or not.
    func dictationChanged(startedAt: Date?, window: MicWindowState?, trouble: Bool) {
        dictationStartedAt = startedAt
        self.window = window
        dictationTrouble = trouble
        sync()
    }

    // MARK: the card

    /// Re-derive and do the one thing that follows: start, update, or end.
    private func sync() {
        let now = Date()
        let next = MicActivityState.derive(
            dictationStartedAt: dictationStartedAt,
            window: window,
            trouble: dictationTrouble,
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

    /// Start a card.
    ///
    /// **This only works in the foreground**, and ActivityKit says so by
    /// throwing rather than by letting us ask first. That is survivable because
    /// of where the foreground moments are: a microphone window "never starts;
    /// it continues" — it is always opened with the app in front (see
    /// `docs/design/ios-voice-keyboard.md`), because iOS will not let a
    /// backgrounded process open a microphone either. So every state that
    /// deserves a card is born in the foreground, the card is born with it, and
    /// everything that happens afterwards — backgrounded, screen locked — is an
    /// `update`, which has no such rule.
    ///
    /// There is deliberately no retry. A request that failed failed because the
    /// app was not in front, and it will still not be in front a second later;
    /// a loop would spend battery discovering that. The breadcrumb names the
    /// mode so the next person to read Console knows which of the two paths
    /// found itself in the background.
    private func begin(_ state: MicActivityState, at now: Date) {
        // The gate is on starting only. A user who turns Live Activities off
        // mid-recording should still have the card they already have taken
        // down, and `end()` below is what does that.
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        // The "no retry" this file's comment has always claimed, now actually
        // enforced. Without it a refused request is retried at the rate `sync()`
        // is called — and `sync()` is driven from `DictationCoordinator.publish()`,
        // which fires per settled word. A session served over the no-jump path
        // starts with the app already in the background, where `Activity.request`
        // is refused every time, so the failure state was not rare: it was the
        // normal one for the path this feature was built to serve, and it put a
        // synchronous ActivityKit round trip on the main actor dozens of times a
        // minute in a process whose only remaining job was to keep a microphone
        // and a heartbeat alive.
        guard !requestRefused else { return }
        do {
            activity = try Activity.request(
                attributes: MicActivityAttributes(),
                content: ActivityContent(
                    state: state, staleDate: MicActivityPolicy.staleDate(at: now)))
            pushed = state
            cardStartedAt = now
            armRefresh()
        } catch {
            requestRefused = true
            let mode = state.mode.rawValue
            let why = error.localizedDescription
            log.notice("no \(mode, privacy: .public) card: \(why, privacy: .public)")
        }
    }

    /// The app is in front again, so a request that was refused for being in the
    /// background is worth one more attempt.
    ///
    /// Called from `ParleyApp`'s `scenePhase` handler rather than from a
    /// notification observed here, because that is already the one place this
    /// app collects "we are active again" work, and a second subscriber to the
    /// same event is a second thing to keep in step.
    ///
    /// This does not itself start a card — `sync()` will, on the next thing
    /// either half has to say. A foregrounding with nothing recording should not
    /// conjure a card, and `derive` returning nil is what guarantees it cannot.
    func appBecameActive() {
        requestRefused = false
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
    /// microphone window held open for an hour changes its derived state
    /// perhaps twice, so without this the last `staleDate` written would fall
    /// three minutes in and the widget would spend the other fifty-seven
    /// saying the microphone may already be closed. The content really is
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
        // update. Let go of the handle instead. Unreachable in practice now
        // that the card is voice typing only — see
        // `MicActivityPolicy.systemLimit` — but this is the loop that would do
        // the pretending, so this is where the check belongs.
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
    /// object are not — `dictationChanged` is reached from `publish()` and from
    /// property observers, none of which can await. Two changes landing in the
    /// same turn — a session ending and the window it leaves behind being
    /// republished — would otherwise become two unordered tasks, and the loser
    /// would write the older state last. Chaining each onto the previous one
    /// keeps them in the order they were asked for, which is the only order
    /// that is ever right here: the last thing the app said is what is true.
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
