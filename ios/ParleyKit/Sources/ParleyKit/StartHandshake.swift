import Foundation

/// The keyboard's side of starting a dictation without leaving the app the user
/// is typing in: after publishing a start request, whether to keep waiting for
/// the app, to take its answer, or to give up and open `parley://dictate`.
///
/// ## Why this is more than a timeout
///
/// It was one — `startAckWindow`, 700 ms for *any* downlink carrying the new
/// session id, else the URL. That is plenty for an app that has a microphone
/// to borrow: it publishes `starting` within milliseconds. It is not enough for
/// the app that has to open one first. A Parley lingering in the background
/// after its 30-second hold has run out has no capture left, and opening one
/// from the background is slow when iOS allows it at all — so the app used to
/// say nothing until the microphone was up, the 700 ms ran out first, and the
/// keyboard jumped to Parley over a microphone that was about to open. That was
/// the owner's "the next dictation always jumps to the app".
///
/// So the app now answers in two steps when it has to open the microphone: a
/// **provisional** `starting` the moment it decides to try
/// (`Downlink.openingMicrophone`), then either the session itself or a
/// **refusal** (`needsApp`) if iOS will not give a backgrounded process the
/// microphone. The keyboard keeps the 700 ms for the first sign of life, then
/// gives a provisional answer up to `microphoneWait` to become a real one. A
/// refusal is not waited out: it opens the app at once, which is the only place
/// the microphone can then be opened.
///
/// A value type fed one downlink at a time rather than a function of the last
/// one, because the answers are not monotonic on the wire — the previous
/// session's polish can land a `done` over the provisional `starting` — and
/// what the keyboard has already been told must not be forgotten when that
/// happens.
public struct StartHandshake: Equatable, Sendable {
    /// How long the keyboard waits for the app to say anything at all about a
    /// new session. An awake app answers in milliseconds, provisionally or not;
    /// a suspended or dead one never does, and only the URL can wake it.
    public static let firstAck: TimeInterval = 0.7

    /// How long, from the tap, a provisional answer may stay provisional before
    /// the keyboard stops believing the background start will work and opens
    /// the app after all.
    ///
    /// Longer than a background audio-session activation is expected to take
    /// (the app logs it: "mic start took N ms"), short enough that someone
    /// looking at a pane that already says it is listening is not left talking
    /// into nothing for long if it does not. Past it the app is opened exactly
    /// as it would have been before, and a start that does land late is
    /// harmless: the URL for the same session is a duplicate the app ignores.
    public static let microphoneWait: TimeInterval = 3

    /// What the keyboard should do now.
    public enum Decision: Equatable, Sendable {
        /// Nothing conclusive yet; look again shortly.
        case wait
        /// The app has taken the session up where the user is. The downlink
        /// drives the pane from here.
        case acked
        /// Open `parley://dictate` for this session.
        case openApp
    }

    /// What the app has said about this session so far.
    public enum Heard: Equatable, Sendable {
        case nothing
        /// `starting` while the app is still opening the microphone.
        case provisional
        /// Anything that means the app is serving the session — including an
        /// `error`, which the pane shows where the user is rather than by
        /// jumping to an app that has already said what went wrong.
        case answered
        /// `needsApp`: the app could not open the microphone from the
        /// background.
        case refused
    }

    public private(set) var heard: Heard = .nothing

    public init() {}

    /// Fold in one downlink for this session. Callers filter by session id;
    /// another session's file says nothing about this one.
    ///
    /// A real answer or a refusal is final. A provisional `starting` never
    /// overrides either — it is the earliest thing the app says, so arriving
    /// after one of them it can only be a stale read.
    public mutating func observe(
        _ state: DictationChannel.Downlink.State, openingMicrophone: Bool
    ) {
        switch heard {
        case .answered, .refused:
            return
        case .nothing, .provisional:
            break
        }
        switch state {
        case .needsApp:
            heard = .refused
        case .starting where openingMicrophone:
            heard = .provisional
        default:
            heard = .answered
        }
    }

    /// Convenience for the keyboard, which holds whole downlinks.
    public mutating func observe(_ downlink: DictationChannel.Downlink) {
        observe(downlink.state, openingMicrophone: downlink.isOpeningMicrophone)
    }

    /// The decision `elapsed` seconds after the start request was published.
    public func decide(elapsed: TimeInterval) -> Decision {
        switch heard {
        case .answered:
            return .acked
        case .refused:
            return .openApp
        case .provisional:
            return elapsed < Self.microphoneWait ? .wait : .openApp
        case .nothing:
            return elapsed < Self.firstAck ? .wait : .openApp
        }
    }
}
