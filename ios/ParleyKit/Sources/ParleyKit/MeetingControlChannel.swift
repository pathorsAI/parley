import Foundation

/// The one thing anything outside the app can ask of a running meeting
/// recording: stop it.
///
/// It exists because the Live Activity's Stop button has to reach
/// `MeetingRecorder`, and a `LiveActivityIntent` runs in the widget extension's
/// process, which shares nothing with the app but the App Group container. So
/// the button writes a file here and posts a Darwin note, exactly as the
/// keyboard's ⏹ does, and the app acts on it.
///
/// ## Why this is not a seventh `DictationChannel` mailbox
///
/// `DictationChannel` describes itself as six mailboxes between the keyboard
/// extension and the app, all of them scoped to dictation — a session id, a
/// transcript, an insertion high-water mark, a microphone window. A meeting
/// recording is none of those things: it is a different subsystem, with a
/// different owner (`MeetingRecorder`, not `DictationCoordinator`), reached by
/// a different process. Filing it there would make that doc comment wrong and
/// invite the next reader to assume a meeting stop and a dictation stop share
/// machinery they do not. The file plumbing *is* shared — same container, same
/// `write`/`read` — because that part is genuinely the same.
///
/// ## Why a timestamp rather than a flag
///
/// The same reason as `MicWindowControl`: neither side has to clear anything.
/// A `stopRequested: true` left behind by the last recording would stop the
/// next one the moment it started, and the only fix would be for the app to
/// write `false` back — a second writer on a single-writer mailbox, and a race
/// with the intent that wrote it. A timestamp is self-scoping: it is a request
/// about whatever recording was running when it was made, and a recording that
/// began afterwards is a different recording.
public struct MeetingControl: Codable, Sendable, Equatable {
    public var stopRequestedAt: Date

    public init(stopRequestedAt: Date) {
        self.stopRequestedAt = stopRequestedAt
    }

    /// Whether a stop asked for at this time applies to a recording that began
    /// at `startedAt`.
    ///
    /// Mirrors `MicWindowState.closeApplies`, and makes acting on this file
    /// idempotent in both directions: a request older than the recording is a
    /// leftover and is ignored, and a request the app has already honoured
    /// stays true forever without doing any further harm, because by then
    /// `startedAt` is nil — there is no recording left to stop.
    public func applies(toRecordingStartedAt startedAt: Date?) -> Bool {
        guard let startedAt else { return false }
        return stopRequestedAt >= startedAt
    }
}

/// The mailbox itself. One direction only — nothing asks the meeting recorder
/// to *start*, because starting needs the microphone and only the app can take
/// it.
public enum MeetingControlChannel {
    /// Live Activity → app: stop the running meeting recording.
    ///
    /// Unlike the five dictation notes, nothing listened for this before the
    /// Live Activity existed; the app-side observer is wired in
    /// `MeetingRecorder`.
    public static let note = "com.pathors.parley.meeting.control"

    public static func write(_ value: MeetingControl) {
        DictationChannel.write(value, to: "meeting-control.json")
        DictationChannel.post(note)
    }

    public static func read() -> MeetingControl? {
        DictationChannel.read("meeting-control.json")
    }
}
