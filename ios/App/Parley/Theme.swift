import SwiftUI
import UIKit

/// Parley's design tokens, translated from the desktop's `src/index.css`
/// (shadcn neutral scale, pure achromatic oklch ≈ Tailwind `neutral`).
/// Semantic names match the CSS custom properties so the two UIs stay in
/// lockstep; each Color adapts to light/dark like the `.dark` class does.
enum Theme {
    // oklch lightness → Tailwind neutral hex, verified against index.css
    private static let n50 = UIColor(hex: 0xFAFAFA)   // oklch 0.985
    private static let n100 = UIColor(hex: 0xF5F5F5)  // 0.97
    private static let n200 = UIColor(hex: 0xE5E5E5)  // 0.922
    private static let n400 = UIColor(hex: 0xA3A3A3)  // 0.708
    private static let n500 = UIColor(hex: 0x737373)  // 0.556
    private static let n800 = UIColor(hex: 0x262626)  // 0.269
    private static let n900 = UIColor(hex: 0x171717)  // 0.205
    private static let n950 = UIColor(hex: 0x0A0A0A)  // 0.145

    static let background = adaptive(light: .white, dark: n950)
    static let foreground = adaptive(light: n950, dark: n50)
    static let card = adaptive(light: .white, dark: n900)
    static let muted = adaptive(light: n100, dark: n800)
    static let mutedForeground = adaptive(light: n500, dark: n400)
    static let primary = adaptive(light: n900, dark: UIColor(hex: 0xE5E5E5))
    static let primaryForeground = adaptive(light: n50, dark: n900)
    static let border = adaptive(
        light: n200, dark: UIColor.white.withAlphaComponent(0.10))
    static let destructive = adaptive(
        light: UIColor(hex: 0xDC2626), dark: UIColor(hex: 0xF87171))
    /// Live-recording red, same in both themes (desktop uses it for the rec dot).
    static let recording = Color(UIColor(hex: 0xEF4444))

    // Desktop's semantic accent conventions (Tailwind literals, not tokens):
    // violet = replay/study, sky = org/shared, amber = stale/paused,
    // emerald = synced/success.
    static let study = adaptive(light: UIColor(hex: 0x7C3AED), dark: UIColor(hex: 0xA78BFA))
    static let org = adaptive(light: UIColor(hex: 0x0284C7), dark: UIColor(hex: 0x38BDF8))
    static let warning = adaptive(light: UIColor(hex: 0xD97706), dark: UIColor(hex: 0xFBBF24))
    static let success = adaptive(light: UIColor(hex: 0x059669), dark: UIColor(hex: 0x34D399))

    /// --radius: 0.625rem
    static let radius: CGFloat = 10

    private static func adaptive(light: UIColor, dark: UIColor) -> Color {
        Color(
            UIColor { traits in
                traits.userInterfaceStyle == .dark ? dark : light
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
        case .system: return "跟隨系統"
        case .light: return "淺色"
        case .dark: return "深色"
        }
    }
}
