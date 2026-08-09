import SwiftUI
import UIKit

/// The keyboard's palette.
///
/// The extension can't reach the app target's `Theme`, and it must not follow
/// the *system* appearance either: a keyboard follows the appearance of the
/// field it is typing into (`UITextDocumentProxy.keyboardAppearance`), which a
/// dark-themed host app sets to `.dark` even while iOS is in light mode. Every
/// color here therefore takes the resolved appearance explicitly rather than
/// reading the trait collection.
enum KBTheme {
    /// Parley's accent, matching the app's design tokens.
    static let accent = Color(red: 0.04, green: 0.52, blue: 1.0)
    static let recording = Color(red: 0.90, green: 0.27, blue: 0.24)

    static func canvas(_ dark: Bool) -> Color {
        dark ? Color(white: 0.11) : Color(red: 0.82, green: 0.84, blue: 0.86)
    }

    /// Key cap — deliberately lighter than the canvas in both appearances, the
    /// way system keys read.
    static func key(_ dark: Bool) -> Color {
        dark ? Color(white: 0.28) : .white
    }

    static func keyPressed(_ dark: Bool) -> Color {
        dark ? Color(white: 0.38) : Color(white: 0.85)
    }

    static func ink(_ dark: Bool) -> Color {
        dark ? .white : Color(white: 0.08)
    }

    static func inkSoft(_ dark: Bool) -> Color {
        dark ? Color(white: 0.62) : Color(white: 0.38)
    }

    /// Surface behind the transcript preview.
    static func well(_ dark: Bool) -> Color {
        dark ? Color(white: 0.16) : Color(white: 0.94)
    }
}
