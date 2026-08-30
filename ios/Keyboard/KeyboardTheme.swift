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

    /// The colour under a key cap, ported from `@pathors/ui`'s `--shadow-sm`.
    ///
    /// A neutral blue-black rather than the brand blue on purpose: a shadow is
    /// the absence of light, and tinting it with the accent is the fastest way
    /// to make a keyboard look like a mock-up. The cap stacks two of these —
    /// `capShadowNear` hugging the edge and `capShadowFar` under it — because
    /// SwiftUI has no shadow *spread*, so the CSS token's tight-plus-soft pair
    /// is approximated by two blurs rather than one.
    private static let capShadowInk = Color(red: 0.078, green: 0.118, blue: 0.176)

    /// Both appearances carry it. Dark mode used to draw no shadow at all,
    /// which left every cap floating flat against the input view.
    static func capShadowNear(_ dark: Bool) -> Color {
        dark ? Color.black.opacity(0.50) : capShadowInk.opacity(0.10)
    }

    static func capShadowFar(_ dark: Bool) -> Color {
        dark ? Color.black.opacity(0.50) : capShadowInk.opacity(0.06)
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

    /// A character cap's corners. The function keys around them are pills
    /// instead (`KeyShape`), which is what separates the two families at a
    /// glance now that both carry the same soft shadow.
    static let keyRadius: CGFloat = 7

    /// The narrowest the mode key is allowed to get. A row's `wide` unit falls
    /// below the 44pt minimum target on a 320pt SE, so the mode key takes the
    /// difference out of the space bar rather than out of the finger.
    static let modeKeyWidth: CGFloat = 44

    // How a key answers a finger. The cap shrinks a hair going down and springs
    // back coming up, on top of the fill swap that was already there.
    //
    // 80ms and 0.97 deliberately differ from the `@pathors/ui` web token
    // (`active:scale-[0.98]`, 150ms): a key is pressed a few times a second,
    // and at typing speed a 150ms settle reads as lag rather than as feedback.
    // The tighter scale is what keeps the shorter animation legible.
    static let pressScale: CGFloat = 0.97
    static let pressDuration: Double = 0.08
    static let pressDown = Animation.easeOut(duration: KBMetrics.pressDuration)
    /// Coming back up is a spring rather than the ease: the release is the beat
    /// the finger is no longer on the key for, so it can afford the overshoot.
    static let pressUp = Animation.spring(response: 0.2, dampingFraction: 0.75)

    /// Four rows of caps: 8 + 4×42 + 3×11 + 4 = 213pt, within a few points of
    /// the ~216pt key area of the system portrait keyboard.
    static var lettersPane: CGFloat {
        paneTop + keyHeight * 4 + rowSpacing * 3 + paneBottom
    }

    // The 注音 pane. Four rows of 大千 keys plus a function row — five rows
    // where QWERTY has four — and it still has to come out at `lettersPane`,
    // for the same reason the voice pane does.
    //
    // So the row spacing tightens and the key height is *derived* rather than
    // chosen. The result (≈34.6pt) is close to what iOS's own 注音 keyboard
    // draws, which is not a coincidence: it is the same five rows in the same
    // space. The two symbol planes the pane shares with QWERTY keep the 42pt
    // caps and four rows, so switching to `123` from either side lands on the
    // same 213pt.
    static let zhuyinRows = 5
    static let zhuyinRowSpacing: CGFloat = 7

    /// (213 − 8 − 4 − 4×7) ÷ 5 ≈ 34.6pt.
    static var zhuyinKeyHeight: CGFloat {
        (lettersPane - paneTop - paneBottom - zhuyinRowSpacing * CGFloat(zhuyinRows - 1))
            / CGFloat(zhuyinRows)
    }

    /// Equal to `lettersPane` by construction — `zhuyinKeyHeight` is what it is
    /// in order to make this true. Spelled out rather than aliased so the
    /// arithmetic is checkable where it is used.
    static var zhuyinPane: CGFloat {
        paneTop + zhuyinKeyHeight * CGFloat(zhuyinRows)
            + zhuyinRowSpacing * CGFloat(zhuyinRows - 1) + paneBottom
    }

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

    /// Every pane's content area, and every pane's total height with the strip.
    ///
    /// The three numbers are equal, which is the whole point: the panes sit side
    /// by side on one track, and a keyboard that changes height mid-swipe shoves
    /// the host app's content up and down every time the user crosses between
    /// them. Change one pane's parts and the others have to follow.
    static func pane(_ pane: KeyboardPane) -> CGFloat {
        switch pane {
        case .voice: return voicePane
        case .english: return lettersPane
        case .zhuyin: return zhuyinPane
        }
    }

    static func height(_ pane: KeyboardPane) -> CGFloat { strip + self.pane(pane) }

    /// How far a finger has to travel sideways before it counts as a pane
    /// swipe rather than a mistyped key.
    static let swipeThreshold: CGFloat = 56
}
