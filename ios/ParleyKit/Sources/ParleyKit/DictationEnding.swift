import Foundation

/// Why a dictation that was *delivered* ended without the user pressing ⏹ —
/// the one thing about such an ending the user has to be told after the words
/// have landed.
///
/// Both endings used to be silent, and both lost words that way. The session
/// cap stopped the microphone at two minutes with nothing on screen to say so,
/// so everything said after it went nowhere and the user only found out by
/// reading back what had been typed. A socket that died for good ended the
/// session as an `error`, which the keyboard never inserts from, so a long
/// dictation whose connection dropped at minute three typed nothing at all.
/// Now the first is announced before it happens (see `DictationCountdown`) and
/// both are delivered as an ordinary `done` — the words so far land in the
/// field — with this riding along so the pane can say what happened.
///
/// It travels in two places, and in both it is **only a note, never a state**:
/// on the downlink (`DictationChannel.Downlink.notice`), where the keyboard
/// shows it after inserting, in the slot where an error would go but not in the
/// error red; and on the history entry (`DictationHistoryEntry.ending`), so the
/// words can still be traced to an ending that was not the user's.
///
/// **The raw values are a wire format** — the App Group file and the on-device
/// history both store them. Never rename one. Both readers decode an unknown
/// value as "no note" rather than failing the whole file, for the reason
/// `PolishOutcome` gives: a later build's label read back after a downgrade is
/// not worth a mailbox that reads as empty.
public enum DictationEnding: String, Codable, Sendable, CaseIterable {
    /// The session ran into `MicActivityPolicy.dictationLimit` and the app
    /// stopped it — delivered exactly as a ⏹ would have been, polish included.
    case limitReached
    /// The relay socket died and the reconnect ladder ran out. What had been
    /// transcribed was delivered as it stood, unpolished (the polish needs the
    /// network that just went away).
    case connectionLost
}

/// The keyboard's warning that the session cap is about to stop the
/// microphone.
///
/// The cap exists so a session somebody forgot about cannot burn the hosted
/// quota, and for that it must stay. What was wrong with it was that it was
/// silent: someone dictating a long message had no way of knowing a clock was
/// running until the words after it were gone. The app now publishes when its
/// backstop will fire (`DictationChannel.Downlink.deadline`) and the keyboard
/// counts the last `warningLead` seconds down in the voice pane.
///
/// Pure, so the rule is tested here rather than trusted to a timer in an
/// extension nobody can unit-test.
public enum DictationCountdown {
    /// How long before the cap the countdown shows. Long enough to finish a
    /// sentence or press ⏹ and start again; short enough that it never shows
    /// in an ordinary dictation, which is well under a minute.
    public static let warningLead: TimeInterval = 30

    /// Whole seconds left to show, or `nil` when there is nothing to show:
    /// no deadline, more than `warningLead` to go, or already past it (the
    /// app's stop is a moment away, and "0 s" is not worth drawing).
    ///
    /// Rounded **up**, so the number counts 30 … 1 and a reading taken 0.2 s
    /// before the cap says 1 rather than 0.
    public static func secondsLeft(until deadline: Date?, at now: Date) -> Int? {
        guard let deadline else { return nil }
        let left = deadline.timeIntervalSince(now)
        guard left.isFinite, left > 0, left <= warningLead else { return nil }
        return Int(left.rounded(.up))
    }

    /// When a keyboard that has just read `deadline` should next look again:
    /// the moment the countdown starts, or one second on while it runs. `nil`
    /// once there is nothing left to count. Always in the future, and never
    /// more than `warningLead` away past the start, so a clock that jumped
    /// cannot put the next look out of reach.
    public static func nextTick(until deadline: Date?, at now: Date) -> Date? {
        guard let deadline else { return nil }
        let left = deadline.timeIntervalSince(now)
        guard left.isFinite, left > 0 else { return nil }
        if left > warningLead {
            return now.addingTimeInterval(left - warningLead)
        }
        // The next whole-second boundary before the deadline, so the number
        // changes on the second rather than drifting against it.
        let fraction = left - left.rounded(.down)
        return now.addingTimeInterval(fraction > 0.001 ? fraction : 1)
    }

    /// The cap in whole minutes, for the copy that names it ("…(10 min)").
    public static func limitMinutes(_ limit: TimeInterval = MicActivityPolicy.dictationLimit)
        -> Int
    {
        max(1, Int((limit / 60).rounded()))
    }
}
