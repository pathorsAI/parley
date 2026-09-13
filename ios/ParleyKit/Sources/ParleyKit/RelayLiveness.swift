import Foundation

/// When to stop believing a relay socket that has not said anything.
///
/// ## The failure this exists for
///
/// A WebSocket can go half-open: the peer is gone, but no FIN ever arrives, so
/// `URLSessionWebSocketTask.receive()` blocks forever and `send` keeps
/// succeeding into a kernel buffer. Nothing errors, nothing closes. The relay
/// client goes on accepting audio, the recorder goes on believing it has a live
/// leg, and the UI goes on saying "Transcribing live" for the rest of the
/// meeting. That is how a 49-minute recording came back with three sentences:
/// not a crash, not an error anyone could have shown — silence that looked
/// exactly like a quiet room.
///
/// Reconnecting is already handled (`ReconnectPolicy`, and the bridge holds the
/// audio spoken in between). The only thing missing was *noticing*.
///
/// ## Why the clock cannot be "how long since a token"
///
/// The obvious measure — time since the last transcript message — is wrong,
/// and quietly so. Soniox emits tokens when there is speech; a room that goes
/// quiet for a minute is a room that produces no messages for a minute. A
/// deadline on transcript traffic alone would kill a perfectly healthy socket
/// every time somebody stopped talking, and the reconnect it triggered would
/// cost a fresh billed session for nothing.
///
/// So liveness is measured against **WebSocket ping/pong**, which is protocol
/// level and does not care what the application has to say: a server that is
/// still there answers a ping whether or not anyone is speaking. Application
/// messages still count — they prove the peer is alive just as well — but the
/// ping is what guarantees the clock keeps being refreshed in a silent room.
///
/// ## Why a deadline and not just the ping's error
///
/// `sendPing`'s completion handler reports a failure when the send itself
/// fails. On the half-open socket it does not fire at all: there is nothing to
/// fail against and nothing to answer. Treating "the ping errored" as the whole
/// signal would therefore miss the exact case this type is named for.
///
/// The ping is not the detector. The ping is what a *healthy* socket uses to
/// keep proving itself; the detector is the deadline that expires when those
/// proofs stop arriving, by whatever means.
public struct RelayLiveness: Sendable, Equatable {

    /// How often to ask the socket to prove it is there.
    ///
    /// Separate from the Soniox application keepalive (`SonioxProtocol
    /// .keepaliveInterval`, 2 s), which exists to stop the *provider* timing
    /// the session out for being idle and is never answered. This one is a
    /// WebSocket ping, and a live peer must answer it.
    public var pingInterval: Duration

    /// Silence longer than this means the peer is gone.
    ///
    /// Three missed pings at the default cadence. Two would be a rough network
    /// away from cutting a healthy session for a fresh billed one; much more
    /// than three and the hole is longer than the hold buffer wants to carry.
    public var deadline: Duration

    public init(pingInterval: Duration = .seconds(5), deadline: Duration = .seconds(15)) {
        self.pingInterval = pingInterval
        self.deadline = deadline
    }

    public static let standard = RelayLiveness()

    /// Anything that proves the peer is still there.
    public enum Proof: Sendable, Equatable {
        /// A frame arrived — transcript, control, anything.
        case message
        /// The peer answered a ping.
        case pong
        /// The socket was just opened. It has not proven anything yet, but it
        /// has not had the chance either, so the deadline runs from here.
        case opened
    }

    /// Whether a socket last heard from at `lastProof` is dead at `now`.
    ///
    /// Clock changes are the reason this is `>=` on a clamped interval rather
    /// than plain subtraction: `Date` is wall time and can jump backwards when
    /// the system syncs, and a negative age must read as "just heard from"
    /// rather than wrap into a large positive one.
    public func isDead(now: Date, lastProof: Date) -> Bool {
        let age = now.timeIntervalSince(lastProof)
        guard age > 0 else { return false }
        return age >= deadlineSeconds
    }

    /// How long a caller may wait before checking again — the ping cadence,
    /// never longer than the deadline it is meant to defend.
    public var checkInterval: Duration {
        pingInterval < deadline ? pingInterval : deadline
    }

    var deadlineSeconds: TimeInterval {
        TimeInterval(deadline.components.seconds)
            + TimeInterval(deadline.components.attoseconds) / 1e18
    }
}
