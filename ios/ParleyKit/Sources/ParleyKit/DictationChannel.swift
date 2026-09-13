import Foundation

/// The shared channel between the Parley keyboard extension and the container
/// app. A keyboard extension cannot open the microphone (iOS forbids it since
/// iOS 8, Full Access included), so dictation runs in the app and the transcript
/// is handed back through the App Group container.
///
/// Six single-writer mailboxes, each with its own Darwin notification, so the
/// two processes never contend on the same file:
///   - `downlink` (app → keyboard): the growing transcript + session state.
///   - `uplink`   (keyboard → app): the session request, host bundle id, and
///     how it should end — ⏹ (deliver) or ✕ (throw away).
///   - `window`   (app → keyboard): the microphone window — whether the next
///     tap will be served where the user is, or has to open Parley.
///   - `window control` (keyboard → app): end the window now.
///   - `readiness` (app → keyboard): whether dictation could work at all —
///     an account on this device, and microphone permission.
///   - `presence` (app → keyboard): the app process is alive, and whether a
///     start request would be served without opening Parley. A heartbeat,
///     like the window's — see `AppPresence`.
///
/// The window pair is separate from the session pair on purpose: a window
/// outlives any one dictation and most of what it has to say happens when no
/// session exists at all. Readiness is separate from both for the opposite
/// reason: it is not about a moment but about the installation, and it is the
/// one thing here that has to be readable before anything has ever happened.
/// Presence is separate from the window because the two answer different
/// questions — "is the process there" outlives and underlies "is it holding a
/// microphone" — and separate from the downlink because a downlink is stamped
/// only when the transcript moves, and a user pausing to think is not a dead
/// app.
///
/// Darwin notifications carry no payload — they are pure "go re-read" signals.
/// The files are the source of truth, which is what makes this robust to the
/// keyboard being suspended/killed while the app is foregrounded: whatever it
/// missed is still sitting in `downlink` when it comes back (see
/// `KeyboardViewController.drainPending`).
public enum DictationChannel {
    /// Must match the `com.apple.security.application-groups` entitlement on
    /// both the app and the keyboard target.
    public static let appGroup = "group.com.pathors.parley.ios"

    /// app → keyboard: the transcript grew or the state changed.
    public static let downNote = "com.pathors.parley.dictation.down"
    /// keyboard → app: the session should end — ⏹ to deliver the transcript,
    /// ✕ to throw it away (the app is running during dictation, so a Darwin
    /// note reaches it; starting instead goes through the URL so it can launch
    /// a suspended app).
    public static let upNote = "com.pathors.parley.dictation.up"
    /// app → keyboard: the microphone window opened, closed, or ticked. Its own
    /// note rather than `downNote` because the window outlives sessions — most
    /// of what it announces happens when there is no downlink to speak of.
    public static let windowNote = "com.pathors.parley.dictation.window"
    /// keyboard → app: end the microphone window now.
    public static let windowControlNote = "com.pathors.parley.dictation.window-control"
    /// app → keyboard: the answer to "could a tap dictate at all" changed —
    /// someone signed in or out, or the microphone prompt was answered.
    public static let readyNote = "com.pathors.parley.dictation.ready"
    /// app → keyboard: the app re-stamped its presence, or announced that it
    /// is about to be suspended. See `AppPresence`.
    public static let presenceNote = "com.pathors.parley.dictation.presence"

    /// The URL the keyboard opens to start a session. The app routes this in
    /// `onOpenURL`. The session id round-trips so a stale downlink from a prior
    /// dictation is never mistaken for this one.
    public static func startURL(session: String) -> URL {
        URL(string: "parley://dictate?session=\(session)")!
    }

    /// Just open the app, with nothing asked of it. The keyboard uses this when
    /// there is no session worth minting — no account, or no microphone
    /// permission — because a start request in that state can only be answered
    /// with a failure the user has to leave for the app to fix anyway.
    public static let appURL = URL(string: "parley://")!

    public static func session(fromStart url: URL) -> String? {
        guard url.scheme == "parley", url.host == "dictate",
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        else { return nil }
        return items.first { $0.name == "session" }?.value
    }

    // MARK: downlink (app writes, keyboard reads)

    /// Live transcript state the keyboard renders and inserts.
    public struct Downlink: Codable, Sendable {
        public var session: String
        /// Settled text — everything the keyboard should have inserted by now.
        public var committed: String
        /// Tentative tail shown above the keys, never inserted.
        public var partial: String
        public var state: State
        public var errorMessage: String?
        /// When the app last wrote this file (stamped by `writeDownlink`).
        /// Optional so files written before the field existed still decode. The
        /// keyboard uses it to bound how long a finished session's tail is still
        /// worth inserting after a relaunch (see `KeyboardViewController`).
        public var updatedAt: Date?

        /// `CaseIterable` so the wire-format test iterates the states rather
        /// than listing them: a state that decodes to something the other
        /// process does not expect is silent, and a test that has to be
        /// remembered is exactly the one that will not be.
        public enum State: String, Codable, Sendable, CaseIterable {
            case starting, listening, finishing, done, error
            /// The relay socket dropped and the app is redialling it. The
            /// microphone is still open and the audio is being held, so this
            /// is a pause in the words arriving — deliberately not `error`,
            /// which is where the session actually ends.
            case reconnecting
            /// The user pressed ✕: the session ended and the words were thrown
            /// away on purpose.
            ///
            /// A third terminal state rather than a flavour of `done` with an
            /// empty transcript, because the keyboard's rule for `done` is
            /// "insert what is here" and a rule that says "…unless it happens
            /// to be empty" would make an empty result and a discarded one the
            /// same event. It is not `error` either: nothing failed, and the
            /// pane must not show red copy for something the user asked for.
            case cancelled
            /// The system took the microphone — its own dictation, Siri, a
            /// call — and the app is trying to take it back, or has run out of
            /// ways to.
            ///
            /// Deliberately **not** `reconnecting`, which is the socket
            /// dropping under a microphone that is still open and still being
            /// held for. Here the microphone is the thing that is gone, so
            /// "keep talking" would be the one instruction that cannot help:
            /// nothing said while this state is up is captured by anybody. The
            /// pane has to stop claiming to listen the moment it arrives.
            ///
            /// Also not `error`. An error is red copy about a session that is
            /// over; this is a state the user can leave with one tap, it is
            /// what the copy says, and the app may still resume the very same
            /// session in place — a recovery republishes `listening` for the
            /// same id and the transcript carries on where it stopped.
            case micTaken

            /// The session is still being served: a process somewhere is
            /// holding a microphone (or draining a relay) on its behalf. The
            /// three terminal states are claims about the past and stay true
            /// when that process is gone; these four are claims about *now*,
            /// and are the only ones a reader has to doubt.
            ///
            /// `micTaken` is not among them, and that is not an oversight: the
            /// question `isLive` answers is "should a reader keep waiting on
            /// this", and the answer while the microphone is gone is no
            /// whatever the app is doing about it. A live `micTaken` would put
            /// the keyboard back to drawing ⏹ over a microphone nobody has —
            /// which is the bug — and would hand it to the liveness watchdog,
            /// which would eventually cancel a session the app might still
            /// resume. Not-live gets both right: the pane goes honest at once,
            /// and a resume simply publishes `listening` again.
            public var isLive: Bool {
                switch self {
                case .starting, .listening, .reconnecting, .finishing: return true
                case .done, .error, .cancelled, .micTaken: return false
                }
            }
        }

        /// When this live session should be presumed dead unless something
        /// newer arrives: `AppPresence.staleAfter` past the last sign of life,
        /// which is the newer of this file's own stamp and the app's presence
        /// heartbeat. `nil` for a terminal state — there is nothing left to
        /// presume about.
        ///
        /// Two stamps rather than one because they go quiet for different
        /// reasons. The downlink is re-stamped only when the transcript moves,
        /// so a user pausing mid-sentence looks exactly like a dead app from
        /// this file alone; the presence heartbeat keeps going through the
        /// pause. The presence file alone would not do either: it is written by
        /// the *process*, and a process that has crashed and relaunched is very
        /// much present while the session it left behind is not — which is why
        /// the app also reaps such a session on launch (see
        /// `DictationCoordinator`).
        public func presumedDeadAt(presence: AppPresence?) -> Date? {
            guard state.isLive else { return nil }
            var last = updatedAt ?? .distantPast
            if let presence, presence.awake, let at = presence.updatedAt {
                last = max(last, at)
            }
            return last.addingTimeInterval(AppPresence.staleAfter)
        }

        /// A live state nobody has vouched for lately — see `presumedDeadAt`.
        public func looksDead(presence: AppPresence?, at now: Date = Date()) -> Bool {
            guard let deadline = presumedDeadAt(presence: presence) else { return false }
            return now >= deadline
        }

        public init(
            session: String, committed: String = "", partial: String = "",
            state: State = .starting, errorMessage: String? = nil,
            updatedAt: Date? = nil
        ) {
            self.session = session
            self.committed = committed
            self.partial = partial
            self.state = state
            self.errorMessage = errorMessage
            self.updatedAt = updatedAt
        }
    }

    public static func writeDownlink(_ value: Downlink) {
        var stamped = value
        stamped.updatedAt = Date()
        write(stamped, to: "dictation-down.json")
        post(downNote)
    }

    public static func readDownlink() -> Downlink? {
        read("dictation-down.json")
    }

    // MARK: uplink (keyboard writes, app reads)

    /// The keyboard's request to the app.
    public struct Uplink: Codable, Sendable {
        public var session: String
        /// The host app the keyboard was typing into, captured best-effort for
        /// the pre-iOS-26.4 auto-return. `nil` when it could not be resolved.
        public var hostBundleID: String?
        public var stopRequested: Bool
        /// The stop is a ✕ rather than a ⏹: end the session and throw the
        /// transcript away. Always written together with `stopRequested`, so
        /// the request still reads as "end this" to anything that only knows
        /// about ⏹ — this field only says *how* it should end.
        ///
        /// Optional so an uplink written by an older build still decodes: a
        /// synthesized `init(from:)` requires every non-optional key, and a
        /// mailbox that fails to decode reads as "nothing there", which here
        /// would mean a stop request the app never hears.
        public var cancelRequested: Bool?
        /// How much of `committed` the keyboard has already inserted. Persisted
        /// here so a keyboard that was killed mid-session does not double-insert
        /// when it relaunches.
        public var insertedCount: Int

        public init(
            session: String, hostBundleID: String? = nil,
            stopRequested: Bool = false, cancelRequested: Bool? = nil, insertedCount: Int = 0
        ) {
            self.session = session
            self.hostBundleID = hostBundleID
            self.stopRequested = stopRequested
            self.cancelRequested = cancelRequested
            self.insertedCount = insertedCount
        }

        /// The keyboard asked for this session to be thrown away.
        public var wantsCancel: Bool { cancelRequested == true }
    }

    public static func writeUplink(_ value: Uplink) {
        write(value, to: "dictation-up.json")
        post(upNote)
    }

    public static func readUplink() -> Uplink? {
        read("dictation-up.json")
    }

    // MARK: microphone window (app writes state, keyboard writes control)

    /// Publish the window the app is actually holding. Stamped on every write:
    /// the stamp is what lets the keyboard tell an open window from the file a
    /// killed process left behind (see `MicWindowState`).
    public static func writeWindow(_ value: MicWindowState) {
        var stamped = value
        stamped.updatedAt = Date()
        write(stamped, to: "dictation-window.json")
        post(windowNote)
    }

    public static func readWindow() -> MicWindowState? {
        read("dictation-window.json")
    }

    /// The keyboard asking for the window to end now.
    public static func writeWindowControl(_ value: MicWindowControl) {
        write(value, to: "dictation-window-control.json")
        post(windowControlNote)
    }

    public static func readWindowControl() -> MicWindowControl? {
        read("dictation-window-control.json")
    }

    // MARK: readiness (app writes, keyboard reads)

    /// Whether tapping the keyboard's mic could transcribe anything at all.
    ///
    /// The keyboard has no Keychain of its own and no microphone to ask about,
    /// so without this it could only find out by minting a session and reading
    /// back the app's failure — which is why its mic button used to invite a tap
    /// it could not honour. Both facts belong to the *installation* rather than
    /// to a moment: they outlive the app's process, so unlike `MicWindowState`
    /// this needs no heartbeat and no staleness rule. A missing file is not a
    /// stale answer, it is the honest one — Parley has never been set up here.
    public struct KeyboardReadiness: Codable, Sendable, Equatable {
        /// This device holds a Parley session. The app's own gate uses the same
        /// notion, so an offline user who is signed in still counts.
        public var signedIn: Bool
        /// `AVAudioApplication` record permission is granted. Anything else —
        /// denied, or never asked — means the app cannot open the microphone
        /// without the user answering something first.
        public var micGranted: Bool
        /// When the app last wrote this file (stamped by `writeReadiness`).
        /// Optional so files written before the field existed still decode. It
        /// is diagnostic only: nothing reads it to decide whether to believe
        /// the rest, because these facts do not go stale.
        public var updatedAt: Date?

        public init(signedIn: Bool = false, micGranted: Bool = false, updatedAt: Date? = nil) {
            self.signedIn = signedIn
            self.micGranted = micGranted
            self.updatedAt = updatedAt
        }

        /// Both halves are in place, so a tap can actually record.
        public var canDictate: Bool { signedIn && micGranted }
    }

    public static func writeReadiness(_ value: KeyboardReadiness) {
        var stamped = value
        stamped.updatedAt = Date()
        write(stamped, to: "dictation-ready.json")
        post(readyNote)
    }

    public static func readReadiness() -> KeyboardReadiness? {
        read("dictation-ready.json")
    }

    // MARK: presence (app writes, keyboard reads)

    /// Publish that the app process is here. Stamped on every write, like the
    /// window: the stamp is the whole point, since a process that is gone
    /// cannot say so.
    public static func writePresence(_ value: AppPresence) {
        var stamped = value
        stamped.updatedAt = Date()
        write(stamped, to: "dictation-presence.json")
        post(presenceNote)
    }

    public static func readPresence() -> AppPresence? {
        read("dictation-presence.json")
    }

    public static func clear() {
        for name in [
            "dictation-down.json", "dictation-up.json",
            "dictation-window.json", "dictation-window-control.json",
            "dictation-ready.json", "dictation-presence.json",
        ] {
            if let url = container?.appendingPathComponent(name) {
                try? FileManager.default.removeItem(at: url)
            }
        }
    }

    // MARK: file plumbing

    private static var container: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    }

    private static func write<T: Encodable>(_ value: T, to name: String) {
        guard let url = container?.appendingPathComponent(name),
            let data = try? JSONEncoder().encode(value)
        else { return }
        try? data.write(to: url, options: .atomic)
    }

    private static func read<T: Decodable>(_ name: String) -> T? {
        guard let url = container?.appendingPathComponent(name),
            let data = try? Data(contentsOf: url)
        else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    // MARK: Darwin notifications

    public static func post(_ name: String) {
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(name as CFString), nil, nil, true)
    }
}

/// The app saying "I am here", and what a keyboard tap would get from it.
///
/// The keyboard has two questions only the app process can answer, and both
/// are about *now* rather than about the installation:
///
/// 1. **Will a tap stay put?** `KeyboardViewController.startDictation` always
///    tries the no-jump path first — publish the request, wait 700 ms for the
///    app to acknowledge — and only opens `parley://dictate` when nobody does.
///    The record button has to promise one or the other *before* the tap, and
///    it used to promise the jump whenever no microphone window was open, even
///    with Parley in the foreground hosting the keyboard. `servesInPlace` is
///    the app's own answer: it is in the foreground, or it is backgrounded but
///    holding a running microphone (a window) that the next session can borrow.
///    A backgrounded app with no microphone says no, because iOS refuses to let
///    it *start* one — so the keyboard's tap opens Parley, where it can.
///
/// 2. **Is the session I am showing still being served?** A `listening`
///    downlink is re-stamped only when the transcript moves. If the app is
///    suspended or killed mid-session — an audio interruption from the host
///    app, jetsam, the user swiping Parley away — the file keeps saying
///    `listening` forever, and the keyboard kept showing a stop button that
///    nothing answered. This heartbeat is what the keyboard reads instead: a
///    live session whose downlink *and* presence have both gone quiet for
///    `staleAfter` is presumed dead (`Downlink.looksDead`).
///
/// Same staleness rule as `MicWindowState`, for the same reason: the app can
/// stop writing without ever getting to say goodbye. `awake: false` is the
/// goodbye when it does get to — the ~30 s background linger expiring, or the
/// process terminating — so the keyboard need not wait out the stale period in
/// the common case.
public struct AppPresence: Codable, Sendable, Equatable {
    /// The process is running. `false` is written on the way out; a stamp too
    /// old to trust means the same thing.
    public var awake: Bool
    /// A start request published right now would be answered without Parley
    /// coming forward: the app is in the foreground, or it is holding a running
    /// microphone the session can borrow. Meaningless unless `isAwake(at:)`.
    public var servesInPlace: Bool
    /// Last heartbeat (stamped by `DictationChannel.writePresence`).
    public var updatedAt: Date?

    /// How often the app re-stamps while it is awake. Tighter than the
    /// window's 20 s because the thing it bounds — a keyboard showing a stop
    /// button for a session nobody is serving — is on screen and being tapped.
    public static let heartbeat: TimeInterval = 10
    /// How old a stamp may be before a reader stops believing it. Two missed
    /// heartbeats with room to spare, so an app that is merely busy is never
    /// mistaken for one that is gone.
    public static let staleAfter: TimeInterval = 25

    public init(awake: Bool = false, servesInPlace: Bool = false, updatedAt: Date? = nil) {
        self.awake = awake
        self.servesInPlace = servesInPlace
        self.updatedAt = updatedAt
    }

    /// The process is about to be suspended, or is terminating.
    public static let gone = AppPresence(awake: false, servesInPlace: false)

    public func isAwake(at now: Date = Date()) -> Bool {
        guard awake, let updatedAt else { return false }
        return now.timeIntervalSince(updatedAt) < Self.staleAfter
    }

    /// The next tap will be served where the user already is.
    public func canServeInPlace(at now: Date = Date()) -> Bool {
        isAwake(at: now) && servesInPlace
    }
}

/// A live subscription to a Darwin notification. Darwin's C callback cannot
/// capture context, so the observer's `self` pointer is threaded through as the
/// observer argument and unwrapped in the (capture-free) trampoline. Keep the
/// instance alive for as long as you want the notification.
public final class DarwinObserver {
    private let name: String
    private let handler: () -> Void

    public init(_ name: String, handler: @escaping () -> Void) {
        self.name = name
        self.handler = handler
        let this = Unmanaged.passUnretained(self).toOpaque()
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            this,
            { _, observer, _, _, _ in
                guard let observer else { return }
                Unmanaged<DarwinObserver>.fromOpaque(observer)
                    .takeUnretainedValue().handler()
            },
            name as CFString, nil, .deliverImmediately)
    }

    deinit {
        CFNotificationCenterRemoveObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque(),
            CFNotificationName(name as CFString), nil)
    }
}
