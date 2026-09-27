#if canImport(SwiftUI)
    import CoreText
    import SwiftUI

    // The "text wave" — a band of light reading through the last lines of a
    // transcript while Parley polishes it — and the three dots that rise in step
    // with it. Drawn by the voice keyboard while a dictation is finishing, and
    // reusable anywhere else the same moment needs showing (the app's What's New
    // sheet), which is why it lives here with its colours passed in rather than
    // beside the keyboard's palette.
    //
    // The arithmetic is `PolishWave`; everything here only draws it.
    //
    // **Cost.** Everything that moves per frame is the smallest view that can
    // carry it — one `Text` under one `TimelineView`, three circles under
    // another — and a timeline exists only while one of these views is on
    // screen. Whatever can be worked out once per text (the graphemes, where the
    // last three lines begin, the colours) is worked out in the view's body,
    // which runs when the text changes; the timeline's closure only builds the
    // frame.
    //
    // **Two ways to draw the text, and why the default is the plainer one.**
    // The design called for a `TextRenderer` on iOS 18 — per-glyph opacity at
    // draw time, the layout reused across frames, the line boundaries exact —
    // and that path is here (`Drawing.renderer`). Inside the keyboard extension
    // it cannot be used: on the iOS 26.5 simulator a view carrying *any*
    // `textRenderer` — including one whose `draw` only calls `ctx.draw(line)`,
    // and one with no timeline at all — drew nothing in the great majority of
    // runs, in light and dark, while the same `Text` without a renderer never
    // failed. So the default is `Drawing.segments` on every iOS version: the
    // text as one coloured segment per character over the lines the wave reads,
    // re-laid out at 30 Hz, with the start of the last three lines measured by
    // Core Text once per text change so "the last three lines" is still a
    // measurement rather than a guess. `.renderer` is kept for a host process
    // where it has been seen to work; it has been verified in `ImageRenderer`
    // on macOS only.

    /// The inks and type a polish wave is drawn with.
    public struct PolishWaveStyle: Equatable {
        /// The full ink: unsettled words, and the crest.
        public var ink: Color
        /// The settled words' ink before the wave arrives and after it leaves.
        public var softInk: Color
        /// The colour the crest leans towards, at `PolishWave.tint` at most —
        /// the brand blue that survives the background.
        public var tint: Color
        /// The system font size the text is set in. A size rather than a
        /// `Font` because the line measurement needs the same face in Core
        /// Text, and a `Font` cannot be turned back into one.
        public var fontSize: CGFloat

        public init(ink: Color, softInk: Color, tint: Color, fontSize: CGFloat = 15) {
            self.ink = ink
            self.softInk = softInk
            self.tint = tint
            self.fontSize = fontSize
        }

        /// Every word at the wave's resting emphasis — what Reduce Motion
        /// shows instead of the wave.
        public var restingInk: Color { ink.opacity(PolishWave.restingOpacity) }
    }

    /// The transcript with the polish wave reading through its last three
    /// lines.
    ///
    /// `settled` and `unsettled` are the two halves the keyboard shows: the
    /// settled words start from (and return to) `style.softInk`, the unsettled
    /// ones from the full ink. Both are joined with a space when both have
    /// words. The view is as wide as it is offered and wraps; put it in
    /// whatever frame or scroll view the host needs.
    ///
    /// `Equatable`, so a host that redraws for unrelated reasons can wrap it in
    /// `.equatable()` and leave it alone.
    public struct PolishWaveText: View, Equatable {
        public enum Drawing: Equatable, Sendable {
            /// One coloured segment per character over the waving lines,
            /// refreshed at 30 Hz. Works in every process, keyboard extensions
            /// included; the default.
            case segments
            /// A `TextRenderer` (iOS 18 / macOS 15) setting each glyph's
            /// opacity at draw time, at up to 60 Hz. Does not draw inside a
            /// keyboard extension — see the note at the top of this file.
            /// Falls back to `segments` where the API is unavailable.
            case renderer
        }

        var settled: String
        var unsettled: String
        var wave: PolishWave
        var style: PolishWaveStyle
        var drawing: Drawing

        public init(
            settled: String, unsettled: String = "", wave: PolishWave, style: PolishWaveStyle,
            drawing: Drawing = .segments
        ) {
            self.settled = settled
            self.unsettled = unsettled
            self.wave = wave
            self.style = style
            self.drawing = drawing
        }

        /// What the colours resolve in — the host's colour scheme included,
        /// so semantic colours work as well as the keyboard's fixed ones.
        @Environment(\.self) private var environment

        public static func == (a: Self, b: Self) -> Bool {
            a.settled == b.settled && a.unsettled == b.unsettled && a.wave == b.wave
                && a.style == b.style && a.drawing == b.drawing
        }

        public var body: some View {
            let palette = WavePalette(style: style, in: environment)
            Group {
                if drawing == .renderer, #available(iOS 18.0, macOS 15.0, *) {
                    RenderedWaveText(
                        settled: settled, unsettled: unsettled, wave: wave, style: style,
                        palette: palette)
                } else {
                    SegmentWaveText(
                        settled: settled, unsettled: unsettled, wave: wave, style: style,
                        palette: palette)
                }
            }
            .font(.system(size: style.fontSize))
            .multilineTextAlignment(.leading)
        }

        /// A space between the two halves when both have words.
        static func separator(_ settled: String, _ unsettled: String) -> String {
            settled.isEmpty || unsettled.isEmpty ? "" : " "
        }
    }

    /// Three dots that rise in turn as the wave's crest crosses each third of
    /// its pass — the record button's face while the words are polished.
    ///
    /// They read the same `PolishWave` as the text from a timeline of their
    /// own: both compute the pass from the shared start date and the time they
    /// are handed, so they cannot drift apart, and neither observes the other.
    /// `still` is Reduce Motion: the dots hold at most of their brightness.
    public struct PolishWaveDots: View, Equatable {
        var wave: PolishWave
        var color: Color
        var still: Bool

        /// Dot diameter, gap and the rise at a dot's peak.
        static let size: CGFloat = 6
        static let gap: CGFloat = 5
        static let lift: CGFloat = 2.5

        public init(wave: PolishWave, color: Color = .white, still: Bool = false) {
            self.wave = wave
            self.color = color
            self.still = still
        }

        public var body: some View {
            if still {
                row(levels: nil)
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 60)) { context in
                    let progress = wave.progress(at: context.date)
                    row(levels: (0..<3).map { PolishWave.dotLevel(dot: $0, progress: progress) })
                }
            }
        }

        /// `nil` is Reduce Motion: every dot still, at most of its brightness.
        private func row(levels: [Double]?) -> some View {
            HStack(spacing: Self.gap) {
                ForEach(0..<3, id: \.self) { dot in
                    let level = levels?[dot]
                    Circle()
                        .fill(color)
                        .frame(width: Self.size, height: Self.size)
                        .opacity(level.map { 0.35 + 0.65 * $0 } ?? 0.8)
                        .offset(y: -Self.lift * CGFloat(level ?? 0))
                }
            }
            .accessibilityHidden(true)
        }
    }

    // MARK: - colour

    /// The wave's colours for one style, resolved in the view's environment.
    ///
    /// Three inks. **Resting** is the whole text while the polish runs: the
    /// full ink at reduced emphasis, dimmer than the soft ink, so the crest has
    /// somewhere to rise from. **Crest** is the full ink with a trace of the
    /// tint — under a quarter — so the band reads as light passing through the
    /// words rather than as the words turning blue. And each glyph's
    /// **settled** colour, the one it had before the wave arrived.
    ///
    /// Mixed in gamma-encoded sRGB: the tint is a judgement of how the colour
    /// looks, and a linear mix pulls a near-black ink visibly blue long before
    /// it reads as brighter.
    struct WavePalette {
        private let resting: RGBA
        private let crest: RGBA
        private let soft: RGBA
        private let full: RGBA

        init(style: PolishWaveStyle, in environment: EnvironmentValues) {
            let ink = RGBA(style.ink.resolve(in: environment))
            var rest = ink
            rest.a *= Float(PolishWave.restingOpacity)
            resting = rest
            crest = ink.mixed(with: RGBA(style.tint.resolve(in: environment)), by: PolishWave.tint)
            soft = RGBA(style.softInk.resolve(in: environment))
            full = ink
        }

        /// One glyph's colour: from its settled colour towards resting by
        /// `strength` (the wave arriving or leaving), then towards the crest by
        /// how lit it is.
        func color(unsettled: Bool, intensity: Double, strength: Double) -> Color {
            (unsettled ? full : soft).mixed(with: resting, by: strength)
                .mixed(with: crest, by: intensity * strength).color
        }

        struct RGBA {
            var r: Float
            var g: Float
            var b: Float
            var a: Float

            init(_ resolved: Color.Resolved) {
                r = resolved.red
                g = resolved.green
                b = resolved.blue
                a = resolved.opacity
            }

            func mixed(with other: RGBA, by t: Double) -> RGBA {
                let t = Float(min(max(t, 0), 1))
                var out = self
                out.r += (other.r - r) * t
                out.g += (other.g - g) * t
                out.b += (other.b - b) * t
                out.a += (other.a - a) * t
                return out
            }

            var color: Color {
                Color(.sRGB, red: Double(r), green: Double(g), blue: Double(b), opacity: Double(a))
            }
        }
    }

    // MARK: - segments

    /// The default drawing: the characters before the waving lines as one
    /// segment per settled colour, and every character of the waving lines as
    /// its own coloured segment, concatenated into one `Text`.
    private struct SegmentWaveText: View {
        let settled: String
        let unsettled: String
        let wave: PolishWave
        let style: PolishWaveStyle
        let palette: WavePalette

        /// The width the text is laid out at, for the line measurement. Zero
        /// until the first layout, when the waving part falls back to about
        /// three lines' worth of characters.
        @State private var width: CGFloat = 0

        var body: some View {
            // Once per text or width change — not per frame.
            let separator = PolishWaveText.separator(settled, unsettled)
            let characters: [(Character, unsettled: Bool)] =
                (settled + separator).map { ($0, false) } + unsettled.map { ($0, true) }
            let wavingFrom = PolishWaveLines.lastLinesStart(
                of: settled + separator + unsettled, graphemes: characters.count,
                lines: PolishWave.wavingLines, width: width, fontSize: style.fontSize)
            // 30 Hz: every tick is a new attributed string and a new layout,
            // and half the display rate is still smooth at a band this wide.
            TimelineView(.periodic(from: wave.startedAt, by: 1.0 / 30)) { context in
                text(characters, wavingFrom: wavingFrom, at: context.date)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        }

        private func text(
            _ characters: [(Character, unsettled: Bool)], wavingFrom: Int, at date: Date
        ) -> Text {
            let strength = wave.strength(at: date)
            let progress = wave.progress(at: date)
            let count = characters.count - wavingFrom

            var text = Text(verbatim: "")
            // Above the waving lines: one segment per run of one settled colour.
            var run = ""
            var runUnsettled = false
            func flush() {
                guard !run.isEmpty else { return }
                text =
                    text
                    + Text(verbatim: run).foregroundStyle(
                        palette.color(unsettled: runUnsettled, intensity: 0, strength: strength))
                run = ""
            }
            for (character, unsettled) in characters[..<wavingFrom] {
                if unsettled != runUnsettled { flush() }
                runUnsettled = unsettled
                run.append(character)
            }
            flush()
            // The waving lines: a segment per grapheme, so an emoji is one
            // step of the band and never split.
            for (offset, (character, unsettled)) in characters[wavingFrom...].enumerated() {
                let lit = PolishWave.intensity(index: offset, count: count, progress: progress)
                text =
                    text
                    + Text(verbatim: String(character)).foregroundStyle(
                        palette.color(unsettled: unsettled, intensity: lit, strength: strength))
            }
            return text
        }
    }

    /// Where the last lines of a laid-out string begin.
    enum PolishWaveLines {
        /// The grapheme index at which the last `lines` lines of `string` begin
        /// when it is set in the system font at `fontSize` and wrapped at
        /// `width`. Core Text rather than SwiftUI's own layout, which a view
        /// cannot read without a text renderer; the two break lines the same
        /// way for the system font, and a disagreement would only move where
        /// the band starts by a word. Without a width yet, the last
        /// `PolishWave.visibleGraphemes` characters.
        static func lastLinesStart(
            of string: String, graphemes: Int, lines: Int, width: CGFloat, fontSize: CGFloat
        ) -> Int {
            let fallback = max(0, graphemes - PolishWave.visibleGraphemes)
            guard width > 0, !string.isEmpty else { return fallback }
            let font = CTFontCreateUIFontForLanguage(.system, fontSize, nil)
            let attributed = NSAttributedString(
                string: string, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font as Any])
            let setter = CTFramesetterCreateWithAttributedString(attributed)
            let path = CGPath(
                rect: CGRect(x: 0, y: 0, width: width, height: 100_000), transform: nil)
            let frame = CTFramesetterCreateFrame(setter, CFRange(location: 0, length: 0), path, nil)
            guard let laid = CTFrameGetLines(frame) as? [CTLine], !laid.isEmpty else {
                return fallback
            }
            let first = laid[max(0, laid.count - lines)]
            let utf16Start = CTLineGetStringRange(first).location
            // UTF-16 offset to grapheme index.
            var offset = 0
            var index = 0
            for character in string {
                if offset >= utf16Start { break }
                offset += character.utf16.count
                index += 1
            }
            return min(index, graphemes)
        }
    }

    // MARK: - renderer (opt-in)

    /// The `TextRenderer` drawing: two copies of the text, one over the other
    /// — every glyph in the full ink at its own opacity, and under the crest
    /// the same glyphs again in the tint. Stacked, that is the crest's mix with
    /// no colour filter: a `colorMultiply` over white glyphs was the first
    /// version and drew nothing in dark mode on iOS 26.5.
    @available(iOS 18.0, macOS 15.0, *)
    private struct RenderedWaveText: View {
        let settled: String
        let unsettled: String
        let wave: PolishWave
        let style: PolishWaveStyle
        let palette: WavePalette

        var body: some View {
            let text =
                Text(verbatim: settled)
                + Text(verbatim: PolishWaveText.separator(settled, unsettled))
                + Text(verbatim: unsettled).customAttribute(UnsettledRun())
            let graphemes = GraphemeStarts(
                settled + PolishWaveText.separator(settled, unsettled) + unsettled)
            TimelineView(.animation(minimumInterval: 1.0 / 60)) { context in
                let frame = WaveFrame(
                    strength: wave.strength(at: context.date),
                    progress: wave.progress(at: context.date))
                ZStack(alignment: .topLeading) {
                    text.foregroundStyle(style.ink)
                        .textRenderer(WaveRenderer(frame: frame, blue: false, graphemes: graphemes))
                    text.foregroundStyle(style.tint)
                        .textRenderer(WaveRenderer(frame: frame, blue: true, graphemes: graphemes))
                        .accessibilityHidden(true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Marks the unsettled words, which start from the full ink.
    private struct UnsettledRun: TextAttribute {}

    private struct WaveFrame {
        var strength: Double
        var progress: Double?
    }

    /// Where each grapheme starts, in UTF-16 offsets, so a glyph is placed in
    /// reading order by character rather than by glyph.
    private struct GraphemeStarts {
        private let starts: [Int]

        init(_ string: String) {
            var starts: [Int] = []
            var offset = 0
            for character in string {
                starts.append(offset)
                offset += character.utf16.count
            }
            self.starts = starts
        }

        func ordinal(ofUTF16 offset: Int) -> Int {
            var low = 0
            var high = starts.count
            while low < high {
                let mid = (low + high) / 2
                if starts[mid] <= offset { low = mid + 1 } else { high = mid }
            }
            return max(low - 1, 0)
        }
    }

    @available(iOS 18.0, macOS 15.0, *)
    private struct WaveRenderer: TextRenderer {
        let frame: WaveFrame
        /// The tint layer: only glyphs under the crest, at up to `tint`.
        let blue: Bool
        let graphemes: GraphemeStarts

        /// The settled words' emphasis in this drawing, as an opacity of the
        /// full ink — about what the keyboard's soft ink reads as.
        static let softOpacity = 0.6

        func draw(layout: Text.Layout, in ctx: inout GraphicsContext) {
            let strength = frame.strength
            func inkOpacity(_ unsettled: Bool, _ lit: Double) -> Double {
                let settled = unsettled ? 1 : Self.softOpacity
                let base = settled + (PolishWave.restingOpacity - settled) * strength
                return base + (1 - base) * lit * strength
            }
            let lines = Array(layout)
            let wavingFrom = max(0, lines.count - PolishWave.wavingLines)
            if !blue {
                for line in lines[..<wavingFrom] {
                    for run in line {
                        var c = ctx
                        c.opacity = inkOpacity(run[UnsettledRun.self] != nil, 0)
                        c.draw(run)
                    }
                }
            }
            guard wavingFrom < lines.count,
                let origin = lines.first?.first?.characterIndices.first
            else { return }
            var glyphs: [(run: Text.Layout.Run, glyph: Int, ordinal: Int)] = []
            var last = 0
            for line in lines[wavingFrom...] {
                for run in line {
                    let indices = run.characterIndices
                    for glyph in 0..<run.count {
                        let ordinal =
                            glyph < indices.count
                            ? graphemes.ordinal(ofUTF16: origin.distance(to: indices[glyph]))
                            : (glyphs.last?.ordinal ?? 0) + 1
                        glyphs.append((run, glyph, ordinal))
                        last = max(last, ordinal)
                    }
                }
            }
            guard let first = glyphs.first?.ordinal else { return }
            for entry in glyphs {
                let lit = PolishWave.intensity(
                    index: entry.ordinal - first, count: last - first + 1,
                    progress: frame.progress)
                if blue, lit <= 0.001 { continue }
                var c = ctx
                c.opacity =
                    blue
                    ? PolishWave.tint * lit * strength
                    : inkOpacity(entry.run[UnsettledRun.self] != nil, lit)
                c.draw(entry.run[entry.glyph..<(entry.glyph + 1)])
            }
        }
    }
#endif
