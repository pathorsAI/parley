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

    /// The keyboard's view of the current session. It mints the id, so it owns
    /// the truth about which downlink is "ours"; a downlink for any other
    /// session is a leftover from a previous dictation and is ignored.
    private var session = ""
    private var insertedCount = 0
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

        // The app fires this when the transcript grows; we also drain on every
        // appearance in case the keyboard was suspended through the notification.
        if hasFullAccess {
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
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        bridge.hasFullAccess = hasFullAccess
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
        readWindow()
        drainDownlink()
    }

    /// The keyboard is going away, which is the end of the user's chance to fix
    /// the words in this field — so it is the moment to learn from whatever they
    /// fixed. See `KeyboardLexiconWatch` for what this can and cannot see.
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
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
        up.insertedCount = insertedCount
        DictationChannel.writeUplink(up)
        bridge.listening = false
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
        if d.session != session {
            guard d.state != .error,
                let at = d.updatedAt,
                Date().timeIntervalSince(at) < Self.adoptionWindow,
                DictationChannel.readUplink()?.session == d.session
            else { return }
            session = d.session
            insertedCount = 0
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
        }

        bridge.partial = d.partial
        // The echoed window follows the settled text, not what this process
        // happened to insert: a keyboard that was killed mid-session and came
        // back still shows the sentence in progress.
        bridge.tail = String(d.committed.suffix(Self.tailLimit))
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
        case .done:
            bridge.listening = false
            bridge.reconnecting = false
            bridge.partial = ""
            // The dictated text is all in the field now, so this is the picture
            // any later edit gets compared against.
            lexicon.noteInserted(context: textDocumentProxy.documentContextBeforeInput)
            // The tail stays: the last thing said is worth still being able to
            // read once the button has gone quiet.
        case .error:
            bridge.listening = false
            bridge.reconnecting = false
            bridge.partial = ""
            bridge.tail = ""
            // Surface the app's failure where the user actually is. Swallowing
            // it (the old behavior) read as "the mic button does nothing".
            bridge.errorText = d.errorMessage ?? String(localized: "Couldn't start. Try again.")
        }
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

    /// This tap leaves for Parley rather than recording here: the app is not set
    /// up, or there is no open microphone window to borrow.
    ///
    /// It is what the record button draws instead of a microphone. A mic glyph
    /// that cannot open a mic is the whole bug — and even in the merely
    /// windowless case the honest promise is "this opens Parley", because
    /// staying put depends on a process that may already be gone. When it
    /// happens to still be there, the pane flips to listening in place and the
    /// button becomes ⏹ before the user has read the glyph.
    var opensApp: Bool { hasFullAccess && (!ready || !windowIsOpen) }

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
