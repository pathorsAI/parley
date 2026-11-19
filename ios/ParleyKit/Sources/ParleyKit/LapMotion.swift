import Foundation

/// Every number the onboarding lap moves by, in one place.
///
/// The lap's motion is a handful of small moments — the sign-in page assembling
/// itself, the suggestion card arriving and flying into its folder, a replay
/// ripple on the waveform, the finish — and each of them used to be the kind of
/// constant that gets re-typed slightly differently in every view. Here they
/// are one namespace: one spring (response 0.5, damping 0.8, applied in the app
/// as `LapMotion.spring`), durations between 0.4 and 0.7 s, and the welcome
/// demo's beat schedule, which is pure arithmetic and therefore tested rather
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

    // MARK: the welcome demo

    /// The welcome screen's demo, beat for beat the desktop's
    /// (`src/components/onboarding/IntroStage.tsx`): the four steps land as a
    /// row and hold, then a recording starts, two transcript lines type with
    /// their speakers, a recording flies into a customer folder, and the
    /// meeting ends on its report while the MCP plug lights. It rests on its
    /// final frame (`ready`).
    public enum WelcomeBeat: Int, CaseIterable, Sendable, Comparable {
        case overview, record, transcript, folder, mcp, ready

        public static func < (a: WelcomeBeat, b: WelcomeBeat) -> Bool { a.rawValue < b.rawValue }

        /// The four that are steps in the row; `overview` and `ready` are not.
        public static let steps: [WelcomeBeat] = [.record, .transcript, .folder, .mcp]
    }

    /// When everything in the welcome demo happens, in seconds from the start
    /// of a run. The desktop's constants, converted from milliseconds.
    public struct WelcomeSchedule: Equatable, Sendable {
        /// `INTRO_BEATS`: each beat's start.
        public static let beatStarts: [WelcomeBeat: TimeInterval] = [
            .overview: 0, .record: 1.8, .transcript: 3.4, .folder: 6.4, .mcp: 8.3, .ready: 11.0,
        ]
        /// The transcript's typing budget and the pause between its lines.
        public static let transcriptBudget: TimeInterval = 2.4
        public static let lineGap: TimeInterval = 0.24
        /// Inside the folder beat: the recording card shows, then flies.
        public static let cardIn: TimeInterval = 0.225
        public static let cardFlyAt: TimeInterval = 0.75
        public static let cardFly: TimeInterval = 0.9
        /// Inside the MCP beat: the plug lights, the report's lines arrive.
        public static let plugLight: TimeInterval = 0.3
        public static let reportLineAt: TimeInterval = 0.35
        public static let reportLineStagger: TimeInterval = 0.3
        /// The overview row: each step lands this long after the one before.
        public static let overviewStagger: TimeInterval = 0.135

        /// How fast the transcript types — never slower than `perCharacter`,
        /// faster when the lines would overrun the budget.
        public let secondsPerCharacter: TimeInterval
        /// Each transcript line's first character, from the start of the run.
        public let lineStarts: [TimeInterval]
        public let lineLengths: [Int]

        public init(lineLengths: [Int]) {
            let chars = lineLengths.reduce(0, +)
            let gaps = Self.lineGap * Double(max(0, lineLengths.count - 1))
            let rate =
                chars > 0
                ? min(LapMotion.perCharacter, max(0.001, (Self.transcriptBudget - gaps) / Double(chars)))
                : LapMotion.perCharacter
            var starts: [TimeInterval] = []
            var cursor = Self.start(of: .transcript)
            for length in lineLengths {
                starts.append(cursor)
                cursor += Double(length) * rate + Self.lineGap
            }
            secondsPerCharacter = rate
            lineStarts = starts
            self.lineLengths = lineLengths
        }

        public static func start(of beat: WelcomeBeat) -> TimeInterval { beatStarts[beat] ?? 0 }

        /// The rest frame.
        public var end: TimeInterval { Self.start(of: .ready) }

        /// The beat at `t`: the latest one that has started.
        public func beat(at t: TimeInterval) -> WelcomeBeat {
            WelcomeBeat.allCases.last { t >= Self.start(of: $0) } ?? .overview
        }

        /// How far step `beat`'s bar has filled at `t`, 0…1: empty before it,
        /// filling linearly over its own length, full after.
        public func fill(_ beat: WelcomeBeat, at t: TimeInterval) -> Double {
            guard let next = WelcomeBeat(rawValue: beat.rawValue + 1) else { return t >= end ? 1 : 0 }
            let from = Self.start(of: beat)
            let span = Self.start(of: next) - from
            return min(1, max(0, (t - from) / span))
        }

        /// How many characters of transcript line `index` show at `t`.
        public func typedCount(line index: Int, at t: TimeInterval) -> Int {
            guard lineStarts.indices.contains(index) else { return 0 }
            let elapsed = t - lineStarts[index]
            guard elapsed > 0 else { return 0 }
            return min(lineLengths[index], Int((elapsed / secondsPerCharacter).rounded(.down)))
        }

        /// The speaker's name shows once the whole line is in.
        public func lineDone(_ index: Int, at t: TimeInterval) -> Bool {
            lineLengths.indices.contains(index) && typedCount(line: index, at: t) >= lineLengths[index]
        }

        /// The recording card: on screen, flying, or filed into the folder.
        public enum Card: Equatable, Sendable { case hidden, shown, flying, filed }

        public func card(at t: TimeInterval) -> Card {
            let folder = Self.start(of: .folder)
            if t < folder + Self.cardIn { return .hidden }
            if t < folder + Self.cardFlyAt { return .shown }
            if t < folder + Self.cardFlyAt + Self.cardFly { return .flying }
            return .filed
        }

        /// The folder row flashes once as the card lands.
        public func folderFlashing(at t: TimeInterval) -> Bool {
            let landed = Self.start(of: .folder) + Self.cardFlyAt + Self.cardFly
            return t >= landed && t < landed + 0.5
        }

        public func plugLit(at t: TimeInterval) -> Bool {
            t >= Self.start(of: .mcp) + Self.plugLight
        }

        /// How many of the report's `total` lines are in at `t`.
        public func reportLines(_ total: Int, at t: TimeInterval) -> Int {
            let elapsed = t - Self.start(of: .mcp) - Self.reportLineAt
            guard elapsed >= 0 else { return 0 }
            return min(total, Int((elapsed / Self.reportLineStagger).rounded(.down)) + 1)
        }

        /// When report line `index` arrives, for its own rise.
        public func reportLineStart(_ index: Int) -> TimeInterval {
            Self.start(of: .mcp) + Self.reportLineAt + Double(index) * Self.reportLineStagger
        }

        /// When step `index` of the overview row lands.
        public static func overviewLanding(_ index: Int) -> TimeInterval {
            Double(index) * overviewStagger
        }
    }

    /// The first `count` characters of `text` — what a typed line shows.
    public static func typed(_ text: String, count: Int) -> String {
        String(text.prefix(max(0, count)))
    }
}
