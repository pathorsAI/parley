// Parley's primitive colour values for iOS. Hand-maintained.
//
// There are three of them, and that is the point. Everything else on screen —
// text, hairlines, grouped fills in Settings — is a **system semantic colour**
// (`label`, `secondaryLabel`, `tertiaryLabel`, `separator`), because the system
// ones already adapt to appearance, contrast settings and Increase Contrast,
// and a hand-tuned grey does not. See `docs/design/ios-visual-language.md`.
//
// What is left here is what the platform has no answer for:
//
//   - `background`, because the dark page is a navy-black rather than the
//     system's neutral one,
//   - `primary`, the brand blue Parley uses as a *signal* (what is happening
//     now, what you can tap),
//   - `recording`, the red of a running recording.
//
// `primary` mirrors the Pathors landing site's `--v2-brand` / `--v2-sky`
// custom properties in `components/v2/v2.css` of the `landing` repository.
import CoreGraphics

enum ParleyDesignTokens {
    /// Pathors runs light-first: a white page, ink text, blue only where it
    /// means something.
    enum Light {
        static let background: UInt32 = 0xFFFFFF
        static let primary: UInt32 = 0x1469D4  // --v2-brand
        static let recording: UInt32 = 0xE5322D
    }

    /// A navy-black derived from the landing site's --v2-navy (#1B3A66) rather
    /// than a neutral black, so dark mode still reads as the same brand. The
    /// system semantic text colours resolve correctly on top of it — they key
    /// off the trait collection's interface style, not off the pixel behind.
    enum Dark {
        static let background: UInt32 = 0x0C1620
        // Sky, not brand blue: #1469D4 is too dark to read on a navy-black page.
        static let primary: UInt32 = 0x2DB6F3  // --v2-sky
        static let recording: UInt32 = 0xFF453A  // systemRed's dark variant
    }

    /// 12, not 10: the few remaining corners Parley rounds are softer than the
    /// iOS default.
    static let radius: CGFloat = 12
}
