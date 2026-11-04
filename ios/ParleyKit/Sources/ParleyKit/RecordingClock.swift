import Foundation

/// How long a meeting has been recording, across any number of pauses.
///
/// The live screen's timer is a `Text(_:style:.timer)`, which counts up from a
/// date on its own and is handed nothing else. That works for a recording that
/// never stops, and breaks the moment one pauses: the date is the tap on
/// Start, so the digits would keep the paused minutes in them. So the clock
/// banks every finished run and hands the view an *anchor* instead, the date
/// the timer would have started from had the recording never paused. While
/// paused there is no anchor, and the view draws `elapsed` as still digits.
///
/// Wall time, not audio time. The timer starts on the tap, before the
/// microphone is open (see `MeetingRecorder.start`), and that has always been
/// the deal: the clock says how long the person has been recording, the audio
/// file says how much sound it holds, and the two differ by a handshake.
public struct RecordingClock: Equatable, Sendable {
    public enum State: Equatable, Sendable {
        case running(since: Date)
        case paused
    }

    public private(set) var state: State
    /// Recorded time from runs that have ended, i.e. everything before the
    /// latest resume.
    public private(set) var banked: TimeInterval

    public init(startedAt: Date) {
        state = .running(since: startedAt)
        banked = 0
    }

    public var isPaused: Bool { state == .paused }

    /// A second pause is a no-op, so a double tap cannot bank a run twice.
    public mutating func pause(at now: Date) {
        guard case .running(let since) = state else { return }
        banked += Self.span(from: since, to: now)
        state = .paused
    }

    /// A second resume is a no-op, so it cannot restart the current run.
    public mutating func resume(at now: Date) {
        guard state == .paused else { return }
        state = .running(since: now)
    }

    /// Recorded time at `now`, paused stretches excluded.
    public func elapsed(at now: Date) -> TimeInterval {
        switch state {
        case .running(let since): return banked + Self.span(from: since, to: now)
        case .paused: return banked
        }
    }

    /// The date a `Text(_:style:.timer)` should count from so that it shows
    /// `elapsed`. Nil while paused: a paused timer is still digits, not a
    /// running one.
    public var timerAnchor: Date? {
        guard case .running(let since) = state else { return nil }
        return since.addingTimeInterval(-banked)
    }

    /// `elapsed` the way `Text(_:style:.timer)` writes it (`0:07`, `12:34`,
    /// `1:02:03`), so the digits do not change shape when the timer stops.
    public static func timerText(_ elapsed: TimeInterval) -> String {
        let total = Int(max(0, elapsed))
        let hours = total / 3600
        let minutes = total / 60 % 60
        let seconds = total % 60
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, seconds)
        }
        return String(format: "%d:%02d", minutes, seconds)
    }

    /// `Date` is wall time and can step backwards when the system syncs; a run
    /// never counts as negative.
    private static func span(from start: Date, to end: Date) -> TimeInterval {
        max(0, end.timeIntervalSince(start))
    }
}
