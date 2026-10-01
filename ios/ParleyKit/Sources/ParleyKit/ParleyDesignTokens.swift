// Parley's primitive colour values for iOS. Hand-maintained.
//
// There are three Parley colours, and that is the point. Everything else on
// screen — text, hairlines, grouped fills in Settings — is a **system semantic
// colour** (`label`, `secondaryLabel`, `tertiaryLabel`, `separator`), because
// the system ones already adapt to appearance, contrast settings and Increase
// Contrast, and a hand-tuned grey does not. See
// `docs/design/ios-visual-language.md`.
//
// What is left here is what the platform has no answer for:
//
//   - `background`, because the dark page is a navy-black rather than the
//     system's neutral one,
//   - `primary`, the brand blue Parley uses as a *signal* (what is happening
//     now, what you can tap),
//   - `recording`, the red of a running recording.
//
// `micWindow` is the exception that proves it: a fourth value, and the only one
// here that is not Parley's — see its own comment.
//
// `primary` mirrors the Pathors landing site's `--v2-brand` / `--v2-sky`
// custom properties in `components/v2/v2.css` of the `landing` repository.
//
// They live in ParleyKit rather than in the app target because the widget
// extension draws the same marks — a Live Activity showing a running recording
// has to use the app's red, not a red of its own — and an extension cannot
// import the app.
import CoreGraphics

public enum ParleyDesignTokens {
    /// Pathors runs light-first: a white page, ink text, blue only where it
    /// means something.
    public enum Light {
        public static let background: UInt32 = 0xFFFFFF
        public static let primary: UInt32 = 0x1469D4  // --v2-brand
        public static let recording: UInt32 = 0xE5322D
    }

    /// A navy-black derived from the landing site's --v2-navy (#1B3A66) rather
    /// than a neutral black, so dark mode still reads as the same brand. The
    /// system semantic text colours resolve correctly on top of it — they key
    /// off the trait collection's interface style, not off the pixel behind.
    public enum Dark {
        public static let background: UInt32 = 0x0C1620
        // Sky, not brand blue: #1469D4 is too dark to read on a navy-black page.
        public static let primary: UInt32 = 0x2DB6F3  // --v2-sky
        public static let recording: UInt32 = 0xFF453A  // systemRed's dark variant
    }

    /// The microphone window's orange — iOS's own privacy-indicator orange
    /// rather than a Parley colour, because while a window is open the system
    /// is showing that exact dot in the status bar, and the app's mark for the
    /// same fact should be recognisably the same mark. One value rather than a
    /// light/dark pair, because the system's dot is one value too.
    public static let micWindow: UInt32 = 0xFC9E0D

    /// 12, not 10: the few remaining corners Parley rounds are softer than the
    /// iOS default.
    public static let radius: CGFloat = 12
}
