import Foundation

/// The clock behind the keyboard's "text wave" — the band of light that reads
/// through the last few lines of a dictation while Parley polishes it.
///
/// It lives here, and not beside the views that draw it, because it is the one
/// part of that animation that has to be *right* rather than pretty: two views
/// draw from it — the transcript's glyphs and the three dots on the record
/// button — and they are only one gesture if they agree on where the crest is
/// at every instant. A shared value with a start date and pure functions of
/// time is how they agree: each view reads the date its own `TimelineView`
/// hands it and computes the same phase, so there is nothing to drift and
/// nothing to keep in step. It is also the part a keyboard extension cannot
/// unit-test, and a struct of arithmetic can.
///
/// **What the numbers are for.** One pass reads the lines at a constant pace —
/// the crest moves the way an eye moves along a sentence — clamped so a short
/// phrase is not a flicker and a full slot is not a crawl. Then a short rest,
/// so the next pass reads as the AI going over it again rather than as a
/// marquee looping. The band is a raised cosine a few characters wide: no edge
/// anywhere on it, so the light arrives on a character and leaves it rather
/// than switching it on.
public struct PolishWave: Equatable, Sendable {
    /// When the wave became visible — the shared origin both views measure
    /// from. Not when finishing began: the first 250 ms of a finish show
    /// nothing at all (`revealDelay`), and the first pass must start at the
    /// first character when it *appears*, not a quarter of a second in.
    public var startedAt: Date
    /// How long one pass takes, fixed when the wave is revealed. Fixed rather
    /// than recomputed per frame because the text can still grow while the
    /// app drains the relay's last words, and a pass whose length changed
    /// mid-crest would make the crest jump.
    public var pass: TimeInterval
    /// When the session settled (`done`). From here the wave eases out over
    /// `fadeOut` rather than being cut mid-crest.
    public var endedAt: Date?

    public init(startedAt: Date, pass: TimeInterval, endedAt: Date? = nil) {
        self.startedAt = startedAt
        self.pass = pass
        self.endedAt = endedAt
    }

    /// A finish shorter than this shows no transition at all: the button goes
    /// from red to the idle blue and the words land. Anything that would
    /// animate for less than a quarter of a second reads as a glitch, not as
    /// work being done.
    public static let revealDelay: Duration = .milliseconds(250)
    /// The breath between passes.
    public static let rest: TimeInterval = 0.25
    /// Full width of the band, in graphemes. Wide enough that a word or two
    /// is always noticeably lit — at 7 the crest was a few letters of Latin
    /// and easy to miss — narrow enough to read as a crest travelling rather
    /// than as the whole line brightening.
    public static let bandWidth: Double = 10
    /// Reading pace, in graphemes a second. At this speed a full slot — three
    /// lines of CJK, `visibleGraphemes` — takes exactly the upper clamp.
    public static let readingSpeed: Double = 35
    public static let passRange: ClosedRange<TimeInterval> = 1.1...1.8
    /// Roughly three lines of the 15pt transcript on the narrowest phone, in
    /// CJK — the widest script the slot is likely to hold. Used where the
    /// actual layout is not available: sizing the pass, and the iOS 17 path,
    /// which cannot see line boundaries at all.
    public static let visibleGraphemes = 63
    /// How many of the last laid-out lines the wave reads through. Lines
    /// above them — scrolled out of a short slot — stay at the resting
    /// emphasis.
    public static let wavingLines = 3
    /// The default resting emphasis of every glyph while the wave runs, as an
    /// opacity of the full ink: dimmer than a soft ink, so the crest has
    /// somewhere to rise from. Each surface can set its own
    /// (`PolishWaveStyle.restingOpacity`); the keyboard does, per appearance.
    public static let restingOpacity = 0.4
    /// The default for how far the crest leans towards the tint colour
    /// (`PolishWaveStyle.tintAmount`). Under a quarter, so on a dark
    /// background it reads as light passing through rather than blue text.
    public static let tint = 0.22
    /// How long the wave takes to arrive over the settled colours, and to
    /// leave again once the words land.
    public static let fadeIn: TimeInterval = 0.2
    public static let fadeOut: TimeInterval = 0.2

    /// The transcript as shown: the settled words followed directly by the
    /// ones still being revised, with **nothing** between them.
    ///
    /// The app builds `committed` the same way — its runs are joined with no
    /// separator, because the recogniser's tokens carry their own spacing — so
    /// anything added here would be text the preview shows and the field never
    /// gets. A space used to be put in, and split 電話號碼 into 電話號 碼 and
    /// "Talk" into "Ta lk" wherever a run boundary fell mid-word.
    public static func transcript(settled: String, unsettled: String) -> String {
        settled + unsettled
    }

    /// One pass over `graphemes` characters at `readingSpeed`, clamped to
    /// `passRange`.
    public static func passDuration(graphemes: Int) -> TimeInterval {
        let reading = Double(max(graphemes, 0)) / readingSpeed
        return min(max(reading, passRange.lowerBound), passRange.upperBound)
    }

    /// How far through the current pass the crest is at `date`, 0…1, or `nil`
    /// during the rest between passes (and before the wave has started).
    public func progress(at date: Date) -> Double? {
        let elapsed = date.timeIntervalSince(startedAt)
        guard elapsed >= 0, pass > 0 else { return nil }
        let cycle = pass + Self.rest
        let into = elapsed.truncatingRemainder(dividingBy: cycle)
        return into < pass ? into / pass : nil
    }

    /// How present the wave is at `date`, 0…1: eased in over `fadeIn` from
    /// `startedAt`, and out over `fadeOut` from `endedAt`. Every colour the
    /// views draw is a blend towards the wave's by this much, which is what
    /// makes both ends of it soft.
    public func strength(at date: Date) -> Double {
        let arriving = Self.smoothstep(date.timeIntervalSince(startedAt) / Self.fadeIn)
        guard let endedAt else { return arriving }
        let leaving = 1 - Self.smoothstep(date.timeIntervalSince(endedAt) / Self.fadeOut)
        return min(arriving, leaving)
    }

    /// The wave has fully left and the view can stop drawing it.
    public func isOver(at date: Date) -> Bool {
        guard let endedAt else { return false }
        return date.timeIntervalSince(endedAt) >= Self.fadeOut
    }

    /// Where the crest's centre is, in graphemes, for a pass over `count` of
    /// them at `progress`.
    ///
    /// It travels from half a band *before* the first grapheme to half a band
    /// *after* the last, so the band enters the text at the first character and
    /// leaves it past the last one: the first character starts to brighten the
    /// moment a pass begins, and nothing is lit when the rest arrives.
    public static func crest(progress: Double, count: Int) -> Double {
        let half = bandWidth / 2
        return -half + progress * (Double(max(count, 1) - 1) + bandWidth)
    }

    /// How lit grapheme `index` (0-based, reading order) is, 0…1, in a pass
    /// over `count` graphemes at `progress`. A raised cosine centred on the
    /// crest; zero outside the band.
    public static func intensity(index: Int, count: Int, progress: Double?) -> Double {
        guard let progress, count > 0, index >= 0, index < count else { return 0 }
        let distance = Double(index) - crest(progress: progress, count: count)
        let half = bandWidth / 2
        guard abs(distance) < half else { return 0 }
        return 0.5 * (1 + cos(.pi * distance / half))
    }

    /// How far dot `dot` (0, 1 or 2) is lit, 0…1, at `progress` through a pass.
    ///
    /// Each dot owns a third of the pass and peaks as the crest crosses the
    /// middle of its third; the bumps are as wide as a third on either side,
    /// so one dot hands to the next rather than all three blinking in turn.
    /// During the rest, all three are down.
    public static func dotLevel(dot: Int, progress: Double?) -> Double {
        guard let progress, (0..<3).contains(dot) else { return 0 }
        let third = 1.0 / 3
        let centre = (Double(dot) + 0.5) * third
        let distance = progress - centre
        guard abs(distance) < third else { return 0 }
        return 0.5 * (1 + cos(.pi * distance / third))
    }

    private static func smoothstep(_ x: Double) -> Double {
        let t = min(max(x, 0), 1)
        return t * t * (3 - 2 * t)
    }
}
