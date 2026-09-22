import ParleyKit
import SwiftUI
import UIKit

/// The Parley dictation keyboard.
///
/// A keyboard extension is forbidden from opening the microphone, so this
/// keyboard doesn't try. Its mic button opens `parley://dictate`; the container
/// app records and streams the transcript back through the App Group; this
/// keyboard shows it live above the keys and, when the session is done, inserts
/// the finished text in one `textDocumentProxy.insertText`. The design and its
/// constraints are written up in `docs/design/ios-voice-keyboard.md`.
///
/// Everything expensive (audio, the relay, any model) stays in the app. This
/// process only shuttles text, which keeps it well under the tight jetsam limit
/// keyboard extensions run against.
final class KeyboardViewController: UIInputViewController {
    private let bridge = KeyboardBridge()
    private var down: DarwinObserver?
    /// The app announcing that the microphone window opened, closed, or ticked.
    /// It is what lets a tap that will stay put look different from a tap that
    /// will jump — see `MicWindowState`.
    private var windowNote: DarwinObserver?
    /// The app announcing that the answer to "could a tap dictate at all"
    /// changed — a sign-in, a sign-out, or the microphone prompt being answered.
    private var readyNote: DarwinObserver?
    /// The app's heartbeat: it is alive, and whether a tap would be served
    /// without opening it. Also the goodbye it writes on its way out. See
    /// `AppPresence`.
    private var presenceNote: DarwinObserver?
    /// A new microphone level. The fastest note on this channel by an order of
    /// magnitude — about twelve a second while someone is speaking, none at all
    /// while nobody is — so its handler is deliberately the cheapest in this
    /// file: one small file read and two multiplies. See `MicLevelReading`.
    private var levelNote: DarwinObserver?

    /// Watches the session this keyboard is showing for signs that nobody is
    /// serving it any more — see `checkLiveness`. One at a time; re-armed on
    /// every sign of life.
    private var liveness: Task<Void, Never>?
    /// When this keyboard minted or adopted the session it is showing. Before
    /// the app has published anything for it, this is the only clock there is.
    private var sessionStartedAt = Date.distantPast
    /// When ⏹ was pressed for the current session, if it has been. The app
    /// answers a stop by publishing `finishing` within milliseconds; a session
    /// still `listening` seconds later is one nobody heard the stop for.
    private var stopRequestedAt: Date?

    /// The keyboard's view of the current session. It mints the id, so it owns
    /// the truth about which downlink is "ours"; a downlink for any other
    /// session is a leftover from a previous dictation and is ignored.
    private var session = ""
    private var insertedCount = 0
    /// A session the user threw away with ✕.
    ///
    /// The app answers a cancel by publishing `cancelled`, which inserts
    /// nothing — but the two can cross in flight: ✕ is reachable through
    /// `finishing`, which is where the transcript spends its polish round trip,
    /// and a `done` published a beat before the tap would otherwise be drained
    /// and pasted afterwards. Remembering the id makes that impossible here
    /// rather than merely unlikely, and it survives the app answering slowly or
    /// not at all.
    private var cancelledSession = ""
    /// Learns the user's words from the edits they make right after dictating.
    /// Everything it does lives in `KeyboardLexiconWatch`; this class only tells
    /// it when the text landed and when the editing is over.
    private let lexicon = KeyboardLexiconWatch()
    private var host: UIHostingController<KeyboardRootView>?
    private var heightConstraint: NSLayoutConstraint?

    /// 傳統注音 input for the 注音 pane. Cheap to hold: the dictionary behind it
    /// does not touch its resource until the first syllable is finalized, so a
    /// keyboard that only ever dictates never pays for it.
    private var zhuyin = ZhuyinComposer(dictionary: .bundled)

    /// A keyboard has no intrinsic height — without one it collapses to the
    /// system minimum and the layout looks broken. Every pane is measured to the
    /// same content area (`KBMetrics.height`), but the constraint still follows
    /// the pane so a future pane that isn't can't silently disagree with the
    /// view about it.
    private var preferredHeight: CGFloat {
        KBMetrics.height(bridge.pane)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        bridge.controller = self
        bridge.hasFullAccess = hasFullAccess
        bridge.showsGlobe = needsInputModeSwitchKey
        let typing = TypingKeyboards.enabled().map(KeyboardPane.init)
        bridge.setPanes([.voice] + typing)
        // Without Full Access there is nothing to dictate with, so open on the
        // first pane that still works. App Review 4.4.1 judges the keyboard in
        // exactly this state.
        bridge.setPane(hasFullAccess ? .voice : (typing.first ?? .english), notify: false)

        // Let the system's own input view supply the background. It is already
        // the right colour, already rounds its corners the way the host expects
        // and already covers exactly the area the system keyboard would; a
        // canvas of our own painted over it was what left a seam against the
        // row below and a top-left corner that didn't line up.
        view.backgroundColor = .clear
        // Self-sizing is what makes the system honour a height constraint at
        // all. Without it the constraint below is advisory at best, which is
        // the other half of the same misalignment.
        inputView?.allowsSelfSizing = true

        let root = UIHostingController(rootView: makeRoot())
        root.view.backgroundColor = .clear
        addChild(root)
        view.addSubview(root.view)
        root.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            // Full width: key rows are supposed to reach the screen edges the
            // way system keys do.
            root.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            root.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            // Vertically the safe area, so the bottom row never slides under
            // the home indicator.
            root.view.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            root.view.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
        ])
        root.didMove(toParent: self)
        self.host = root

        // 999 rather than `.defaultHigh`: high enough that the system stops
        // second-guessing the height, still short of required so a
        // compact-height (landscape) layout can shrink us instead of hitting an
        // unsatisfiable constraint.
        let height = view.heightAnchor.constraint(equalToConstant: totalHeight)
        height.priority = UILayoutPriority(999)
        height.isActive = true
        heightConstraint = height

        armChannelObservers()
    }

    /// Subscribe to the five notes the app sends, once Full Access allows it.
    ///
    /// Called from `viewDidLoad` *and* from every `viewWillAppear`, because
    /// `hasFullAccess` is not a fact about the installation — it is a fact about
    /// this process at this moment, which is why `viewWillAppear` already
    /// re-reads it into the bridge. Arming only in `viewDidLoad` made this file
    /// contradict itself: the same value was trusted forever in one place and
    /// distrusted every appearance in the other.
    ///
    /// The window where that mattered is not a corner case, it is the main path.
    /// iOS kills this extension almost every time the user bounces to the app
    /// (see `drainDownlink`), so the *second* dictation of a session is always
    /// served by a freshly loaded keyboard whose `viewDidLoad` ran during an app
    /// switch. A keyboard that read `false` there kept a working-looking voice
    /// pane — the taps still mint sessions — while hearing no downlink, no
    /// window, no readiness and no presence, so the transcript only moved on the
    /// next appearance and ⏹ looked like it did nothing for up to the liveness
    /// watchdog's ~25 s.
    ///
    /// Idempotent on `down`: the five are armed and dropped together, so one of
    /// them being present means all of them are.
    private func armChannelObservers() {
        guard hasFullAccess, down == nil else { return }
        // The app fires this when the transcript grows; we also drain on every
        // appearance in case the keyboard was suspended through the notification.
        down = DarwinObserver(DictationChannel.downNote) { [weak self] in
            DispatchQueue.main.async { self?.drainDownlink() }
        }
        // The app heartbeats an open window, so this note is also what
        // ticks the chip's countdown down — the extension runs no timer of
        // its own for it.
        windowNote = DarwinObserver(DictationChannel.windowNote) { [weak self] in
            DispatchQueue.main.async { self?.readWindow() }
        }
        // Rare compared to the others — signing in and answering the
        // microphone prompt happen once — but it is the note that turns a
        // "set up voice typing" pane into a working one without the user
        // having to dismiss the keyboard and bring it back.
        readyNote = DarwinObserver(DictationChannel.readyNote) { [weak self] in
            DispatchQueue.main.async { self?.readReadiness() }
        }
        // Every ten seconds while the app is awake, and once more on its
        // way out. It is what flips the record button between "speak
        // here" and "this opens Parley", and what keeps a live session's
        // watchdog from firing while the user is merely pausing.
        presenceNote = DarwinObserver(DictationChannel.presenceNote) { [weak self] in
            DispatchQueue.main.async { self?.readPresence() }
        }
        // Twelve a second while somebody is speaking, and nothing at all while
        // nobody is — the one note here that is a stream rather than an event.
        // It is what makes the record button swell with the voice instead of
        // pulsing on a loop that has nothing to do with it.
        levelNote = DarwinObserver(DictationChannel.levelNote) { [weak self] in
            DispatchQueue.main.async { self?.readMicLevel() }
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        bridge.hasFullAccess = hasFullAccess
        // And act on it, rather than only displaying it. See there for why
        // `viewDidLoad` alone was the wrong place to decide this once.
        armChannelObservers()
        // Re-read every time: the user can add or remove keyboards while ours
        // is loaded, and that flips whether the system draws the globe for us.
        bridge.showsGlobe = needsInputModeSwitchKey
        refreshPanes()
        // A half-typed syllable belongs to the field it was started in, so it is
        // dropped rather than committed — the same rule as the transcript tail
        // below, and for the same reason.
        zhuyin.clear()
        publishComposition()
        // The tail belongs to the field it was dictated into. Coming back to a
        // *different* field it would read as text that is already there, so it
        // is dropped unless a session is still running — `drainDownlink` below
        // puts it straight back when one is.
        if !bridge.listening { bridge.tail = "" }
        refreshAppearance()
        refreshReturnKey()
        readReadiness()
        readPresence()
        readWindow()
        // Before the drain, which is what decides whether the pane is live at
        // all: a keyboard coming back mid-sentence should find the button
        // already the right size rather than growing into it.
        readMicLevel()
        drainDownlink()
        // Warm the Taptic Engine while the keyboard is coming up, so the thump
        // lands with the first press on the record button rather than a beat
        // after it. Pointless without Full Access, where a keyboard gets no
        // haptics at all — and where the record button is disabled anyway.
        if hasFullAccess { Haptics.prepareForDictation() }
    }

    /// The keyboard is going away, which is the end of the user's chance to fix
    /// the words in this field — so it is the moment to learn from whatever they
    /// fixed. See `KeyboardLexiconWatch` for what this can and cannot see.
    ///
    /// It is also the moment a running dictation becomes invisible. The live
    /// transcript above the keys goes with the keyboard, the app keeps
    /// recording, and until now nothing in the user's hand said so — so a
    /// session that is still live gets the falling two-beat on the way out. Only
    /// a live one: dismissing the keyboard is an ordinary, constant action, and
    /// a buzz every time is how a signal turns into noise and gets ignored.
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // Before the harvest, not after: the pattern is answering a gesture the
        // user is making right now, and the first beat is the one that has to
        // land with it. `bridge.listening` is the keyboard's own mirror of
        // `DictationChannel.Downlink.State.isLive` — `drainDownlink` sets it for
        // `starting`, `listening`, `reconnecting` and `finishing` and clears it
        // for every terminal state — so it is the liveness test rather than a
        // second flag kept beside it. `reconnecting` is deliberately included:
        // that session's microphone is open and its audio is being held, which
        // is precisely the thing the user is walking away from.
        if hasFullAccess, bridge.listening { Haptics.dictationContinuesInBackground() }
        lexicon.harvest(context: textDocumentProxy.documentContextBeforeInput)
    }

    /// A keyboard follows the appearance of the *field* it is typing into, not
    /// the system's: a dark-themed host app asks for a dark keyboard even while
    /// iOS is in light mode. `textInputMode` changes as the user moves between
    /// fields, so this is re-read whenever the keyboard comes back.
    override func textDidChange(_ textInput: UITextInput?) {
        super.textDidChange(textInput)
        refreshAppearance()
        refreshReturnKey()
    }

    /// The constraint measures the whole input view, but the content is pinned
    /// to the safe area — so the home indicator's strip has to be added on top
    /// of the pane height or the pane gets squeezed by exactly that much.
    private var totalHeight: CGFloat {
        preferredHeight + view.safeAreaInsets.bottom
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        applyHeight(animated: false)
    }

    /// Which typing keyboards the track carries. Re-read on every appearance
    /// rather than watched: the user can flip the toggles in Parley while this
    /// extension is loaded, and there is no notification an extension without
    /// Full Access is allowed to receive.
    private func refreshPanes() {
        let typing = TypingKeyboards.enabled().map(KeyboardPane.init)
        bridge.setPanes([.voice] + typing)
        // The pane we were on may have just been switched off in Settings.
        if !bridge.panes.contains(bridge.pane) {
            bridge.setPane(hasFullAccess ? .voice : (typing.first ?? .english), notify: false)
            applyHeight(animated: false)
        }
    }

    /// Called by the bridge when the user moves between panes.
    func paneDidChange() {
        // Leaving the 注音 pane commits what was pending rather than dropping
        // it: the user swiped away, they didn't press delete.
        apply(zhuyin.confirm())
        applyHeight(animated: true)
    }

    private func applyHeight(animated: Bool) {
        guard let heightConstraint, heightConstraint.constant != totalHeight else { return }
        heightConstraint.constant = totalHeight
        guard animated else { return }
        UIView.animate(withDuration: 0.18) { self.view.superview?.layoutIfNeeded() }
    }

    private func refreshAppearance() {
        let dark = textDocumentProxy.keyboardAppearance == .dark
        if host?.rootView.dark != dark {
            host?.rootView = makeRoot(dark: dark)
        }
    }

    /// The host field decides what the return key is *called* — Go, Send,
    /// Search — and whether it is tinted. It never decides what the key does:
    /// see `KeyboardBridge.newline()`.
    private func refreshReturnKey() {
        let type: UIReturnKeyType? = textDocumentProxy.returnKeyType
        bridge.returnKeyType = type ?? .default
    }

    private func makeRoot(dark: Bool? = nil) -> KeyboardRootView {
        KeyboardRootView(
            bridge: bridge,
            dark: dark ?? (textDocumentProxy.keyboardAppearance == .dark))
    }

    // MARK: dictation control (called from SwiftUI)

    /// How long the keyboard waits for the app to acknowledge a start request
    /// before falling back to opening the app. An awake app publishes the
    /// `starting` downlink within milliseconds of the Darwin note; a suspended
    /// or dead app never will, and the only thing that can wake it is the URL.
    private static let startAckWindow: Duration = .milliseconds(700)

    /// Start a session, preferring the path with no app switch: publish the
    /// request to the App Group (which posts the uplink note) and wait briefly
    /// for the app to acknowledge by publishing our session's downlink. The
    /// app hears the note whenever it is awake — foreground, or lingering in
    /// the background right after a previous dictation — and starts the mic
    /// there, so the user never leaves the app they're typing in. Only when
    /// the ack never comes does `completion` hand back the `parley://dictate`
    /// URL for the visible round trip.
    func startDictation(completion: @escaping (URL?) -> Void) {
        guard hasFullAccess else { return }
        // A new session ends the last one's editing window: anything the user
        // was going to fix, they have finished fixing.
        lexicon.harvest(context: textDocumentProxy.documentContextBeforeInput)
        session = UUID().uuidString
        insertedCount = 0
        sessionStartedAt = Date()
        stopRequestedAt = nil
        DictationChannel.writeUplink(
            .init(
                session: session,
                hostBundleID: KeyboardHost.bundleID(of: self),
                stopRequested: false,
                insertedCount: 0))
        bridge.listening = true
        bridge.partial = ""
        bridge.tail = ""
        bridge.errorText = nil
        bridge.micTaken = false
        // The pane went live before the app has said a word; the watchdog is
        // what takes it back if the app never does (see `checkLiveness`).
        checkLiveness()

        let target = session
        Task { @MainActor [weak self] in
            let deadline = ContinuousClock.now + Self.startAckWindow
            while ContinuousClock.now < deadline {
                try? await Task.sleep(for: .milliseconds(80))
                guard let self, self.session == target else { return }
                if DictationChannel.readDownlink()?.session == target {
                    return  // acked — the app is recording, nobody moved
                }
            }
            guard let self, self.session == target else { return }
            completion(DictationChannel.startURL(session: target))
        }
    }

    // MARK: presence & liveness

    /// Read the app's heartbeat: whether a tap would be served where the user
    /// is, and — while a session is showing — whether anyone is still serving
    /// it. See `AppPresence` for why the downlink alone cannot answer the
    /// second question.
    private func readPresence() {
        guard hasFullAccess else {
            bridge.servesInPlace = false
            return
        }
        bridge.servesInPlace = DictationChannel.readPresence()?.canServeInPlace() ?? false
        checkLiveness()
    }

    /// How long a freshly minted session may go without the app publishing
    /// anything for it before the pane gives up on it. The no-jump path answers
    /// within `startAckWindow`; the URL path answers once the app has come
    /// forward and opened the microphone, which is a couple of seconds at
    /// most — and usually kills this keyboard on the way, in which case none of
    /// this runs. It matters on the path where the switch never happens: the
    /// URL was refused, or the app is gone, and without this the pane would
    /// show a stop button for a session that never existed.
    private static let startGrace: TimeInterval = 10
    /// How long after ⏹ the session may still read `listening` before the
    /// stop is presumed unheard. The app publishes `finishing` synchronously
    /// on receiving the note, before it waits on anything.
    private static let stopGrace: TimeInterval = 3

    /// Decide whether the session on screen is still being served, and if it
    /// cannot be decided yet, come back at the first moment it could be.
    ///
    /// This is the keyboard's half of a problem the channel used to have no
    /// answer to. The downlink says `listening` and stays saying it whatever
    /// happens to the app: an audio interruption from the host app suspends a
    /// backgrounded Parley without a hook, jetsam kills it, the user swipes it
    /// out of the app switcher — and in every case the keyboard kept drawing a
    /// stop button that nothing answered and a transcript slot nothing filled.
    /// Three clocks bound that now, and the earliest one wins:
    ///
    /// - a live downlink's `presumedDeadAt` — its own stamp or the app's
    ///   presence heartbeat, whichever is newer, plus the stale period;
    /// - `startGrace` from minting, for a session the app has not answered;
    /// - `stopGrace` from ⏹, for a session the app has not started ending.
    ///
    /// Giving up is `abandonSession`: the pane is cleared as if ✕ had been
    /// pressed, the app is told the same (a Darwin note it will get the moment
    /// it is resumed, if it ever is), and the slot says what happened.
    private func checkLiveness() {
        liveness?.cancel()
        liveness = nil
        guard hasFullAccess, !session.isEmpty, bridge.listening else { return }

        let now = Date()
        let presence = DictationChannel.readPresence()
        var deadline: Date
        if let d = DictationChannel.readDownlink(), d.session == session {
            // A terminal state has nothing left to watch; `drainDownlink` has
            // already taken the pane out of `listening` for it.
            guard let dead = d.presumedDeadAt(presence: presence) else { return }
            deadline = dead
            if let stopRequestedAt, d.state != .finishing {
                deadline = min(deadline, stopRequestedAt.addingTimeInterval(Self.stopGrace))
            }
        } else {
            deadline = sessionStartedAt.addingTimeInterval(Self.startGrace)
            if let stopRequestedAt {
                deadline = min(deadline, stopRequestedAt.addingTimeInterval(Self.stopGrace))
            }
        }

        if now >= deadline {
            abandonSession()
            return
        }
        let target = session
        let wait = deadline.timeIntervalSince(now) + 0.3
        liveness = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled, let self, self.session == target else { return }
            // Re-read everything first: a segment or a heartbeat may have
            // landed without its note reaching a suspended keyboard.
            self.drainDownlink()
            self.checkLiveness()
        }
    }

    /// Nobody is serving the session on screen. End it here, the way ✕ would,
    /// and say so in the slot — the user has been talking to a stop button.
    private func abandonSession() {
        cancelDictation()
        bridge.errorText = String(localized: "Parley stopped listening. Tap the mic to try again.")
    }

    // MARK: readiness

    /// Read whether the app is in a state where a tap could transcribe at all.
    ///
    /// Deliberately without the staleness rule the window gets: an account and a
    /// microphone grant are facts about the installation, not about a process
    /// that may have died, so the newest file is always the truth. A *missing*
    /// file is not an unknown either — it means Parley has never run here, which
    /// is exactly the state this pane needs to describe.
    private func readReadiness() {
        guard hasFullAccess else {
            bridge.ready = false
            return
        }
        bridge.ready = DictationChannel.readReadiness()?.canDictate ?? false
    }

    // MARK: the microphone level

    /// How fast the drawn level chases the published one, per reading.
    ///
    /// The mailbox arrives at ~12 Hz and a raw sample is not something to draw:
    /// speech is spiky at that resolution, so the button would twitch between
    /// consecutive readings of the same word, and a meter that twitches reads
    /// as broken rather than as responsive. So each reading moves the drawn
    /// value a fraction of the way towards it — a one-pole filter, two
    /// multiplies, no history and no buffer.
    ///
    /// **Asymmetric on purpose.** The rise is fast (0.6: within ~90 % of a new
    /// level in three readings, a quarter of a second) because the swell has to
    /// land *with* the syllable; a slow attack is exactly the lag that makes a
    /// meter feel disconnected from the voice. The fall is slower (0.25, ~90 %
    /// in half a second) because the gaps between words are shorter than the
    /// gaps between sentences: matching them would strobe the button on every
    /// consonant, and what the eye should see between words is a settle, not a
    /// collapse. A voice that actually stops still reaches rest well inside a
    /// second.
    private static let levelAttack: Float = 0.6
    private static let levelRelease: Float = 0.25
    /// The same filter, slower, applied to the already-smoothed level to make
    /// the outer ring — see `KeyboardBridge.MicMeter.trail`. A lagged copy of a
    /// signal *is* a wavefront when it is drawn further out, which is how the
    /// ripple emanates without a repeating animation anywhere in it.
    private static let trailAttack: Float = 0.25
    private static let trailRelease: Float = 0.22

    /// Watches for the app going quiet without saying so — see
    /// `armLevelWatchdog`. At most one, and it ends itself once the meter is at
    /// rest.
    private var levelWatchdog: Task<Void, Never>?

    /// Read the published level and move the meter towards it.
    private func readMicLevel() {
        guard hasFullAccess else { return }
        // `current()` rather than the raw field: a reading nobody has refreshed
        // for `MicLevelReading.staleAfter`, one from a build that did not stamp
        // it, and a missing file all mean silence rather than "whatever was
        // last seen".
        applyMicLevel(DictationChannel.readMicLevel()?.current() ?? 0)
    }

    private func applyMicLevel(_ target: Float) {
        let was = bridge.mic
        let level = Self.chase(
            was.level, towards: target, up: Self.levelAttack, down: Self.levelRelease)
        let trail = Self.chase(
            was.trail, towards: level, up: Self.trailAttack, down: Self.trailRelease)
        let next = KeyboardBridge.MicMeter(level: level, trail: trail)
        // Only when it actually moved. Twelve readings a second is twelve
        // SwiftUI invalidations a second if every one of them publishes, and
        // the values converge on *exactly* zero (see `chase`), so a keyboard
        // sitting in silence redraws nothing at all rather than redrawing the
        // same flat button twelve times.
        if next != was { bridge.mic = next }
        armLevelWatchdog()
    }

    /// One reading's worth of movement towards `target`.
    ///
    /// Snapped to zero at the bottom because an exponential approach never
    /// arrives: without it the meter would idle at a denormal forever, which
    /// costs nothing to draw but means `applyMicLevel` never stops publishing
    /// and the watchdog below never stops looping. Silence has to be reachable,
    /// not approached.
    private static func chase(_ value: Float, towards target: Float, up: Float, down: Float)
        -> Float
    {
        let next = value + (target - value) * (target > value ? up : down)
        return next < 0.002 ? 0 : min(1, next)
    }

    /// Bring the meter to rest when the app stops publishing altogether.
    ///
    /// Staleness alone cannot do it. The keyboard only re-reads the mailbox
    /// when a note arrives, and a process that has been jetsammed, suspended by
    /// an audio interruption or swiped out of the app switcher posts no notes —
    /// so the last level published would be the last level drawn, and the
    /// button would hold a half-swell until the liveness watchdog gave up on
    /// the session ~25 s later. That is precisely the "frozen mid-swell" this
    /// mailbox's staleness rule exists to prevent, and something has to *ask*.
    ///
    /// Cheap by construction: one task at a time, waking once per
    /// `staleAfter` (about 1.6 times a second) and only while the meter is off
    /// its rest, which outside a live session is never. It returns the moment
    /// the meter reaches zero, so a keyboard on an idle pane runs no timer at
    /// all — and a keyboard in a live session runs exactly one, against the
    /// twelve notes a second it is backstopping.
    private func armLevelWatchdog() {
        guard levelWatchdog == nil, bridge.mic != .rest else { return }
        levelWatchdog = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(MicLevelReading.staleAfter))
                guard !Task.isCancelled, let self else { return }
                // Re-reading rather than assuming silence: the app may simply
                // have gone quiet for a beat and stopped writing, in which case
                // the file still holds a fresh-enough reading and the meter
                // should keep chasing it. `applyMicLevel` cannot re-arm us — it
                // finds this task still in place — so there is no recursion
                // here, only the loop.
                self.applyMicLevel(DictationChannel.readMicLevel()?.current() ?? 0)
                guard self.bridge.mic == .rest else { continue }
                // Clearing the handle only on *this* exit, and not in a
                // `defer`, because the other way out is a cancel — and a cancel
                // comes from `restMicLevel`, which has already put the handle
                // down and may have armed a replacement since. A defer would
                // have let a dying task erase its successor, leaving two of
                // these looping with nothing tracking either.
                self.levelWatchdog = nil
                return
            }
        }
    }

    /// Put the meter down now, without waiting for it to decay.
    ///
    /// For the moments the keyboard itself ends a session: there is no voice to
    /// settle from, and a button still coasting down from the last word would
    /// be animating something that is over.
    private func restMicLevel() {
        levelWatchdog?.cancel()
        levelWatchdog = nil
        if bridge.mic != .rest { bridge.mic = .rest }
    }

    // MARK: the microphone window (called from SwiftUI)

    /// Read what the app says about the microphone window.
    ///
    /// The keyboard reads it and never writes it, and it deliberately trusts
    /// `isOpen()` rather than the expiry alone: the app can be killed without
    /// ever writing again, and a chip promising a microphone that no longer
    /// exists would be worse than no chip at all.
    private func readWindow() {
        guard hasFullAccess else {
            bridge.windowIsOpen = false
            return
        }
        // Only whether it is open now. Whether the user has *chosen* a length
        // used to be mirrored too, to decide whether the idle slot should warn
        // that the tap would leave — the pane now says so unconditionally, in
        // the headline and on the button, so there is nothing left to decide.
        let window = DictationChannel.readWindow()
        bridge.windowIsOpen = window?.isOpen() ?? false
        // Rounded up, so "1m" never means "already gone": the number is there
        // to say roughly how much room is left, and rounding down would let the
        // chip read 0.
        bridge.windowMinutesLeft = bridge.windowIsOpen
            ? max(1, Int(((window?.remaining() ?? 0) / 60).rounded(.up)))
            : nil
    }

    /// The keyboard's half of "end it early". A timestamp rather than a flag,
    /// so nothing has to be cleared afterwards and a leftover request cannot
    /// stop the next window from opening.
    func endMicWindow() {
        guard hasFullAccess else { return }
        DictationChannel.writeWindowControl(.init(closeRequestedAt: Date()))
        // Optimistic, and corrected by the app's next note either way: the app
        // may be suspended, in which case the window died with it and the chip
        // was already wrong.
        bridge.windowIsOpen = false
        bridge.windowMinutesLeft = nil
    }

    /// Ask the app to stop and flush the tail. The app is running during
    /// dictation, so the Darwin note reaches it.
    func stopDictation() {
        guard !session.isEmpty else { return }
        var up = DictationChannel.readUplink() ?? .init(session: session)
        up.session = session
        up.stopRequested = true
        up.cancelRequested = false
        up.insertedCount = insertedCount
        DictationChannel.writeUplink(up)
        // The pane keeps its live shape until the app answers: `finishing`
        // keeps ⏹ and ✕ on screen while the transcript is polished, and a
        // stop nobody answers is what the watchdog is for. Going quiet here,
        // as this used to, only meant the next drain put the button back.
        stopRequestedAt = Date()
        checkLiveness()
    }

    /// Ask the app to end the session and throw the words away — the ✕ next to
    /// ⏹.
    ///
    /// The pane goes quiet under the finger rather than a round trip later. The
    /// app has to be told (it is the one holding the microphone and the socket)
    /// but nothing here waits for it to answer: the only thing its reply could
    /// add is a transcript, and a transcript is exactly what the user just said
    /// they did not want. So the echo is cleared now, and `cancelledSession`
    /// makes sure no late downlink for this session can put it back.
    func cancelDictation() {
        guard !session.isEmpty else { return }
        cancelledSession = session
        var up = DictationChannel.readUplink() ?? .init(session: session)
        up.session = session
        // Both flags: `stopRequested` is what makes this read as "end the
        // session" to the whole existing path, and `cancelRequested` is the
        // only thing that says how.
        up.stopRequested = true
        up.cancelRequested = true
        up.insertedCount = insertedCount
        DictationChannel.writeUplink(up)
        liveness?.cancel()
        liveness = nil
        stopRequestedAt = nil
        bridge.listening = false
        bridge.reconnecting = false
        bridge.partial = ""
        bridge.tail = ""
        // Not an error, so nothing is left on screen saying otherwise — the
        // slot goes back to the idle invitation to speak.
        bridge.errorText = nil
        bridge.micTaken = false
        // The button goes back to its resting size under the finger, with the
        // rest of the pane. Letting it coast down from the last word would be
        // the one part of this still animating a session the user just ended.
        restMicLevel()
    }

    /// How old a downlink may be and still get adopted by a keyboard that
    /// didn't mint its session. Sessions are hard-capped at 120 s (the app's
    /// `maxSeconds`), and every segment and state change re-stamps the file, so
    /// anything older is a leftover — a crashed app's frozen `listening` file
    /// or a long-finished transcript that would land in the wrong field.
    private static let adoptionWindow: TimeInterval = 150

    /// How much settled text the keyboard echoes above the record button.
    ///
    /// Since nothing is inserted until the session is done, this echo is the
    /// only place the words are visible while they are being spoken — but it is
    /// still a window, not a transcript. Three lines at this size hold rather
    /// fewer than 140 characters, so the cap is already past what the slot can
    /// show; raising it would only push more of the newest words out of view.
    private static let tailLimit = 140

    /// Read the transcript the app has published, and insert it once the app
    /// says the session is done.
    ///
    /// Nothing is inserted while the session runs. Streaming each delta into the
    /// host field as it settled meant the relay's revisions landed as visible
    /// churn in someone's document, and a dictation abandoned halfway left a
    /// half-sentence behind; the live view above the record button is where the
    /// words belong until they are final.
    ///
    /// Idempotent either way: `insertedCount` is the high-water mark, persisted
    /// through the uplink, so a keyboard killed and relaunched after the session
    /// finished still inserts the transcript exactly once.
    private func drainDownlink() {
        guard hasFullAccess, let d = DictationChannel.readDownlink() else { return }

        // A session the user threw away is finished here, whatever the app goes
        // on to publish for it. `cancelDictation` already cleared the pane, so
        // there is nothing left to read out of this file — and the one thing it
        // could still carry is a transcript that must never reach the document.
        if d.session == cancelledSession { return }

        // A live state nobody has vouched for lately is a session whose
        // process is gone — suspended by an audio interruption, jetsammed,
        // swiped away — and the file it left behind would otherwise keep this
        // pane listening forever. Ours is ended here and now; a stranger's is
        // simply not adopted (the app reaps it on its next launch). Terminal
        // states never look dead, so a `done` still lands after a relaunch
        // exactly as before.
        let presence = DictationChannel.readPresence()
        if d.looksDead(presence: presence) {
            if d.session == session, bridge.listening { abandonSession() }
            return
        }

        // Adopt a session this process didn't mint. iOS kills the keyboard
        // almost every time the user bounces to the app, so on the way back the
        // downlink belongs to a session the (relaunched) keyboard has never
        // heard of — refusing it is what made returning feel dead. (This also
        // covers Action Button sessions, which no keyboard minted.)
        //
        // A foreign downlink is adopted only when it answers the *standing*
        // uplink request and is fresh. The uplink match is what makes this
        // safe: it proves the high-water mark in that uplink belongs to this
        // very session, so nothing already inserted can re-insert — and a
        // keyboard that just minted a new session (its uplink carries the new
        // id) can never resurrect the previous transcript. Errors are never
        // adopted; the message belongs on the app's screen, not in a field.
        // A cancelled one *is* adopted, and safely: what makes `error` special
        // is its message, not its finality, and `cancelled` carries neither a
        // message nor anything to insert. Adopting it is how a keyboard that
        // was killed between the ✕ and the app's answer comes back to an idle
        // pane instead of a session it thinks is still running.
        if d.session != session {
            guard d.state != .error,
                let at = d.updatedAt,
                Date().timeIntervalSince(at) < Self.adoptionWindow,
                DictationChannel.readUplink()?.session == d.session
            else { return }
            session = d.session
            insertedCount = 0
            sessionStartedAt = Date()
            stopRequestedAt = nil
        }

        // A relaunched keyboard restores its position from the uplink it wrote.
        if insertedCount == 0, let up = DictationChannel.readUplink(), up.session == session {
            insertedCount = up.insertedCount
        }

        // One insertion, at the end. `.done` is the only state that has the
        // whole transcript — `finishing` is still waiting on the relay's last
        // utterance — and `.error` deliberately inserts nothing at all: a
        // session that failed leaves the user's field exactly as they left it.
        // The high-water mark is still what makes this safe, because `.done`
        // republishes on every drain and the keyboard drains on every
        // appearance.
        let committed = Array(d.committed)
        if d.state == .done, committed.count > insertedCount {
            textDocumentProxy.insertText(String(committed[insertedCount...]))
            insertedCount = committed.count
            var up = DictationChannel.readUplink() ?? .init(session: session)
            up.insertedCount = insertedCount
            DictationChannel.writeUplink(up)
            // The words just landed in the user's field, and this process is the
            // only one that can say so: the keyboard is the only thing that ever
            // delivers a transcript. The app publishes `done` and stops there,
            // and is usually backgrounded by now, where iOS drops haptics
            // entirely.
            //
            // Once per session for free: the whole branch is behind the
            // `insertedCount` high-water mark, so `done` republishing (and this
            // method running on every appearance) inserts nothing the second
            // time and therefore buzzes nothing. `.error` never reaches it,
            // which is the failure path staying silent.
            //
            // Full Access is the guard at the top of this method: without it
            // there is no App Group to read a transcript from and no haptics to
            // play, and the drain returns before it gets here.
            Haptics.dictationDelivered()
        }

        bridge.partial = d.partial
        // The echoed window follows the settled text, not what this process
        // happened to insert: a keyboard that was killed mid-session and came
        // back still shows the sentence in progress.
        bridge.tail = String(d.committed.suffix(Self.tailLimit))
        // Remembered before the line below throws it away: the `.micTaken`
        // branch has to be able to tell the microphone *being* taken from the
        // app republishing a state it is already in, and the flag is the only
        // record of which. See there.
        let wasMicTaken = bridge.micTaken
        // Cleared before the switch below sets it again, so every state that is
        // not "the microphone is gone" takes the notice down — a resumed session
        // included, which is the whole point of it being recoverable.
        bridge.micTaken = false
        switch d.state {
        case .starting, .listening: 
            bridge.listening = true
            bridge.reconnecting = false
        case .reconnecting:
            // Still a live session: the app's microphone is open and the audio
            // is being held for the next relay leg. Saying so — rather than
            // going quiet, or showing the red error copy — is the difference
            // between "hold on" and "that didn't work".
            bridge.listening = true
            bridge.reconnecting = true
        case .finishing:
            bridge.listening = true
            bridge.reconnecting = false
            // The transcript is one AI-polish round trip away from landing;
            // warm the engine now so the pattern is not a beat late. Cheap to
            // repeat on the drains that follow.
            Haptics.prepareForDelivery()
        case .done:
            bridge.listening = false
            bridge.reconnecting = false
            bridge.partial = ""
            // The dictated text is all in the field now, so this is the picture
            // any later edit gets compared against.
            lexicon.noteInserted(context: textDocumentProxy.documentContextBeforeInput)
            // The tail stays: the last thing said is worth still being able to
            // read once the button has gone quiet.
        case .cancelled:
            // The app confirming a ✕. For the keyboard that pressed it this is
            // never reached — that process cleared the pane on the spot and
            // returns at the top, on `cancelledSession`. This branch belongs to
            // the one that did *not*: killed between the tap and the answer,
            // relaunched, and reading the ending out of the file. It says the
            // same nothing.
            bridge.listening = false
            bridge.reconnecting = false
            bridge.partial = ""
            bridge.tail = ""
            bridge.errorText = nil
        case .micTaken:
            // The pane stops claiming to listen — that claim is the bug. The
            // notice takes the slot from the echo while it is up, but `tail` is
            // kept rather than cleared, and so is the session id: if the app wins
            // the microphone back it publishes `listening` for this same session
            // and the pane comes back with the sentence still in it.
            bridge.listening = false
            bridge.reconnecting = false
            bridge.partial = ""
            bridge.errorText = nil
            bridge.micTaken = true
            // The one moment on this pane the user is most likely to keep
            // talking into nothing, and until now the copy in the slot was the
            // only thing that said so — copy on a keyboard the user is not
            // looking at, because they are looking at the field they are
            // dictating into or at the system dictation key they just pressed.
            //
            // Once per transition, not once per drain. The app republishes
            // `micTaken` on every heartbeat for as long as the microphone is
            // gone, and `drainDownlink` also runs on every appearance, so
            // firing on the state rather than on entering it would buzz for
            // seconds. `wasMicTaken` is that edge — captured above, before the
            // unconditional clear that precedes this switch.
            //
            // Full Access is the guard at the top of this method, the same one
            // `dictationDelivered` relies on: without it there is no App Group
            // to read this state from and no haptics to play anyway.
            if !wasMicTaken { Haptics.micTakenBySystem() }
        case .error:
            bridge.listening = false
            bridge.reconnecting = false
            bridge.partial = ""
            bridge.tail = ""
            // Surface the app's failure where the user actually is. Swallowing
            // it (the old behavior) read as "the mic button does nothing".
            bridge.errorText = d.errorMessage ?? String(localized: "Couldn't start. Try again.")
        }
        // Nothing that is not live has a level. One line here rather than the
        // same line in each of the four terminal branches above: whatever took
        // the pane out of its listening shape, the meter goes with it. Idle
        // drains cost nothing — `restMicLevel` publishes only if something
        // moved, and a `done` being republished moves nothing.
        if !bridge.listening { restMicLevel() }
        // Every drain is a sign of life or the end of one; either way the
        // watchdog's deadline moved.
        checkLiveness()
    }

    /// Open the container app from the extension. The classic responder-chain
    /// `openURL:` walk was disabled for keyboards in iOS 18; SwiftUI's `openURL`
    /// environment action is the public path that still works, so the mic
    /// button in `KeyboardRootView` uses that. This UIKit fallback covers older
    /// systems where the responder walk still succeeds.
    func openContainerApp(_ url: URL) {
        var responder: UIResponder? = self
        let sel = NSSelectorFromString("openURL:")
        while let r = responder {
            if r.responds(to: sel) {
                r.perform(sel, with: url)
                return
            }
            responder = r.next
        }
    }

    // MARK: 注音 (called from SwiftUI)

    /// A bopomofo key.
    func zhuyinSymbol(_ symbol: Character) { apply(zhuyin.symbol(symbol)) }

    /// A tone key: finalize the syllable and show its candidates.
    func zhuyinTone(_ tone: ZhuyinTone) { apply(zhuyin.tone(tone)) }

    /// The user picked a character out of the candidate bar.
    func zhuyinPick(_ candidate: String) { apply(zhuyin.pick(candidate)) }

    /// Do whatever the composer asked for, then republish what it is holding.
    ///
    /// `passThrough` is the composer saying "nothing was pending" — which is
    /// how space, delete and return keep their ordinary meanings on every other
    /// pane without the panes having to know a composer exists.
    private func apply(
        _ outcome: ZhuyinComposer.Outcome, passThrough: () -> Void = {}
    ) {
        switch outcome {
        case .handled: break
        case .insert(let text): textDocumentProxy.insertText(text)
        case .passThrough: passThrough()
        }
        publishComposition()
    }

    private func publishComposition() {
        if bridge.composition != zhuyin.reading { bridge.composition = zhuyin.reading }
        if bridge.candidates != zhuyin.candidates { bridge.candidates = zhuyin.candidates }
    }

    // MARK: keys (called from SwiftUI)

    /// Delete edits the 注音 buffer before it edits the document — the candidate
    /// bar first, then the syllable slot by slot — and only reaches the field
    /// once there is nothing pending. See `ZhuyinComposer.delete()`.
    func deleteBackward() {
        apply(zhuyin.delete()) { textDocumentProxy.deleteBackward() }
    }

    func insert(_ text: String) { textDocumentProxy.insertText(text) }

    /// Return always types a line break. A keyboard extension cannot submit a
    /// form — there is no public way to fire the host's return action — so a
    /// key labelled "Send" that quietly did nothing would be worse than one
    /// that visibly types.
    ///
    /// With a 注音 syllable pending it commits that instead, the way the system
    /// keyboard does: the first return closes the composition, the next one
    /// breaks the line.
    func insertReturn() {
        apply(zhuyin.confirm()) { textDocumentProxy.insertText("\n") }
    }

    /// How close two taps on the space bar have to be to count as the period
    /// shortcut rather than two spaces.
    private static let doubleSpaceWindow: TimeInterval = 0.35
    private var lastSpaceAt = Date.distantPast

    /// Space, with iOS's double-tap-for-a-period shortcut. The second tap only
    /// becomes ". " when it is actually ending a word — after punctuation or at
    /// the start of a line, two taps are just two spaces, which is what the
    /// system does too.
    ///
    /// On the 注音 pane space is the first tone and then the confirm key, so a
    /// pending syllable claims it first.
    func insertSpace() {
        switch zhuyin.space() {
        case .handled:
            publishComposition()
            return
        case .insert(let text):
            textDocumentProxy.insertText(text)
            publishComposition()
            return
        case .passThrough:
            break
        }

        let now = Date()
        let context = textDocumentProxy.documentContextBeforeInput ?? ""
        if now.timeIntervalSince(lastSpaceAt) < Self.doubleSpaceWindow,
            context.hasSuffix(" "),
            let previous = context.dropLast().last,
            previous.isLetter || previous.isNumber
        {
            textDocumentProxy.deleteBackward()
            textDocumentProxy.insertText(". ")
            // Reset rather than re-arm, so a third tap can't chain into "..".
            lastSpaceAt = .distantPast
            return
        }
        textDocumentProxy.insertText(" ")
        lastSpaceAt = now
    }
}

/// One pane on the track. Dictation and typing are different enough — different
/// keys, different shape — to be separate panes rather than one crowded layout,
/// and English and 注音 are different enough from each other for the same
/// reason.
///
/// Flat rather than `.voice` + `.typing(TypingKeyboard)` because that is how it
/// is used: the view switches on a pane and the metrics table names a height for
/// each, and a nested case would put a `case .typing(.english)` in front of
/// every one of those without buying anything.
enum KeyboardPane: String, Hashable, CaseIterable {
    case voice
    case english
    case zhuyin

    init(_ typing: TypingKeyboard) {
        switch typing {
        case .english: self = .english
        case .zhuyin: self = .zhuyin
        }
    }
}

/// Bridges the UIKit input controller to the SwiftUI view: published state the
/// view renders, and actions it invokes. Kept tiny — no transcript history, no
/// audio, nothing that grows.
final class KeyboardBridge: ObservableObject {
    weak var controller: KeyboardViewController?

    @Published var hasFullAccess = false
    @Published var listening = false
    /// The app lost the relay socket and is redialling it. Still listening —
    /// this only changes what the caption says, never whether the session is
    /// alive.
    @Published var reconnecting = false
    @Published var partial = ""
    /// The last stretch of settled text for the running session, shown above
    /// the record button in a softer ink so dictation reads as continuous.
    ///
    /// It is a short window, not history: the transcript lands in the host's
    /// document in one piece when the session is done, and until then this is
    /// where the words are visible. Capped at `tailLimit` characters, cleared
    /// with the session — a few hundred bytes, nowhere near the transcript
    /// store the extension deliberately doesn't keep.
    @Published var tail = ""
    /// Whether the system wants *us* to draw a next-keyboard key. False from
    /// iPhone X onwards, where iOS draws its own beneath the keyboard and the
    /// HIG asks us not to repeat it. See `GlobeKey`.
    @Published var showsGlobe = false
    /// The app's failure for the last session (sign-in, mic permission,
    /// connection), shown in the caption slot until the next start.
    @Published var errorText: String?
    /// The system took the microphone away from the app — its own dictation,
    /// Siri, a call — and Parley could not get it back.
    ///
    /// Its own flag rather than an `errorText`, because it is neither an error
    /// nor a caption: the pane has to stop claiming to listen, and what it shows
    /// instead is a state the user leaves with one tap. Cleared by the next start
    /// and by any other downlink state, including the app publishing `listening`
    /// again for the same session when the microphone comes back.
    @Published var micTaken = false

    /// What the record button is doing with the user's voice, smoothed and
    /// ready to draw. Two `Float`s, published together.
    ///
    /// One property rather than two `@Published` fields because they always
    /// move together and two would invalidate the view twice for one reading —
    /// twelve times a second, in a process running against a jetsam limit.
    /// `Equatable` for the other half of the same economy: `applyMicLevel`
    /// drops a reading that did not move anything, which in silence is every
    /// reading.
    struct MicMeter: Equatable {
        /// How loud it is now, 0…1, already smoothed
        /// (`KeyboardViewController.chase`). Drives the button's swell.
        var level: Float
        /// The same voice a beat ago: `level` put through a slower filter, so
        /// it is always a little behind. Drives the outer ring, and being
        /// behind is the whole point — a lagged copy drawn further out is a
        /// wavefront, which is how the ripple travels outward without a
        /// repeating animation to carry it.
        var trail: Float

        /// Nothing is being said, and nothing is being drawn. Both halves have
        /// to be exactly zero: `level` at rest is a button at its normal size,
        /// and `trail` at rest is the ripple *gone* rather than merely faint.
        static let rest = MicMeter(level: 0, trail: 0)

        /// There is a voice to draw. In silence this is false and the pane
        /// leaves the rings out of the tree entirely.
        var isAudible: Bool { level > 0 || trail > 0 }
    }

    @Published var mic = MicMeter.rest

    /// Parley is set up far enough for a tap to actually transcribe: an account
    /// on this device, and microphone permission granted. False when the
    /// readiness file is missing too, which is what "Parley has never run here"
    /// looks like from inside the extension.
    ///
    /// The pane used to offer a mic button in every state, so someone who had
    /// never opened the app tapped a button that could only fail — the bug this
    /// exists to close. See `DictationChannel.KeyboardReadiness`.
    @Published var ready = false

    /// The microphone window is open: the next tap will be served where the
    /// user already is, with no trip through Parley.
    @Published var windowIsOpen = false
    /// Roughly how long the open window has left, in whole minutes. Refreshed
    /// by the app's heartbeat rather than by a timer in this process.
    @Published var windowMinutesLeft: Int?
    /// The app itself says a tap would be served without opening it: it is in
    /// the foreground (this keyboard is typing into Parley), or it is holding a
    /// running microphone. From its presence heartbeat, so it goes false on its
    /// own once the app stops stamping. See `AppPresence`.
    @Published var servesInPlace = false

    /// The next tap records here, with no trip through Parley: the app is set
    /// up, and either a microphone window is open or the app says it is in a
    /// position to answer in place.
    ///
    /// Two sources rather than one because they fail differently. The window
    /// is a promise the app made about a microphone it is holding; presence is
    /// the app's own reading of its situation, which also covers the case the
    /// window cannot — Parley in the foreground hosting this very keyboard,
    /// where a tap has always stayed put and the button used to say it would
    /// leave.
    var staysPut: Bool { hasFullAccess && ready && (windowIsOpen || servesInPlace) }

    /// This tap leaves for Parley rather than recording here: the app is not set
    /// up, or nothing says it could answer where the user is.
    ///
    /// It is what the record button draws instead of a microphone.
    var opensApp: Bool { hasFullAccess && !staysPut }

    /// The track, in order: the voice pane, then the typing keyboards the user
    /// has enabled in Parley's Settings. Never empty of typing panes — see
    /// `TypingKeyboards.enabled()`.
    @Published private(set) var panes: [KeyboardPane] = [.voice, .english]

    /// Which pane is showing. Changing it also has to change the keyboard's
    /// height, which only the controller can do — hence `setPane` rather than a
    /// plain assignment.
    @Published private(set) var pane: KeyboardPane = .voice

    /// A 注音 syllable part-way through being typed, shown in the strip. Empty
    /// when nothing is pending, which is also what puts the wordmark back.
    @Published var composition = ""
    /// The characters the composition could be, most frequent first. Only
    /// non-empty once the syllable has a tone.
    @Published var candidates: [String] = []

    /// What the host field wants the return key to say. It never changes what
    /// the key does.
    @Published var returnKeyType: UIReturnKeyType = .default

    var paneIndex: Int { panes.firstIndex(of: pane) ?? 0 }

    func setPanes(_ panes: [KeyboardPane]) {
        guard self.panes != panes else { return }
        self.panes = panes
    }

    func setPane(_ pane: KeyboardPane, notify: Bool = true) {
        guard self.pane != pane, panes.contains(pane) else { return }
        self.pane = pane
        if notify { controller?.paneDidChange() }
    }

    /// Move one pane along the track. Clamped rather than wrapped: the rubber
    /// band at each end says there is nothing further, and a swipe that jumped
    /// from 注音 back to the mic would contradict it.
    func stepPane(by delta: Int) {
        let target = paneIndex + delta
        guard panes.indices.contains(target) else { return }
        setPane(panes[target])
    }

    var returnKeyLabel: LocalizedStringKey {
        switch returnKeyType {
        case .go: return "Go"
        case .send: return "Send"
        case .search: return "Search"
        case .done: return "Done"
        case .next: return "Next"
        default: return "return"
        }
    }

    /// The same meaning as `returnKeyLabel`, as a glyph.
    ///
    /// The voice pane's return is a 44pt disc with no room for "Search", and
    /// the pane keeps its only colour on the record button — so it says what
    /// the key does with a symbol instead of a word. The letter pane, which has
    /// a wide key and follows the system's look, still uses the label.
    var returnKeyGlyph: String {
        switch returnKeyType {
        case .go: return "arrow.right"
        case .send: return "paperplane.fill"
        case .search: return "magnifyingglass"
        case .done: return "checkmark"
        case .next: return "arrow.right.to.line"
        default: return "return"
        }
    }

    /// iOS tints the return key when the host has asked for an action rather
    /// than a line break, so the key reads as the way forward.
    var returnKeyIsAccented: Bool {
        switch returnKeyType {
        case .go, .send, .search, .done: return true
        default: return false
        }
    }

    /// Start a session. `completion` fires only when the app has to be opened
    /// (the no-jump Darwin start wasn't acknowledged) with the URL for the
    /// SwiftUI `openURL` action.
    func start(completion: @escaping (URL?) -> Void) {
        controller?.startDictation(completion: completion)
    }
    /// Older-iOS fallback when `openURL` reports the app didn't open.
    func fallbackOpen(_ url: URL) { controller?.openContainerApp(url) }
    /// Close the microphone window from here rather than making the user go
    /// and find the app.
    func endWindow() { controller?.endMicWindow() }
    func stop() { controller?.stopDictation() }
    /// End the session and throw the words away — the ✕ beside ⏹.
    func cancel() { controller?.cancelDictation() }
    func backspace() { controller?.deleteBackward() }
    func type(_ text: String) { controller?.insert(text) }
    func space() { controller?.insertSpace() }
    func newline() { controller?.insertReturn() }

    // 注音. The composer that answers these lives in the controller, so the
    // view never holds input state of its own.
    func zhuyinSymbol(_ symbol: Character) { controller?.zhuyinSymbol(symbol) }
    func zhuyinTone(_ tone: ZhuyinTone) { controller?.zhuyinTone(tone) }
    func pickCandidate(_ candidate: String) { controller?.zhuyinPick(candidate) }
}

/// Best-effort resolution of the app the keyboard is typing into, for the app's
/// pre-iOS-26.4 auto-return.
///
/// There is no public API. This used to say the id "lives on private getters
/// that Apple nulled out in iOS 26.4", which was true of one of the two things
/// it probed and beside the point for both: it asked the wrong object, and for
/// the ivar it wanted, `responds(to:)` can never be true. Nothing here had ever
/// returned a value on any iOS version, so the auto-return it feeds had never
/// run — a fact hidden behind a version gate that made it look deliberate.
/// `HostBundleID` carries the details and the tests.
///
/// On 26.4+ this is still nil — there Apple really did empty the value — and
/// the app falls back to the manual swipe.
enum KeyboardHost {
    /// The value hangs off the controller's **parent** — the
    /// `_UIViewServiceViewControllerOperator` UIKit puts above an extension's
    /// principal view controller — not off the controller itself. Asking the
    /// controller, which this used to do, could never have worked; see
    /// `HostBundleID` for the second defect that made it doubly dead.
    static func bundleID(of vc: UIInputViewController) -> String? {
        HostBundleID.resolve(from: vc.parent)
    }
}
