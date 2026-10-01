import Foundation

/// The arithmetic behind the record screen's resizable controls panel: how
/// tall it may be, what still fits at a given height, how a drag and a release
/// turn into a resting height, and how that height is remembered.
///
/// While a meeting is running the controls used to take a fixed ~330pt — the
/// status sentence, a display-size timer, the waveform, the health line, the
/// stop disc and Discard — which left the transcript, the thing a person
/// actually glances at mid-meeting, the top half of the phone. The panel is
/// now a free divider: drag its top edge down and it stays wherever it is let
/// go, shedding secondary pieces as it shrinks until it is a single row.
///
/// It lives here rather than in the view because every rule in it is a
/// judgement about a number — which element goes first, how close to an end
/// counts as "meant the end", what a release inside the crossfade means — and
/// a wrong number is invisible in a screenshot at one height and obvious in a
/// unit test across all of them.
///
/// Everything is in points, as `Double`, so ParleyKit stays free of UIKit.
public struct LiveControlsLayout: Equatable, Sendable {
    /// The natural heights of the panel's pieces, measured by the view at its
    /// current Dynamic Type size. The panel's full height is *derived* from
    /// these rather than measured as a whole: measuring the whole panel would
    /// mean laying it out at full size, which is exactly what it is not doing
    /// once someone has shrunk it.
    public struct Metrics: Equatable, Sendable {
        /// "Recording · live transcript" with its red dot.
        public var statusRow: Double
        /// The timer's line at its full display size.
        public var timer: Double
        public var waveform: Double
        /// The health/status sentence under the waveform; zero when there is
        /// no sentence to show.
        public var statusLine: Double
        /// The stop disc's diameter at full size.
        public var stop: Double
        public var discard: Double
        /// Between stacked pieces, as the column's `VStack(spacing:)`.
        public var spacing: Double
        /// Above and below the column, each.
        public var padding: Double

        public init(
            statusRow: Double, timer: Double, waveform: Double, statusLine: Double,
            stop: Double = 64, discard: Double = 44, spacing: Double = 14, padding: Double = 20
        ) {
            self.statusRow = statusRow
            self.timer = timer
            self.waveform = waveform
            self.statusLine = statusLine
            self.stop = stop
            self.discard = discard
            self.spacing = spacing
            self.padding = padding
        }
    }

    /// The secondary pieces, in the order they give up their room. Discard
    /// goes first, and not only because it is the least-used: throwing a
    /// meeting away is the one irreversible thing on the panel, so it is shown
    /// only when the panel is fully open and nobody reaches it by accident
    /// through a half-collapsed layout. The waveform goes last because "did it
    /// hear that" is the question the panel exists to answer after the timer.
    public enum Element: Int, CaseIterable, Sendable {
        case discard
        case statusRow
        case statusLine
        case waveform
    }

    public var metrics: Metrics
    /// The single-row panel: a 44pt stop target plus room to breathe above
    /// and below it (and for the grabber drawn over the top edge).
    public var compact: Double

    public init(metrics: Metrics, compact: Double = 88) {
        self.metrics = metrics
        self.compact = compact
    }

    // MARK: - Range

    /// Everything shown, nothing scaled.
    public var full: Double {
        max(compact, needed(for: Set(Element.allCases), progress: 1))
    }

    /// 0 at compact, 1 at full; what every continuous size is interpolated on.
    public func progress(at height: Double) -> Double {
        let span = full - compact
        guard span > 0 else { return 1 }
        return min(1, max(0, (height - compact) / span))
    }

    /// What is persisted: a fraction rather than points, so a remembered
    /// choice survives a Dynamic Type change or a status line that wraps to a
    /// second row, both of which move `full`.
    public func fraction(forHeight height: Double) -> Double { progress(at: height) }

    public func height(forFraction fraction: Double) -> Double {
        compact + min(1, max(0, fraction)) * (full - compact)
    }

    // MARK: - Continuous sizes

    /// The timer's scale against its full display size. It stops at about
    /// six tenths, which is where the full column hands over to the compact
    /// row anyway; below that the row's own smaller timer takes over.
    public func timerScale(at height: Double) -> Double {
        0.62 + 0.38 * progress(at: height)
    }

    /// 64 → 52pt: smaller as the panel shrinks, never under the 44pt target.
    public func stopDiameter(at height: Double) -> Double {
        max(44, metrics.stop * (0.8125 + 0.1875 * progress(at: height)))
    }

    // MARK: - What fits

    /// The pieces that fit at `height`, dropped in `Element` order until the
    /// rest does. Fit-driven rather than fixed thresholds: the pieces' real
    /// heights move with Dynamic Type and with whether there is a status line
    /// at all, and a fixed threshold that was right for one of those would
    /// clip a piece in half for another.
    public func visible(at height: Double) -> Set<Element> {
        let t = progress(at: height)
        var shown = Set(Element.allCases)
        if metrics.statusLine <= 0 { shown.remove(.statusLine) }
        // A hair of tolerance so the fully open panel — whose height *is* the
        // sum — does not lose Discard to floating-point rounding.
        for element in Element.allCases where needed(for: shown, progress: t) > height + 0.5 {
            shown.remove(element)
        }
        return shown
    }

    private func needed(for shown: Set<Element>, progress: Double) -> Double {
        let m = metrics
        var pieces = [m.timer * (0.62 + 0.38 * progress), max(44, m.stop * (0.8125 + 0.1875 * progress))]
        if shown.contains(.statusRow) { pieces.append(m.statusRow) }
        if shown.contains(.waveform) { pieces.append(m.waveform) }
        if shown.contains(.statusLine), m.statusLine > 0 { pieces.append(m.statusLine) }
        if shown.contains(.discard) { pieces.append(m.discard) }
        return 2 * m.padding + pieces.reduce(0, +) + m.spacing * Double(pieces.count - 1)
    }

    // MARK: - Crossfade

    /// The band (in progress) where the full column and the compact row
    /// crossfade — about 25pt of travel at the default text size. Outside it
    /// exactly one of them is on screen.
    public static let crossfade: ClosedRange<Double> = 0.2939...0.3893

    /// The column fades out across the band…
    public func columnOpacity(at height: Double) -> Double {
        ramp(progress(at: height), from: Self.crossfade.lowerBound, to: Self.crossfade.upperBound)
    }

    /// …as the row fades in: complementary, so there is never a height at
    /// which the panel is drawn at less than full strength.
    public func rowOpacity(at height: Double) -> Double {
        1 - columnOpacity(at: height)
    }

    private func ramp(_ value: Double, from low: Double, to high: Double) -> Double {
        min(1, max(0, (value - low) / (high - low)))
    }

    // MARK: - Dragging

    /// How far past either end a drag may pull before it stops giving.
    public static let overshoot: Double = 40

    /// The height while a finger is down. `translation` is the drag's
    /// vertical travel, down positive — pulling the top edge down makes the
    /// panel shorter. Past either end the panel follows with diminishing
    /// give instead of stopping dead, which is how the edge says "that's the
    /// end" without feeling stuck.
    public func dragged(from start: Double, translation: Double) -> Double {
        let raw = start - translation
        if raw > full { return full + rubberBand(raw - full) }
        if raw < compact { return compact - rubberBand(compact - raw) }
        return raw
    }

    private func rubberBand(_ excess: Double) -> Double {
        Self.overshoot * (1 - exp(-excess / (Self.overshoot * 2)))
    }

    /// Within this of compact, a release means compact.
    public static let compactSnap: Double = 40
    /// Within this of full, a release means full — which is also what keeps
    /// Discard from being left one sliver short of visible.
    public static let fullSnap: Double = 24

    /// Where a release comes to rest. It stays where it was let go — the
    /// point of a free divider — except near the ends, where a release that
    /// almost reached one plainly meant it, and inside the crossfade band,
    /// where resting would leave two layouts half-drawn on top of each other;
    /// there it settles on whichever edge of the band is nearer.
    public func settled(_ height: Double) -> Double {
        let clamped = min(full, max(compact, height))
        if clamped - compact < Self.compactSnap { return compact }
        if full - clamped < Self.fullSnap { return full }
        if Self.crossfade.contains(progress(at: clamped)) {
            let low = self.height(forFraction: Self.crossfade.lowerBound)
            let high = self.height(forFraction: Self.crossfade.upperBound)
            return clamped - low < high - clamped ? low : high
        }
        return clamped
    }

    /// The grabber's tap: fully open closes to the row, anything else opens
    /// fully — a tap is the "give me the whole panel back" gesture.
    public func toggled(fraction: Double) -> Double {
        fraction >= 1 ? 0 : 1
    }

    /// VoiceOver's adjustable steps: row, half, whole. Three stops rather
    /// than a percentage ladder, because the useful states are those three
    /// and a swipe that lands on a height nobody would choose is noise.
    public func stepped(fraction: Double, taller: Bool) -> Double {
        let stops: [Double] = [0, 0.5, 1]
        if taller {
            return stops.first { $0 > fraction + 0.01 } ?? 1
        }
        return stops.last { $0 < fraction - 0.01 } ?? 0
    }
}
