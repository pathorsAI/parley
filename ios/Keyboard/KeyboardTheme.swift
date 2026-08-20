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
///
/// The canvas is deliberately absent: the keyboard paints no background of its
/// own so the system's `UIInputView` shows through, which is the only way the
/// colour, the corner treatment and the extent line up with the system
/// keyboard on every device and in every host app.
enum KBTheme {
    /// Parley's accent, matching the app's design tokens. Used for the accented
    /// return key (Go / Send / Search / Done), the way iOS tints it.
    static let accent = Color(red: 0.04, green: 0.52, blue: 1.0)
    static let recording = Color(red: 0.90, green: 0.27, blue: 0.24)
    /// The relay dropped and the app is redialling. Amber on purpose: red is
    /// reserved for a session that actually ended, and a reconnect has not.
    static let reconnecting = Color(red: 0.85, green: 0.55, blue: 0.09)
    /// The microphone window is open. This is **iOS's own orange privacy
    /// indicator**, not a Parley colour: the system is showing that exact dot
    /// in the status bar for the same reason, and the two marks meaning the
    /// same thing should look like the same thing. Close to `reconnecting`, but
    /// never on screen at the same time — one is about the socket during a
    /// session, the other about the microphone between them.
    static let micWindow = Color(red: 0.99, green: 0.62, blue: 0.05)

    /// Pathors' two brand blues, mirroring the tokens on the landing site
    /// (`#1469D4` deep and `#2DB6F3` sky). They are used sparingly and only
    /// where the keyboard is allowed to be Parley rather than iOS: the mic pill
    /// and the wordmark. The key caps stay system-coloured, because a keyboard
    /// that doesn't look like a keyboard reads as broken.
    static let brand = Color(red: 0.078, green: 0.412, blue: 0.831)
    static let sky = Color(red: 0.176, green: 0.714, blue: 0.953)

    /// The idle mic pill. Recording swaps this for the flat `recording` red so
    /// "armed" never has to be inferred from a gradient.
    static let micGradient = LinearGradient(
        colors: [brand, sky], startPoint: .topLeading, endPoint: .bottomTrailing)

    /// The wordmark leans on whichever brand blue survives the backdrop.
    static func wordmark(_ dark: Bool) -> Color {
        dark ? sky : brand
    }

    /// Key cap — deliberately lighter than the input view behind it in both
    /// appearances, the way system letter keys read.
    static func key(_ dark: Bool) -> Color {
        dark ? Color(white: 0.28) : .white
    }

    static func keyPressed(_ dark: Bool) -> Color {
        dark ? Color(white: 0.38) : Color(white: 0.85)
    }

    /// The duller cap iOS gives the keys that aren't letters — shift, delete,
    /// `123`, globe, return. Pressing one lightens it *towards* a letter key,
    /// which is the inverse of how a letter key behaves; that inversion is what
    /// makes the two families distinguishable under a finger.
    static func keyAlt(_ dark: Bool) -> Color {
        dark ? Color(white: 0.18) : Color(red: 0.68, green: 0.70, blue: 0.74)
    }

    static func keyAltPressed(_ dark: Bool) -> Color {
        dark ? Color(white: 0.30) : .white
    }

    /// The voice pane's round control buttons.
    ///
    /// Deliberately *not* a key cap. The voice pane is a control panel, not a
    /// keyboard — nothing on it types a letter — so it borrows none of UIKit's
    /// cap treatment: no light fill, no hard shadow, no press inversion. A cap's
    /// raised look says "there are twenty-six of these, start typing", which on
    /// four control buttons is pure noise. A translucent wash over whatever the
    /// input view is already showing also stays correct in both appearances
    /// without a colour that has to be maintained twice.
    static func control(_ dark: Bool) -> Color {
        dark ? Color.white.opacity(0.10) : Color.black.opacity(0.075)
    }

    static func controlPressed(_ dark: Bool) -> Color {
        dark ? Color.white.opacity(0.20) : Color.black.opacity(0.15)
    }

    /// The trough behind the voice/EN segmented control in the mode strip.
    static func segmentTrack(_ dark: Bool) -> Color {
        dark ? Color(white: 0.20) : Color.black.opacity(0.06)
    }

    static func ink(_ dark: Bool) -> Color {
        dark ? .white : Color(white: 0.08)
    }

    static func inkSoft(_ dark: Bool) -> Color {
        dark ? Color(white: 0.62) : Color(white: 0.38)
    }
}

/// The keyboard's measurements, in one place so the view and the height
/// constraint in `KeyboardViewController` can never disagree about how tall a
/// pane is — a disagreement shows up as a seam against the system's own
/// background, which is exactly the bug this table exists to prevent.
///
/// The key geometry is the system portrait keyboard's: 42pt caps, 11pt between
/// rows, 6pt between keys, a 3pt margin at the screen edge. Everything else is
/// derived so a change to one number moves the whole pane together.
enum KBMetrics {
    /// The Parley wordmark + mode picker above the keys.
    static let strip: CGFloat = 38

    static let keyHeight: CGFloat = 42
    static let rowSpacing: CGFloat = 11
    static let keyGap: CGFloat = 6
    static let sideInset: CGFloat = 3
    static let paneTop: CGFloat = 8
    static let paneBottom: CGFloat = 4

    /// Four rows of caps: 8 + 4×42 + 3×11 + 4 = 213pt, within a few points of
    /// the ~216pt key area of the system portrait keyboard.
    static var lettersPane: CGFloat {
        paneTop + keyHeight * 4 + rowSpacing * 3 + paneBottom
    }

    static var lettersHeight: CGFloat { strip + lettersPane }

    // The voice pane. A control panel rather than a keyboard — nothing on it
    // types a letter — so it is measured in round buttons and whitespace
    // instead of caps and rows, and it is deliberately not full.
    //
    // The parts are chosen so the pane comes out at exactly `lettersPane`.
    // That equality is the point: the two panes are one swipe apart, and a
    // keyboard that changes height mid-swipe shoves the host app's content up
    // and down every time the user crosses between them.
    static let voiceTop: CGFloat = 16
    static let voiceSide: CGFloat = 24
    static let voiceBottom: CGFloat = 11

    /// The live-transcript slot. Fixed height, so beginning to speak never
    /// resizes the keyboard: idle it holds the prompt, listening it holds up to
    /// three lines of what is being heard.
    static let textHeight: CGFloat = 74
    static let textToDeck: CGFloat = 12

    /// The round control buttons: delete, return, `@`, and the globe on the
    /// devices where the system doesn't already draw one.
    static let roundKey: CGFloat = 44
    static let deckRowGap: CGFloat = 12
    /// The record button — the one thing on this pane carrying a colour.
    static let recordSize: CGFloat = 80

    static var deckHeight: CGFloat { roundKey * 2 + deckRowGap }

    /// 16 + 74 + 12 + 100 + 11 = 213pt, which is `lettersPane` exactly.
    static var voicePane: CGFloat {
        voiceTop + textHeight + textToDeck + deckHeight + voiceBottom
    }

    static var voiceHeight: CGFloat { strip + voicePane }

    /// How far a finger has to travel sideways before it counts as a mode
    /// swipe rather than a mistyped key.
    static let swipeThreshold: CGFloat = 56
}
