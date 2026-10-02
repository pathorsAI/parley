import Foundation

/// The space bar as a trackpad: what a press on it turns into, and how far a
/// drag moves the caret.
///
/// On the system keyboard a space bar held still for a moment stops being a
/// key. The other caps go blank, and sliding the same finger walks the caret
/// through the text a character at a time — the only way to put the caret
/// between two letters without a magnifier and a steady thumb. Parley's space
/// bar used to be a plain button, so correcting a word in the middle of a
/// sentence meant leaving the keyboard for the field.
///
/// A press goes through four phases:
///
/// | Phase | How it gets there | On release |
/// |---|---|---|
/// | `holding` | the finger lands | types space |
/// | `typing` | it moves past `slop` first, or the hold is refused | types space |
/// | `steering` | it stays within `slop` for `holdDelay`, and the hold is allowed | nothing |
/// | `idle` | released or cancelled | — |
///
/// So a quick tap is exactly the key it always was, and a hold that ends
/// without moving types nothing: once the keys have gone blank the user has
/// been told this press is not a space, and typing one anyway would be the
/// keyboard changing its mind behind their back. A press that wanders before
/// the hold is a sloppy tap, not a trackpad, and keeps typing on release —
/// and if it wanders far enough sideways the pane track takes it as a swipe,
/// as it always did.
///
/// The hold is *refused* rather than ignored when the keyboard says the space
/// bar has another job to do — a 注音 reading waiting in the field, where
/// space is the first tone and then the confirm key (`ZhuyinComposer.space()`).
/// A refused hold becomes an ordinary press, so letting go still does what
/// space does there.
///
/// The clock lives with the caller. Nothing here schedules anything: the
/// keyboard runs a timer for `holdDelay` and reports it with `holdElapsed`,
/// and every movement arrives with its own timestamp, so the whole machine —
/// the acceleration included — is a function of its inputs and is tested
/// without one.
public struct SpaceCursor: Sendable {
    /// How long the finger has to rest before the space bar becomes a
    /// trackpad. The system keyboard's is about a third of a second; shorter
    /// starts eating the space at the end of a slow, deliberate tap.
    public static let holdDelay: TimeInterval = 0.35
    /// How far the finger may drift during the hold and still be holding
    /// still. A thumb resting on glass is never perfectly still, and past
    /// about this far it is plainly going somewhere. Well under the 24pt the
    /// pane track needs before it takes a drag, so a hold can never begin
    /// after the track has already started a swipe.
    public static let slop: Double = 10
    /// How far a slow drag travels per character. About a narrow letter's
    /// width at the field's usual size, so the caret keeps pace with the
    /// finger rather than running ahead of it.
    public static let pointsPerStep: Double = 9
    /// Below this speed, in points a second, a drag moves the caret at the
    /// slow rate exactly — a careful slide to land between two letters is
    /// never accelerated.
    public static let accelerationOnset: Double = 300
    /// At and above this speed the gain is at its ceiling.
    public static let accelerationFull: Double = 1_200
    /// The ceiling: a fast flick covers two and a half times the characters
    /// the same distance would slowly. Mild on purpose — enough to cross a
    /// sentence in one sweep of the bar, not so much that the caret flies off
    /// the end of the line the moment the finger hurries.
    public static let maxGain: Double = 2.5
    /// How much of the speed estimate each new movement replaces. Touch
    /// samples arrive 60–120 times a second and a single interval between two
    /// of them is noisy; a little smoothing keeps one jittery sample from
    /// lurching the caret.
    static let speedSmoothing: Double = 0.4

    public enum Phase: Equatable, Sendable {
        /// No finger on the space bar.
        case idle
        /// Down, within `slop`, waiting for `holdDelay`.
        case holding
        /// An ordinary press: it moved first, or the hold was refused.
        case typing
        /// The space bar is a trackpad.
        case steering
    }

    /// What letting go does.
    public enum Release: Equatable, Sendable {
        /// The key's ordinary action: a space, 注音's first tone, or confirm.
        case space
        /// Nothing at all — the press was steering the caret, or it ended
        /// outside the key the way a button's cancelled touch does.
        case nothing
    }

    public private(set) var phase: Phase = .idle

    /// Horizontal travel from touch-down at the last movement.
    private var lastX: Double = 0
    private var lastTime: TimeInterval = 0
    /// Smoothed horizontal speed, points per second.
    private var speed: Double = 0
    /// Scaled travel not yet spent on a whole step. Signed, and reset when the
    /// finger turns round, so a reversal always needs one full step of travel
    /// before the caret follows it — never a few points' wobble.
    private var pending: Double = 0

    public init() {}

    /// The finger landed on the space bar, `time` seconds into some clock.
    public mutating func touchDown(at time: TimeInterval) {
        phase = .holding
        lastX = 0
        lastTime = time
        speed = 0
        pending = 0
    }

    /// `holdDelay` has passed since `touchDown`. `allowed` is whether the
    /// space bar is free to become a trackpad right now (see the type's
    /// comment). True when it just did — the moment to fade the keys and play
    /// the entry beat.
    ///
    /// A press that has already moved, or already ended, is not affected: a
    /// timer that fires late is a timer, not a hold.
    public mutating func holdElapsed(allowed: Bool) -> Bool {
        guard phase == .holding else { return false }
        phase = allowed ? .steering : .typing
        return allowed
    }

    /// The finger is `dx`, `dy` points from where it landed, at `time`.
    /// Returns how many characters the caret should move: negative toward the
    /// start of the text, positive toward the end, zero most of the time.
    ///
    /// Only the horizontal travel counts. The bar moves the caret along the
    /// text, not between lines, so a finger drifting up or down while it
    /// slides changes nothing.
    public mutating func moved(dx: Double, dy: Double, at time: TimeInterval) -> Int {
        switch phase {
        case .idle, .typing:
            return 0
        case .holding:
            if (dx * dx + dy * dy).squareRoot() > Self.slop { phase = .typing }
            lastX = dx
            lastTime = time
            return 0
        case .steering:
            let delta = dx - lastX
            let interval = time - lastTime
            lastX = dx
            lastTime = time
            if interval > 0.001 {
                let instant = abs(delta) / interval
                speed += (instant - speed) * Self.speedSmoothing
            }
            guard delta != 0 else { return 0 }
            // Turning round starts the count afresh in the new direction.
            if pending != 0, (pending > 0) != (delta > 0) { pending = 0 }
            pending += delta * Self.gain(atSpeed: speed)
            let steps = Int((pending / Self.pointsPerStep).rounded(.towardZero))
            pending -= Double(steps) * Self.pointsPerStep
            return steps
        }
    }

    /// The finger lifted. `inside` is whether it lifted on the key — its cap
    /// and its share of the space around it — as a button decides whether a
    /// touch-up is a tap.
    public mutating func release(inside: Bool = true) -> Release {
        defer { phase = .idle }
        switch phase {
        case .holding, .typing: return inside ? .space : .nothing
        case .steering, .idle: return .nothing
        }
    }

    /// The touch was taken away — the pane track claimed it for a swipe, or
    /// the key left the screen. Nothing is typed. True when it had been
    /// steering, so the caller knows to put the keys back.
    @discardableResult
    public mutating func cancel() -> Bool {
        defer { phase = .idle }
        return phase == .steering
    }

    /// How many points of caret travel one point of finger travel is worth at
    /// `speed` points a second: 1 up to `accelerationOnset`, rising linearly
    /// to `maxGain` at `accelerationFull`.
    public static func gain(atSpeed speed: Double) -> Double {
        let span = accelerationFull - accelerationOnset
        let t = min(max((speed - accelerationOnset) / span, 0), 1)
        return 1 + (maxGain - 1) * t
    }
}

/// Turns "move the caret n characters" into the offset
/// `UITextDocumentProxy.adjustTextPosition(byCharacterOffset:)` wants.
///
/// That offset is counted in UTF-16 code units, not in characters as a reader
/// sees them: the host resolves it as a `UITextInput` position offset, which
/// is an `NSString` index. A step of 1 across 😀 lands between its two
/// surrogates, and across 👨‍👩‍👧 — one character, eight code units — inside the
/// family. So the walk is done here over a snapshot of the text either side of
/// the caret, one grapheme cluster per step, and each step is worth that
/// cluster's UTF-16 length.
///
/// A snapshot, taken once when the space bar becomes a trackpad, rather than
/// the proxy's context re-read after every move: the proxy updates its context
/// a round trip after an adjustment, so a read straight after one can describe
/// the caret where it was. Moving the caret does not change the text, so the
/// snapshot stays true for the whole drag.
///
/// The snapshot is only what the host chose to share, which is often a
/// sentence or a line rather than the document. Past either end of it each
/// step is one code unit, counted, and walking back repays that count before
/// it re-enters the known text — right for every character in the Basic
/// Multilingual Plane, which is all of 注音's output and nearly all of
/// English. At the true start or end of the document the host clamps those
/// steps and the count is a few units off for the rest of the drag; a new
/// press takes a new snapshot.
public struct CaretWalk: Sendable {
    /// The UTF-16 length of every grapheme cluster in the snapshot, before and
    /// after the caret, in order.
    private let units: [Int]
    /// The caret, as a count of clusters from the start of the snapshot.
    private var index: Int
    /// Code units walked past the snapshot's ends: negative before its start,
    /// positive after its end. Zero while the caret is inside it.
    private var overflow = 0

    public init(before: String?, after: String?) {
        let left = (before ?? "").map { $0.utf16.count }
        let right = (after ?? "").map { $0.utf16.count }
        units = left + right
        index = left.count
    }

    /// The offset that moves the caret `steps` characters: negative toward the
    /// start, positive toward the end.
    public mutating func offset(steps: Int) -> Int {
        var offset = 0
        if steps < 0 {
            for _ in 0..<(-steps) {
                if overflow > 0 {
                    overflow -= 1
                    offset -= 1
                } else if overflow == 0, index > 0 {
                    index -= 1
                    offset -= units[index]
                } else {
                    overflow -= 1
                    offset -= 1
                }
            }
        } else {
            for _ in 0..<steps {
                if overflow < 0 {
                    overflow += 1
                    offset += 1
                } else if overflow == 0, index < units.count {
                    offset += units[index]
                    index += 1
                } else {
                    overflow += 1
                    offset += 1
                }
            }
        }
        return offset
    }
}
