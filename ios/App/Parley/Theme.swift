import SwiftUI
import UIKit

/// Parley's semantic SwiftUI surface. The actual primitive values are generated
/// from `design/tokens.json` into `ParleyDesignTokens.swift`; this adapter is
/// intentionally the only place product views turn them into adaptive colors.
enum Theme {
    static let background = adaptive(ParleyDesignTokens.Light.background, ParleyDesignTokens.Dark.background)
    static let foreground = adaptive(ParleyDesignTokens.Light.foreground, ParleyDesignTokens.Dark.foreground)
    static let card = adaptive(ParleyDesignTokens.Light.card, ParleyDesignTokens.Dark.card)
    static let muted = adaptive(ParleyDesignTokens.Light.muted, ParleyDesignTokens.Dark.muted)
    static let mutedForeground = adaptive(ParleyDesignTokens.Light.mutedForeground, ParleyDesignTokens.Dark.mutedForeground)
    static let primary = adaptive(ParleyDesignTokens.Light.primary, ParleyDesignTokens.Dark.primary)
    static let primaryForeground = adaptive(ParleyDesignTokens.Light.primaryForeground, ParleyDesignTokens.Dark.primaryForeground)
    static let border = adaptive(ParleyDesignTokens.Light.border, ParleyDesignTokens.Dark.border, darkAlpha: 0.10)
    static let destructive = adaptive(ParleyDesignTokens.Light.destructive, ParleyDesignTokens.Dark.destructive)
    static let recording = Color(UIColor(hex: ParleyDesignTokens.recording))
    static let study = adaptive(ParleyDesignTokens.Light.study, ParleyDesignTokens.Dark.study)
    static let org = adaptive(ParleyDesignTokens.Light.org, ParleyDesignTokens.Dark.org)
    static let warning = adaptive(ParleyDesignTokens.Light.warning, ParleyDesignTokens.Dark.warning)
    static let success = adaptive(ParleyDesignTokens.Light.success, ParleyDesignTokens.Dark.success)
    static let radius = ParleyDesignTokens.radius

    private static func adaptive(_ light: UInt32, _ dark: UInt32, darkAlpha: CGFloat = 1) -> Color {
        Color(
            UIColor { traits in
                UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
                    .withAlphaComponent(traits.userInterfaceStyle == .dark ? darkAlpha : 1)
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
