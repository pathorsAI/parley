import Foundation

/// Whether a meeting's audio is reaching the file, and what has to change when
/// that flips — as a value, so the sequences that matter (a call that outlasts
/// the capture's recovery ladder, a call during a user pause, Stop pressed
/// mid-call) are a few lines in a test rather than a phone call on a device.
///
/// ## The failure this exists for
///
/// A call arrives in the middle of a meeting. `AudioCapture` loses the
/// microphone, probes, and climbs its recovery ladder — which runs out after
/// roughly half a minute, because the phone app holds the input for as long as
/// the call lasts. The capture then reports `.lost(.takenBySystem)`, and the
/// meeting used to answer that by *ending itself*. Every call longer than about
/// thirty seconds ended the recording, and the `.ended` that arrived when the
/// call hung up had nothing left to resume.
///
/// The capture itself was never the problem: it stays armed after giving up and
/// rebuilds on `.ended`, on the app coming forward, or on a media-services
/// reset. What was missing was a meeting willing to wait for it. So a meeting
/// now distinguishes two reasons the audio stops:
///
/// - the person paused (`userPaused`), which they undo; and
/// - the system holds the microphone (`systemHeld`), which undoes itself.
///
/// Either one stops the clock. Only the second suspends the live-transcription
/// socket, because the first already has a design of its own (the socket stays
/// up while a person pauses — see `MeetingRecorder.pause()`), while a call can
/// last an hour and an idle relay leg is closed by the server long before that.
///
/// The microphone being *lost for good* — the audio stack refused for a reason
/// that is not another client holding it — is the one case that still ends the
/// meeting, so what was captured is saved and uploaded rather than left behind
/// a recording that records nothing.
public struct MeetingHold: Sendable, Equatable {

    public enum Event: Sendable, Equatable {
        /// The person tapped Pause.
        case userPaused
        /// The person tapped Resume.
        case userResumed
        /// The system took the microphone: a call, Siri, an alarm, another
        /// app's recording session, a media-services reset. Includes the
        /// capture giving up on its ladder while something else holds the
        /// input — that is still a wait, not an end.
        case micTaken
        /// The capture rebuilt and is producing audio again.
        case micBack
        /// The audio stack refused for a reason nobody will undo.
        case micBroken
        /// The meeting ended (Stop, Discard). Whatever was held is moot.
        case stopped
    }

    /// What the recorder has to do about an event. Every field is a change,
    /// never a level: `nil` means leave it as it is.
    public struct Effects: Sendable, Equatable {
        public enum Clock: Sendable, Equatable { case pause, resume }
        public enum Relay: Sendable, Equatable {
            /// Close the live leg (draining what it already has) and do not
            /// redial while the microphone is gone.
            case suspend
            /// Dial a fresh leg; the bridge places it at the recorded position.
            case reconnect
        }

        public var clock: Clock?
        public var relay: Relay?
        /// Save and upload what was captured.
        public var endMeeting: Bool

        public init(clock: Clock? = nil, relay: Relay? = nil, endMeeting: Bool = false) {
            self.clock = clock
            self.relay = relay
            self.endMeeting = endMeeting
        }

        public static let none = Effects()
    }

    public private(set) var userPaused = false
    public private(set) var systemHeld = false

    public init() {}

    /// Audio is reaching the file. What the clock shows: recorded time, so a
    /// call costs the timer nothing, exactly as a pause does.
    public var isCapturing: Bool { !userPaused && !systemHeld }

    public mutating func apply(_ event: Event) -> Effects {
        let wasCapturing = isCapturing
        var relay: Effects.Relay?
        var endMeeting = false

        switch event {
        case .userPaused:
            userPaused = true
        case .userResumed:
            userPaused = false
        case .micTaken:
            // A second report for the same hold — `.interrupted`, then the
            // ladder's `.lost` half a minute later — says nothing new.
            if !systemHeld {
                systemHeld = true
                relay = .suspend
            }
        case .micBack:
            if systemHeld {
                systemHeld = false
                relay = .reconnect
            }
        case .micBroken:
            endMeeting = true
        case .stopped:
            userPaused = false
            systemHeld = false
            return .none
        }

        let clock: Effects.Clock? =
            wasCapturing == isCapturing ? nil : (isCapturing ? .resume : .pause)
        return Effects(clock: clock, relay: relay, endMeeting: endMeeting)
    }
}
