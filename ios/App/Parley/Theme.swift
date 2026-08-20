import SwiftUI
import UIKit

/// Parley's semantic SwiftUI surface. The primitive values live in
/// `ParleyDesignTokens.swift`, mirrored from the Pathors landing site's
/// `--v2-*` properties; this adapter is intentionally the only place product
/// views turn them into adaptive colors. Typography is `Font.parley`
/// (`ParleyTypography.swift`).
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

    /// The microphone window (see `MicWindow`). Deliberately **iOS's own orange
    /// privacy indicator** rather than a Parley token: while a window is open
    /// the system is showing that exact dot in the status bar, and the app's
    /// mark for the same fact should be recognisably the same mark. Fixed in
    /// both appearances, because the system's is.
    static let micWindow = Color(red: 0.99, green: 0.62, blue: 0.05)

    /// The pale blue section fill the landing site uses behind grouped
    /// content. Reach for this instead of `muted` when the intent is "this is a
    /// section", not "this text is secondary".
    static let tintedSurface = adaptive(
        ParleyDesignTokens.Light.tintedSurface, ParleyDesignTokens.Dark.tintedSurface)

    // The mark's colours. Fixed rather than appearance-adaptive: these are the
    // logo's blues and they are the same blues in dark mode.
    static let brand = Color(UIColor(hex: ParleyDesignTokens.brand))
    static let sky = Color(UIColor(hex: ParleyDesignTokens.sky))

    /// brand → sky, the gradient the landing site puts on headlines, stat
    /// numbers and primary CTAs.
    static let brandGradient = LinearGradient(
        colors: [brand, sky], startPoint: .topLeading, endPoint: .bottomTrailing)

    /// What to draw *on* `brandGradient`. Fixed, like the gradient.
    static let onBrand = Color(UIColor(hex: ParleyDesignTokens.onBrand))

    /// Per-speaker colours for a diarized transcript, in hand-out order. Index
    /// with `(speaker - 1) % count`; speaker 0 means the provider hasn't
    /// decided yet and belongs in `mutedForeground`, not here.
    static let speakers: [Color] = zip(
        ParleyDesignTokens.Speaker.light, ParleyDesignTokens.Speaker.dark
    ).map { adaptive($0, $1) }

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
        case .system: return String(localized: "System")
        case .light: return String(localized: "Light")
        case .dark: return String(localized: "Dark")
        }
    }
}
