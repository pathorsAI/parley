import Foundation

/// The shared channel between the Parley keyboard extension and the container
/// app. A keyboard extension cannot open the microphone (iOS forbids it since
/// iOS 8, Full Access included), so dictation runs in the app and the transcript
/// is handed back through the App Group container.
///
/// Seven single-writer mailboxes, each with its own Darwin notification, so the
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
///   - `level` (app → keyboard): how loud the microphone is right now, so the
///     record button can swell with the voice instead of miming it. The
///     fastest of them by an order of magnitude — see `MicLevelReading`.
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
/// app. The level is separate from the downlink for the sharper version of
/// that same reason: it moves whether or not a word does, and the downlink's
/// stamp is what the liveness watchdog reads (see `MicLevelReading`).
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
    /// app → keyboard: a new microphone level. Posted about twelve times a
    /// second while someone is speaking and not at all otherwise, which makes
    /// it the only note here that is a stream rather than an event — and the
    /// reason its mailbox is not a field on the downlink. See
    /// `MicLevelReading`.
    public static let levelNote = "com.pathors.parley.dictation.level"

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

    // MARK: microphone level (app writes, keyboard reads)

    /// Publish how loud the microphone is. Stamped on every write, like the
    /// window and the presence heartbeat, and for a sharper version of the same
    /// reason: a reader that believed an unstamped level would draw a swollen
    /// button for a voice that stopped — or for a process that died — until
    /// something else happened to take the pane out of its listening shape.
    ///
    /// Caller-throttled rather than throttled here, because the throttle has to
    /// be a decision the writer can suspend: the app writes one final
    /// `MicLevelReading.silent` the moment a session ends, and that write must
    /// not be the one the rate limiter swallows. See
    /// `DictationCoordinator.publishKeyboardLevel`.
    public static func writeMicLevel(_ value: MicLevelReading) {
        var stamped = value
        stamped.updatedAt = Date()
        write(stamped, to: "dictation-level.json")
        post(levelNote)
    }

    public static func readMicLevel() -> MicLevelReading? {
        read("dictation-level.json")
    }

    public static func clear() {
        for name in [
            "dictation-down.json", "dictation-up.json",
            "dictation-window.json", "dictation-window-control.json",
            "dictation-ready.json", "dictation-presence.json",
            "dictation-level.json",
        ] {
            if let url = container?.appendingPathComponent(name) {
                try? FileManager.default.removeItem(at: url)
            }
        }
    }

    // MARK: file plumbing

    // Module-internal rather than private, and no longer for a reason: this was
    // opened up for `MeetingControlChannel`, a mailbox in the very same App
    // Group container, and that channel went with the Live Activity's meeting
    // mode. Left as-is rather than tightened back to `private` because the next
    // non-dictation mailbox will want the same plumbing and nothing in this
    // module abuses it meanwhile.
    static var container: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    }

    static func write<T: Encodable>(_ value: T, to name: String) {
        guard let url = container?.appendingPathComponent(name),
            let data = try? JSONEncoder().encode(value)
        else { return }
        try? data.write(to: url, options: .atomic)
    }

    static func read<T: Decodable>(_ name: String) -> T? {
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
///    A backgrounded app with no microphone says no, because it cannot know
///    whether iOS will let it *start* one. It still tries when the tap comes,
///    and only a refused activation sends the keyboard's tap through Parley.
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

/// How loud the microphone is right now, so the keyboard's record button can
/// swell with the voice rather than mime listening on a loop.
///
/// ## Why this is a mailbox of its own
///
/// The obvious home for a number about the running session is `Downlink`,
/// beside the transcript it belongs to, and that is the one place it must not
/// go. A downlink is re-stamped *only when the transcript moves*, and that
/// property is load-bearing rather than incidental: `Downlink.presumedDeadAt`
/// takes the newer of the downlink's stamp and the presence heartbeat, and it
/// is what tells the keyboard that a file still saying `listening` belongs to a
/// process nobody is running any more. Several bugs were spent getting that
/// right — a keyboard drawing ⏹ over a microphone iOS had taken away, a stop
/// nobody answered, a jetsammed app leaving a pane listening forever.
///
/// A level moves ten-plus times a second whether or not a word does. Put it on
/// the downlink and that file is re-stamped continuously, so the watchdog whose
/// entire input is the stamp's staleness can never fire, and the mechanism is
/// not weakened but switched off. The cheaper objections point the same way: it
/// would rewrite the whole transcript twelve times a second to carry one
/// `Float`, and it would wake `KeyboardViewController.drainDownlink` — adoption,
/// insertion, the liveness re-arm — for each of them.
///
/// So it is its own file with its own note, like the window and the presence
/// heartbeat, because it answers a different question on a different clock.
///
/// ## Shape: one number, not a trace
///
/// A ring of the last N readings would let the keyboard draw a scrolling
/// waveform, and that is deliberately not what is here. What the pane draws is
/// a button that swells and rings that follow it outward, and both are
/// functions of *how loud it is now*; the history would be written twelve times
/// a second and read for its newest entry alone. It would also be history the
/// reader already has — every earlier value arrived in an earlier note — which
/// only buys something for a reader that was suspended, and a keyboard that
/// missed a second of audio has no use for a second-old waveform when it comes
/// back. The smallest thing that serves the drawing is one `Float`, and the
/// lag a ripple needs is a *derived* value the keyboard makes for itself (see
/// `KeyboardBridge.MicMeter`) rather than one this channel has to carry.
///
/// ## Silence is a value, and it is the resting state
///
/// `level` is normalised and floored, so a room with nobody in it reads as
/// exactly zero rather than as a small permanent shimmer. A missing file, an
/// unstamped one and one the app stopped writing all read as zero too — see
/// `current(at:)`. That is the honest half of the rule the record button used
/// to break: the visualiser is driven by real amplitude, and in silence it is
/// flat.
public struct MicLevelReading: Codable, Sendable, Equatable {
    /// How full the meter is, 0…1, already normalised for drawing — see
    /// `gain`. Not the raw RMS: the shape of that number is a fact about the
    /// microphone, and a reader should be handed "how loud" rather than
    /// something it has to know about audio to use.
    public var level: Float
    /// When the app last wrote this (stamped by
    /// `DictationChannel.writeMicLevel`). Optional so a file written before
    /// this mailbox existed still decodes — and a decoded `nil` reads as
    /// silence, which is the safe answer.
    public var updatedAt: Date?

    /// How often the app publishes while someone is speaking — 12 Hz.
    ///
    /// The floor of the useful range is around 10 Hz: below it a button that
    /// swells arrives visibly after the syllable that caused it, which reads as
    /// lag rather than as a meter. The ceiling is what this costs, and the cost
    /// is not the drawing. **Every write is a file write plus a Darwin post,
    /// and the app is usually backgrounded while a dictation runs** — so each
    /// one is a wake-up in a process iOS is looking for a reason to suspend,
    /// and doubling the rate doubles that bill for a difference nobody can see.
    ///
    /// 12 rather than 15 or 20 because the measurement itself arrives at about
    /// that rate: `AudioCapture` taps 4096 frames at a time, which is ~85 ms at
    /// 48 kHz. A faster mailbox would mostly republish readings that had not
    /// changed and pay full price for them; a slower one would throw away
    /// readings that exist. This is a *minimum* interval rather than a timer,
    /// so a device whose buffers are larger simply publishes less often instead
    /// of publishing stale numbers on a schedule.
    public static let publishInterval: TimeInterval = 1.0 / 12

    /// How old a reading may be before it reads as silence.
    ///
    /// The same stamping-and-staleness rule as `MicWindowState`, and here it is
    /// the only thing standing between a killed app and a button frozen
    /// mid-swell. The keyboard learns about levels from a Darwin note; a
    /// process that has been jetsammed, suspended or swiped away posts none, so
    /// without an expiry the last value written is the last value drawn — and
    /// nothing else would take it down for a long time, since the liveness
    /// watchdog needs ~25 s to give up on the session itself.
    ///
    /// Seven publish intervals, which is a far looser ratio than the window's
    /// or the presence heartbeat's (both a little under three). The asymmetry
    /// is deliberate, because what a wrong answer costs is different at this
    /// speed: a window wrongly read as closed changes a word on screen once,
    /// while a level wrongly read as silence makes the button drop to rest and
    /// jump back — and audio callbacks in a backgrounded app genuinely do
    /// bunch. Still comfortably under a second, which is the number that
    /// matters: a dead app's last reading is gone before anyone could call the
    /// button stuck.
    public static let staleAfter: TimeInterval = 0.6

    /// At or below this the reading *is* silence: the button rests and nothing
    /// ripples. Room tone through a phone microphone normalises to a few
    /// hundredths, and a meter that answers room tone is a meter that is never
    /// flat — which is the whole thing the rule exists to prevent.
    public static let silence: Float = 0.05

    /// What turns `AudioCapture`'s RMS into the 0…1 this carries.
    ///
    /// The capture reports the plain RMS of a chunk, which for speech at the
    /// distance someone holds a phone sits around 0.05–0.25 and essentially
    /// never approaches 1; ×5 puts ordinary speech across the top half of the
    /// meter and leaves headroom for a shout. It is a display mapping, not a
    /// second measurement — the number multiplied here is the same one the
    /// app's own dictation screen has always drawn.
    public static let gain: Float = 5

    /// Nothing is being said. The resting value, and what the app writes once
    /// on its way out of a session so the keyboard is never left mid-swell.
    public static let silent = MicLevelReading(level: 0)

    public init(level: Float = 0, updatedAt: Date? = nil) {
        self.level = level
        self.updatedAt = updatedAt
    }

    /// Normalise a chunk's RMS. Clamped at both ends, which also disposes of a
    /// NaN from an empty chunk: `max(0, .nan)` is 0 here, and a meter that drew
    /// a NaN would not come back.
    public init(rms: Float, updatedAt: Date? = nil) {
        self.init(level: min(1, max(0, rms * Self.gain)), updatedAt: updatedAt)
    }

    /// Nobody has vouched for this reading lately.
    public func isFresh(at now: Date = Date()) -> Bool {
        guard let updatedAt else { return false }
        return now.timeIntervalSince(updatedAt) < Self.staleAfter
    }

    /// Quiet enough to be nothing.
    public var isSilent: Bool { level <= Self.silence }

    /// What a reader should actually draw: the published level while it is
    /// fresh and above the floor, and silence in every other case — stale,
    /// unstamped, or merely quiet. One accessor rather than three checks at the
    /// call site, so "a reading nobody refreshed reads as silence, not as the
    /// last thing seen" cannot be got wrong in one place and right in another.
    public func current(at now: Date = Date()) -> Float {
        guard isFresh(at: now), !isSilent else { return 0 }
        return level
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
