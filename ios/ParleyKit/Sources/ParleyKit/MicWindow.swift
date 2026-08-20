import Foundation

/// How long Parley may hold the microphone open after a dictation, so the next
/// tap on the keyboard's mic never has to leave the app being typed into.
///
/// This is **not** a limit on one dictation (that is the coordinator's 120 s
/// `maxSeconds`) and it is not the relay's reconnect ladder. It is the window
/// during which the *process* stays resident with a live audio session, which
/// is the only thing that makes a keyboard tap a no-op instead of an app
/// switch. See `docs/design/ios-voice-keyboard.md`.
///
/// ## Why there is no "until I turn it off"
///
/// The category's reference implementation (Wispr Flow) offers one. Parley
/// deliberately does not, for two reasons that are really the same reason:
///
/// 1. **It is a promise the platform will not let us keep.** A window is a live
///    recording session in a backgrounded app; iOS reclaims those under memory
///    pressure, another app taking the microphone ends ours, and neither event
///    gives us a chance to tell anyone. A bounded window that we close
///    ourselves is something we can be right about. "Until I turn it off"
///    would be a setting that is silently wrong most of the time it is on.
/// 2. **It is the one option with no natural end.** Every other choice
///    eventually turns the microphone indicator off on its own, which is what
///    makes a forgotten window self-correcting. An unbounded one is a
///    microphone left open for a day because someone tapped a picker once.
///
/// One hour is kept because it is bounded, self-terminating, and matches a
/// stretch of writing; the copy next to it says plainly what it costs.
public enum MicWindowLength: String, Codable, CaseIterable, Sendable, Identifiable {
    /// No window. The microphone closes with the dictation, exactly as it did
    /// before this setting existed, and every keyboard tap opens Parley.
    case off
    case fiveMinutes
    case fifteenMinutes
    case oneHour

    public var id: String { rawValue }

    /// `nil` for `.off` — there is no window to give a length to.
    public var seconds: TimeInterval? {
        switch self {
        case .off: return nil
        case .fiveMinutes: return 5 * 60
        case .fifteenMinutes: return 15 * 60
        case .oneHour: return 60 * 60
        }
    }
}

/// What the app publishes about the microphone window, and the only thing the
/// keyboard knows about it.
///
/// The keyboard has to answer one question before the user taps: *will this tap
/// stay put, or will it throw me into Parley?* That is `isOpen(at:)`, and it
/// deliberately takes two things into account rather than one.
///
/// ## Why an expiry is not enough on its own
///
/// The app writes this file; the app can also be killed without ever writing
/// again — jetsam, a crash, the user swiping it out of the app switcher. The
/// file left behind still says "open until 14:35", and a keyboard that believed
/// it would show a ready microphone that does not exist and then jump anyway.
///
/// So the app re-stamps the file every `heartbeat` seconds for as long as the
/// window is really open, and a reader treats a stamp older than `staleAfter`
/// as a window that ended when the process did. One mechanism, two jobs: the
/// same heartbeat is what refreshes the countdown on the keyboard without the
/// extension having to run a timer of its own.
public struct MicWindowState: Codable, Sendable, Equatable {
    /// The user's setting, mirrored here so the keyboard can tell "the feature
    /// is off" (say nothing) from "it is on but the window has closed" (say the
    /// next tap will open Parley). The keyboard has no access to the app's
    /// `UserDefaults`, only to this container.
    public var length: MicWindowLength
    /// When this window was opened. `nil` when no window is open. It is also
    /// what makes closing idempotent: a close requested before this window
    /// began is a request for a window that is already over.
    public var openedAt: Date?
    /// When the app will close it. `nil` when no window is open.
    public var expiresAt: Date?
    /// Last heartbeat. Optional so a file written before this field existed
    /// still decodes — and a decoded `nil` reads as "not open", which is the
    /// safe answer.
    public var updatedAt: Date?

    /// How often the app re-stamps an open window.
    public static let heartbeat: TimeInterval = 20
    /// How old a stamp may be before a reader stops believing the window.
    /// Comfortably more than two heartbeats, so an app that is merely busy is
    /// never mistaken for an app that is gone.
    public static let staleAfter: TimeInterval = 55

    public init(
        length: MicWindowLength = .off, openedAt: Date? = nil,
        expiresAt: Date? = nil, updatedAt: Date? = nil
    ) {
        self.length = length
        self.openedAt = openedAt
        self.expiresAt = expiresAt
        self.updatedAt = updatedAt
    }

    /// No window, remembering only what the user has chosen.
    public static func closed(length: MicWindowLength) -> MicWindowState {
        MicWindowState(length: length)
    }

    /// A window running from `now` for `length`. `nil` for `.off`, which has no
    /// window to open.
    public static func opened(length: MicWindowLength, at now: Date) -> MicWindowState? {
        guard let seconds = length.seconds else { return nil }
        return MicWindowState(
            length: length, openedAt: now, expiresAt: now.addingTimeInterval(seconds),
            updatedAt: now)
    }

    /// The microphone is open right now — so a keyboard tap will be served
    /// where the user already is.
    public func isOpen(at now: Date = Date()) -> Bool {
        guard let expiresAt, let updatedAt, openedAt != nil else { return false }
        return now < expiresAt && now.timeIntervalSince(updatedAt) < Self.staleAfter
    }

    /// Seconds left, floored at zero. Meaningless unless `isOpen(at:)`.
    public func remaining(at now: Date = Date()) -> TimeInterval {
        guard let expiresAt else { return 0 }
        return max(0, expiresAt.timeIntervalSince(now))
    }

    /// Whether a close asked for at `requestedAt` applies to this window.
    ///
    /// The keyboard's "end now" writes a timestamp rather than a flag, so the
    /// app can act on it without either side having to clear anything: a
    /// request is for whatever window was open when it was made, and a window
    /// opened afterwards is simply a different window. That makes a stale
    /// control file harmless instead of a microphone that refuses to open.
    public func closeApplies(requestedAt: Date?) -> Bool {
        guard let requestedAt, let openedAt else { return false }
        return requestedAt >= openedAt
    }
}

/// The keyboard's one request about the window: end it now.
///
/// Deliberately not a field on `Uplink`. The uplink is scoped to a dictation
/// session — it carries the session id and the insertion high-water mark — and
/// the window outlives sessions, is closed while none is running, and must not
/// be able to disturb the one place in this system where an off-by-one costs
/// the user duplicated text.
public struct MicWindowControl: Codable, Sendable, Equatable {
    public var closeRequestedAt: Date

    public init(closeRequestedAt: Date) {
        self.closeRequestedAt = closeRequestedAt
    }
}
