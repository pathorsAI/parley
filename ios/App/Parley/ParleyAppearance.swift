import UIKit

/// The UIKit-drawn chrome, brought onto DM Sans.
///
/// SwiftUI's `.font()` never reaches a navigation bar title or a tab bar item
/// label: both are drawn by UIKit from `UINavigationBarAppearance` /
/// `UITabBarAppearance`. A re-skin that only touches views therefore leaves the
/// two most prominent pieces of text in the app — "Library", "Settings", and the
/// three tab labels — in SF Pro, which is what makes an otherwise rebranded app
/// read as half done.
///
/// **Fonts are the whole job here now.** The colours are the system's own
/// semantic ones (`label`, `secondaryLabel`, `separator`) and the selected tab
/// item is the app's tint — the same values SwiftUI would pick if this file did
/// not exist. They are still named rather than left out, because a
/// `configureWith…Background()` call resets the text attributes along with the
/// fill and the font has to be re-stated anyway.
///
/// `ParleyApp` calls `apply()` once at launch; nothing else should touch a UIKit
/// appearance proxy.
///
/// Two rules the rest of the file follows:
///
/// - **Colours are UIKit semantic colours, or dynamic providers built from
///   `ParleyDesignTokens`** — never a SwiftUI `Color` round-tripped through
///   `UIColor(_:)`, which resolves against whatever trait collection happens to
///   be current and then stops switching with the appearance. An appearance
///   proxy is read once, so it would freeze whichever mode the app launched in.
/// - **Every font goes through `UIFontMetrics`.** `UIFont(name:size:)` is a
///   fixed point size and does not scale, so chrome set this way would sit at
///   34pt while the rest of the app grows with the user's text size. Ignoring
///   Dynamic Type is an accessibility regression, and App Review notices.
enum ParleyAppearance {
    static func apply() {
        applyNavigationBar()
        applyTabBar()
    }

    // MARK: - Navigation bars

    private static func applyNavigationBar() {
        // Everything except the background, which the resting and scrolled
        // states disagree about. `background` is applied first on purpose:
        // every `configureWith…Background()` call resets the text attributes
        // along with the fill, so setting them the other way round silently
        // throws the fonts away.
        func appearance(_ background: (UINavigationBarAppearance) -> Void)
            -> UINavigationBarAppearance
        {
            let a = UINavigationBarAppearance()
            background(a)
            a.largeTitleTextAttributes = [
                .font: scaledFont(ParleyTypography.Face.bold, 34, .largeTitle, fallback: .bold),
                .foregroundColor: foreground,
            ]
            a.titleTextAttributes = [
                .font: scaledFont(
                    ParleyTypography.Face.semibold, 17, .headline, fallback: .semibold),
                .foregroundColor: foreground,
            ]
            // A back-button label shares a baseline with the inline title; left
            // in SF Pro next to a DM Sans title it is the one word that gives
            // the swap away.
            let button = UIBarButtonItemAppearance(style: .plain)
            let buttonFont = scaledFont(
                ParleyTypography.Face.regular, 17, .body, fallback: .regular)
            for state in [button.normal, button.highlighted, button.disabled] {
                state.titleTextAttributes = [.font: buttonFont]
            }
            a.buttonAppearance = button
            a.backButtonAppearance = button
            return a
        }

        // Resting state, at the top of a scroll view: transparent, so the page
        // colour every view already paints (`Theme.background`) runs straight
        // up into the bar.
        //
        // Deliberately *not* an opaque `Theme.background` fill, which was the
        // first thing tried: on iOS 26 an opaque nav-bar background paints a
        // solid band over the whole large-title area and the title disappears
        // underneath it. Verified on an iPhone 17 Pro Max simulator by filling
        // the bar yellow — the band covers the title exactly. Transparent gets
        // the same flat page colour with none of that, because the bar has the
        // app's own background behind it either way.
        let scrollEdge = appearance { $0.configureWithTransparentBackground() }

        // Scrolled state: content is passing under the bar, so it needs
        // something behind the title. The system material, which on iOS 26 is
        // glass that samples the page beneath it — over a #FFFFFF page it reads
        // white and over #0C1620 it reads navy, so it never settles on the grey
        // a fixed fill would. The hairline is the system separator; a
        // blue-tinted one used to live here and was the last decorative line in
        // the chrome.
        let standard = appearance { $0.configureWithDefaultBackground() }
        standard.shadowColor = .separator

        UINavigationBar.appearance().standardAppearance = standard
        UINavigationBar.appearance().compactAppearance = standard
        UINavigationBar.appearance().scrollEdgeAppearance = scrollEdge
        UINavigationBar.appearance().compactScrollEdgeAppearance = scrollEdge
    }

    // MARK: - Tab bar

    private static func applyTabBar() {
        let appearance = UITabBarAppearance()

        // The default background here, deliberately — the opposite call from
        // the navigation bar, for the opposite reason. On iOS 26 the tab bar is
        // a detached floating capsule rather than a full-width bar: it samples
        // the page under it, so it reads white over the white page and navy
        // over the navy-black one, and never lands on the grey a nav-bar
        // material would. Forcing `configureWithOpaqueBackground()` would trade
        // that for a flat slab in a colour the platform no longer expects the
        // capsule to be, and the shape would stop looking like iOS 26.
        appearance.configureWithDefaultBackground()

        // The selected item is the signal blue; the rest are `secondaryLabel`.
        // Both are what the system would already do — the tint comes from
        // `ParleyApp`'s `.tint` and unselected items are secondary by default —
        // so nothing here fights the platform. They are named only because
        // `configureWithDefaultBackground()` above wipes the attributes and the
        // font has to be re-applied regardless.
        let title = scaledFont(ParleyTypography.Face.medium, 10, .caption2, fallback: .medium)
        for item in [
            appearance.stackedLayoutAppearance,
            appearance.inlineLayoutAppearance,
            appearance.compactInlineLayoutAppearance,
        ] {
            item.normal.titleTextAttributes = [.font: title, .foregroundColor: UIColor.secondaryLabel]
            item.normal.iconColor = .secondaryLabel
            item.selected.titleTextAttributes = [.font: title, .foregroundColor: accent]
            item.selected.iconColor = accent
        }

        UITabBar.appearance().standardAppearance = appearance
        UITabBar.appearance().scrollEdgeAppearance = appearance
    }

    // MARK: - Colours

    /// Title and large-title ink.
    private static let foreground = UIColor.label
    /// `Theme.primary`, rebuilt as a dynamic provider: the signal blue, brand in
    /// light and sky in dark, because #1469D4 cannot be read as a selected state
    /// on the navy-black page.
    private static let accent = dynamic(
        ParleyDesignTokens.Light.primary, ParleyDesignTokens.Dark.primary)

    private static func dynamic(_ light: UInt32, _ dark: UInt32) -> UIColor {
        UIColor { traits in
            UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
        }
    }

    // MARK: - Fonts

    /// A bundled face at `size`, scaled for the user's text size.
    ///
    /// `fallback` is the system weight to use if the face cannot be resolved —
    /// `UIFont(name:size:)` returns nil when `UIAppFonts` and the copied
    /// resources have drifted apart (`ParleyTypography.unresolvedFaces()`
    /// reports it), and chrome with no font at all is worse than chrome in SF
    /// Pro.
    private static func scaledFont(
        _ name: String, _ size: CGFloat, _ style: UIFont.TextStyle, fallback: UIFont.Weight
    ) -> UIFont {
        let base = UIFont(name: name, size: size) ?? .systemFont(ofSize: size, weight: fallback)
        return UIFontMetrics(forTextStyle: style).scaledFont(for: base)
    }
}
