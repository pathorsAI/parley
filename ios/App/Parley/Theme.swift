import SwiftUI
import UIKit

/// Parley's semantic SwiftUI surface — what is left of it.
///
/// The visual language is **white page, ink text, blue as a signal**: the page
/// is `Theme.background`, every piece of text is a system semantic colour
/// (`Color(.label)`, `Color(.secondaryLabel)`, `Color(.tertiaryLabel)`), every
/// hairline is `Color(.separator)`, and nothing is filled to mark it out. So
/// this enum holds only the values the platform has no answer for; reach for
/// `Color(.label)` and friends directly at the call site for everything else.
///
/// `primary` is the one blue, and it is a *signal*: it marks what is happening
/// now (the speaker currently talking, the selected tab, the selected folder
/// chip) and what can be tapped. It is applied once as the app's `.tint` in
/// `ParleyApp`, so most call sites do not have to name it at all. It is never a
/// fill behind content.
///
/// Primitive values live in `ParleyDesignTokens.swift`; typography is
/// `Font.parley` (`ParleyTypography.swift`). See
/// `docs/design/ios-visual-language.md`.
enum Theme {
    static let background = adaptive(ParleyDesignTokens.Light.background, ParleyDesignTokens.Dark.background)
    /// The signal blue. Also the app's `.tint`.
    static let primary = adaptive(ParleyDesignTokens.Light.primary, ParleyDesignTokens.Dark.primary)
    /// A recording is running. The one colour that outranks the blue.
    static let recording = adaptive(ParleyDesignTokens.Light.recording, ParleyDesignTokens.Dark.recording)
    static let radius = ParleyDesignTokens.radius

    // Status colours, taken from the system rather than tuned here: a red that
    // means "this failed" and a green that means "this is fine" are the
    // platform's words, not the brand's, and the system ones already follow
    // Increase Contrast and the appearance.
    static let destructive = Color(.systemRed)
    static let warning = Color(.systemOrange)
    static let success = Color(.systemGreen)

    /// The microphone window (see `MicWindow`). Deliberately **iOS's own orange
    /// privacy indicator** rather than a Parley token: while a window is open
    /// the system is showing that exact dot in the status bar, and the app's
    /// mark for the same fact should be recognisably the same mark. Fixed in
    /// both appearances, because the system's is.
    static let micWindow = Color(red: 0.99, green: 0.62, blue: 0.05)

    private static func adaptive(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(
            UIColor { traits in
                UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
            })
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1)
    }
}

/// The desktop's `AppTheme` setting: "system" | "light" | "dark" (types.ts).
enum AppTheme: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }

    var label: String {
        switch self {
        case .system: return String(localized: "System")
        case .light: return String(localized: "Light")
        case .dark: return String(localized: "Dark")
        }
    }
}
