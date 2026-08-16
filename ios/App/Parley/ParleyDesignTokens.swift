// Parley's primitive colour values for iOS. Hand-maintained.
//
// This file used to be generated from `design/tokens.json` by
// `scripts/generate-design-tokens.mjs`. Neither still exists — the desktop app
// keeps its own palette in `src/`, and these values are now iOS-only. Edit them
// here.
//
// The palette mirrors the Pathors landing site's `--v2-*` custom properties in
// `components/v2/v2.css` (the `.v2-root` block) of the `landing` repository.
// When the brand moves, re-sync from there; see
// `docs/design/ios-visual-language.md` for the mapping.
import CoreGraphics

enum ParleyDesignTokens {
    /// Pathors runs light-first: a white page, pale blue section fills, brand
    /// blue accents.
    enum Light {
        static let background: UInt32 = 0xFFFFFF
        static let foreground: UInt32 = 0x1A1A1A  // --v2-ink
        static let card: UInt32 = 0xFAFAFA  // --v2-card
        static let muted: UInt32 = 0xEEF9FF  // --v2-bg, the pale blue section fill
        // --v2-body. Deliberately not --v2-muted (#98A0A5), which fails
        // contrast as body text.
        static let mutedForeground: UInt32 = 0x535353
        static let primary: UInt32 = 0x1469D4  // --v2-brand
        static let primaryForeground: UInt32 = 0xFFFFFF
        static let border: UInt32 = 0xD7E9F5  // blue-tinted, derived from --v2-tint
        static let destructive: UInt32 = 0xDC2626
        static let study: UInt32 = 0x7C3AED
        static let org: UInt32 = 0x1469D4  // --v2-brand
        static let warning: UInt32 = 0xD97706
        static let success: UInt32 = 0x059669
        /// Grouped-background fill. Same pale blue as `muted`, named for the
        /// role so a later retune of one doesn't silently drag the other.
        static let tintedSurface: UInt32 = 0xEEF9FF
    }

    /// A navy-black derived from the landing site's --v2-navy (#1B3A66) rather
    /// than a neutral black, so dark mode still reads as the same brand.
    enum Dark {
        static let background: UInt32 = 0x0C1620
        static let foreground: UInt32 = 0xF2F7FB
        static let card: UInt32 = 0x13212E
        static let muted: UInt32 = 0x1B2C3C
        static let mutedForeground: UInt32 = 0x9BB0C2
        // Sky, not brand blue: #1469D4 is too dark to read on a navy-black page.
        static let primary: UInt32 = 0x2DB6F3
        static let primaryForeground: UInt32 = 0x08131C
        // White; `Theme.border` applies darkAlpha 0.10 on top of it.
        static let border: UInt32 = 0xFFFFFF
        static let destructive: UInt32 = 0xF87171
        static let study: UInt32 = 0xA78BFA
        static let org: UInt32 = 0x38BDF8
        static let warning: UInt32 = 0xFBBF24
        static let success: UInt32 = 0x34D399
        static let tintedSurface: UInt32 = 0x13212E
    }

    /// The mark's own colours. Fixed in both appearances — a logo that changes
    /// hue with the system theme isn't a logo.
    static let brand: UInt32 = 0x1469D4  // --v2-brand
    static let sky: UInt32 = 0x2DB6F3  // --v2-sky

    /// Text and glyphs sitting on `Theme.brandGradient`. Fixed white, because
    /// the gradient itself does not change with the appearance — reaching for
    /// `primaryForeground` here inverts to near-black in dark mode and the
    /// label disappears into the blue.
    static let onBrand: UInt32 = 0xFFFFFF

    /// Six hues for diarized speakers, in the order they get handed out.
    ///
    /// Not assembled from the semantic tokens: `brand` and `org` are the same
    /// blue in light mode, so speakers 1 and 4 came out identical, and `sky` on
    /// a white page is about 2.2:1 — below the 3:1 a small bold label needs.
    /// These are picked for *separation between neighbours* first, on the page
    /// each appearance actually draws.
    enum Speaker {
        static let light: [UInt32] = [
            0x1469D4,  // brand blue
            0x7C3AED,  // violet
            0x047857,  // green
            0xB45309,  // amber
            0x0E7490,  // teal
            0xBE185D,  // rose
        ]
        /// The same six, lifted for a navy-black page.
        static let dark: [UInt32] = [
            0x60B8F8, 0xC4B5FD, 0x5EEAD4, 0xFCD34D, 0x67E8F9, 0xF9A8D4,
        ]
    }

    /// Recording red has no counterpart in the Pathors palette and is a
    /// universal signal, so it stays put.
    static let recording: UInt32 = 0xEF4444
    /// 12, not 10: Pathors' cards are softer than the iOS default.
    static let radius: CGFloat = 12
}
