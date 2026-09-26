import Foundation

/// Every number the onboarding lap moves by, in one place.
///
/// The lap's motion is a handful of small moments — the sign-in page assembling
/// itself, the suggestion card arriving and flying into its folder, a replay
/// ripple on the waveform, the finish — and each of them used to be the kind of
/// constant that gets re-typed slightly differently in every view. Here they
/// are one namespace: one spring (response 0.5, damping 0.8, applied in the app
/// as `LapMotion.spring`), durations between 0.4 and 0.7 s, and the sign-in
/// page's beat schedule, which is pure arithmetic and therefore tested rather
/// than tuned by eye in the simulator.
///
/// Reduce Motion is honoured at every call site by skipping to the final state;
/// nothing here plays on its own.
public enum LapMotion {
    public static let springResponse: Double = 0.5
    public static let springDamping: Double = 0.8

    /// One character of a typed line.
    public static let perCharacter: TimeInterval = 0.022
    /// The ✓ lines of the finished lap, one after another.
    public static let cascadeStep: TimeInterval = 0.26
    /// The waveform playhead gliding to a tapped turn, and the ring under it.
    public static let playheadGlide: TimeInterval = 0.5
    public static let ripple: TimeInterval = 0.7
    /// The single burst at the end of the lap.
    public static let confettiPieces = 26
    public static let confettiDuration: TimeInterval = 1.5

    // MARK: the sign-in page

    /// The four beats of the sign-in page's little film, in order: a recording
    /// starts, it becomes text, it lands in a customer's folder, it goes to an
    /// AI. The same four beats as the lap itself.
    public enum IntroBeat: Int, CaseIterable, Sendable, Comparable {
        case recording, transcript, folder, share

        public static func < (a: IntroBeat, b: IntroBeat) -> Bool { a.rawValue < b.rawValue }
    }

    public struct IntroLine: Equatable, Sendable {
        /// When the first character appears.
        public let start: TimeInterval
        /// When the last one has.
        public let typed: TimeInterval
        /// When the speaker's name fades in — just after the line is typed.
        public let name: TimeInterval
        public let length: Int
    }

    /// When everything on the sign-in page happens, from the moment it appears.
    public struct IntroSchedule: Equatable, Sendable {
        public let recording: TimeInterval
        public let lines: [IntroLine]
        public let folder: TimeInterval
        /// The suggestion card flies into the folder row.
        public let cardFly: TimeInterval
        public let share: TimeInterval
        /// Rest: the final state, held.
        public let end: TimeInterval

        /// The beat the stage is on at `t` — which caption is showing — or nil
        /// before the first.
        public func beat(at t: TimeInterval) -> IntroBeat? {
            if t >= share { return .share }
            if t >= folder { return .folder }
            if let first = lines.first, t >= first.start { return .transcript }
            if t >= recording { return .recording }
            return nil
        }

        /// How many characters of line `index` are showing at `t`.
        public func typedCount(line index: Int, at t: TimeInterval) -> Int {
            guard lines.indices.contains(index) else { return 0 }
            let line = lines[index]
            guard t >= line.start else { return 0 }
            let count = Int(((t - line.start) / LapMotion.perCharacter).rounded(.down)) + 1
            return min(line.length, count)
        }
    }

    /// The schedule for transcript lines of these lengths (in characters).
    /// About seven seconds for three clipped lines.
    public static func introBeats(lineLengths: [Int]) -> IntroSchedule {
        let recording: TimeInterval = 0.3
        var cursor: TimeInterval = 1.4
        var lines: [IntroLine] = []
        for length in lineLengths {
            let typed = cursor + Double(max(0, length - 1)) * perCharacter
            lines.append(IntroLine(start: cursor, typed: typed, name: typed + 0.05, length: length))
            cursor = typed + 0.35
        }
        let folder = (lines.last?.typed ?? cursor) + 0.5
        let cardFly = folder + 0.6
        let share = cardFly + 1.0
        return IntroSchedule(
            recording: recording, lines: lines, folder: folder, cardFly: cardFly, share: share,
            end: share + 0.7)
    }

    /// A transcript line cut to what fits the stage: the first sentence if it
    /// is short enough, else `limit` characters and an ellipsis.
    public static func clip(_ line: String, limit: Int = 34) -> String {
        let text = line.trimmingCharacters(in: .whitespacesAndNewlines)
        let enders: Set<Character> = ["。", "？", "！", ".", "?", "!"]
        if let end = text.firstIndex(where: { enders.contains($0) }),
            text.distance(from: text.startIndex, to: end) < limit
        {
            return String(text[...end])
        }
        guard text.count > limit else { return text }
        return String(text.prefix(limit)).trimmingCharacters(in: .whitespaces) + "…"
    }

    /// The first `count` characters of `text` — what a typed line shows.
    public static func typed(_ text: String, count: Int) -> String {
        String(text.prefix(max(0, count)))
    }
}
