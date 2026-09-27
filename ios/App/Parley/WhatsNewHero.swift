import ParleyKit
import SwiftUI
import UIKit

/// The native pictures an announcement can name as its `hero`.
///
/// An announcement file is shared by every platform and cannot carry a view,
/// so it names one by id and each app keeps its own registry of what the ids
/// draw. An id this build does not know draws nothing and the sheet is whole
/// without it — which is what lets a newer file name a hero an older build has
/// never heard of.
///
/// To add one: a view that fits `height` × the sheet's width, decorative (the
/// sheet hides it from VoiceOver — the copy says what it shows), and cheap
/// enough to animate while the sheet is up; then a line in `view(for:)`.
enum WhatsNewHero {
    static let height: CGFloat = 150
    static let corner: CGFloat = 16

    /// The hero for an id, or `nil` for none or one this build does not know.
    /// `localization` is the UI language, for heroes that carry sample text.
    static func view(for id: String?, localization: String) -> AnyView? {
        let chinese = localization.hasPrefix("zh")
        switch id {
        case "keyboard-wave": return AnyView(KeyboardWaveHero(chinese: chinese))
        default: return nil
        }
    }
}

/// `keyboard-wave`: the keyboard's voice pane in miniature, in its new
/// polishing state — a finished transcript with the wave running through it, ✕
/// still there to throw it away, ⌫ dimmed because there is nothing to delete
/// yet, and the brand-gradient button between them with its three dots
/// lighting in step with the wave.
///
/// Drawn in the keyboard's own colours rather than the app's: this is a picture
/// *of the keyboard*, and it should look like the thing the user will meet in
/// another app, not like a Parley screen. The values are `KBTheme`'s (the
/// extension's palette, which the app target cannot import), copied here with
/// the name of the one they mirror. Sizes are fixed rather than Dynamic Type:
/// it is a picture, and the sheet's own text is what scales.
///
/// The wave is the keyboard's own — ParleyKit's `PolishWave`, `PolishWaveText`
/// and `PolishWaveDots` — with the keyboard's per-appearance tuning
/// (`TranscriptText.style` in `KeyboardPolishWave.swift`), so the picture moves
/// exactly as the real thing does. It loops for free: a `PolishWave` with no
/// `endedAt` repeats pass and rest for as long as it is drawn, and it is only
/// drawn while the sheet is up. Under Reduce Motion the text sits at the wave's
/// resting emphasis and the dots hold still, as the keyboard does.
struct KeyboardWaveHero: View {
    let chinese: Bool

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// One clock for the text and the dots, so they stay in step. Started when
    /// the hero is built, which is when the sheet comes up.
    @State private var wave: PolishWave

    private static let fontSize: CGFloat = 13

    init(chinese: Bool) {
        self.chinese = chinese
        let graphemes = Self.sample(chinese: chinese).count
        _wave = State(
            initialValue: PolishWave(
                startedAt: Date(), pass: PolishWave.passDuration(graphemes: graphemes)))
    }

    private var dark: Bool { colorScheme == .dark }

    private static func sample(chinese: Bool) -> String {
        chinese
            ? "嗯明天下午三點的會議我想改到四點，然後幫我跟 Brandon 說一下那個 demo 要先準備好"
            : "Um, can we move tomorrow's 3 p.m. meeting to 4, and tell Brandon the demo needs to be ready first"
    }

    /// `TranscriptText.style`, at the hero's size: the crest leans towards the
    /// wordmark's blue — brand in light at 40 %, sky in dark at a quarter — and
    /// the resting emphasis is 0.32 of the ink in light, 0.36 in dark.
    private var style: PolishWaveStyle {
        PolishWaveStyle(
            ink: ink, softInk: inkSoft, tint: dark ? Self.sky : Self.brand,
            tintAmount: dark ? 0.25 : 0.40,
            restingOpacity: dark ? 0.36 : 0.32,
            fontSize: Self.fontSize)
    }

    var body: some View {
        VStack(spacing: 12) {
            Spacer(minLength: 0)
            Group {
                if reduceMotion {
                    Text(verbatim: Self.sample(chinese: chinese))
                        .font(.system(size: Self.fontSize))
                        .foregroundStyle(style.restingInk)
                } else {
                    PolishWaveText(
                        settled: Self.sample(chinese: chinese), wave: wave, style: style)
                }
            }
            .lineLimit(3)
            .frame(maxWidth: .infinity, alignment: .bottomLeading)
            .padding(.horizontal, 18)

            HStack(spacing: 0) {
                disc(systemName: "xmark", weight: .semibold)
                Spacer(minLength: 0)
                polishButton
                Spacer(minLength: 0)
                disc(systemName: "delete.left", weight: .regular)
                    .opacity(0.4)
            }
            .padding(.horizontal, 24)
        }
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(backdrop)
    }

    // MARK: pieces

    /// `KeyboardRootView`'s round controls: a translucent wash, no cap.
    private func disc(systemName: String, weight: Font.Weight) -> some View {
        ZStack {
            Circle().fill(control)
            Image(systemName: systemName)
                .font(.system(size: 13, weight: weight))
                .foregroundStyle(ink)
        }
        .frame(width: 34, height: 34)
    }

    /// The record button while the transcript is being polished: the idle
    /// gradient, with the three dots where the glyph would be.
    private var polishButton: some View {
        ZStack {
            Circle()
                .fill(
                    LinearGradient(
                        colors: [Self.brand, Self.sky], startPoint: .topLeading,
                        endPoint: .bottomTrailing))
            PolishWaveDots(wave: wave, color: .white, still: reduceMotion)
        }
        .frame(width: 58, height: 58)
    }

    // MARK: KBTheme, mirrored

    /// `KBTheme.backdrop`: #171717 dark, #E2E4E8 light.
    private var backdrop: Color {
        dark
            ? Color(red: 0x17 / 255, green: 0x17 / 255, blue: 0x17 / 255)
            : Color(red: 0xE2 / 255, green: 0xE4 / 255, blue: 0xE8 / 255)
    }

    /// `KBTheme.control`.
    private var control: Color {
        dark ? Color.white.opacity(0.10) : Color.black.opacity(0.075)
    }

    /// `KBTheme.ink`.
    private var ink: Color {
        dark ? .white : Color(white: 0.08)
    }

    /// `KBTheme.inkSoft`.
    private var inkSoft: Color {
        dark ? Color(white: 0.62) : Color(white: 0.38)
    }

    /// `KBTheme.brand` (#1469D4) and `KBTheme.sky` (#2DB6F3).
    private static let brand = Color(red: 0x14 / 255, green: 0x69 / 255, blue: 0xD4 / 255)
    private static let sky = Color(red: 0x2D / 255, green: 0xB6 / 255, blue: 0xF3 / 255)
}

#if DEBUG
    #Preview("keyboard-wave — light") {
        KeyboardWaveHero(chinese: true)
            .frame(height: WhatsNewHero.height)
            .clipShape(RoundedRectangle(cornerRadius: WhatsNewHero.corner, style: .continuous))
            .padding(20)
            .preferredColorScheme(.light)
    }

    #Preview("keyboard-wave — dark, en") {
        KeyboardWaveHero(chinese: false)
            .frame(height: WhatsNewHero.height)
            .clipShape(RoundedRectangle(cornerRadius: WhatsNewHero.corner, style: .continuous))
            .padding(20)
            .preferredColorScheme(.dark)
    }
#endif
