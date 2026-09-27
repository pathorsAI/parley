import ParleyKit
import SwiftUI
import UIKit

/// The two symbol planes iOS trained everyone to expect: `1234567890` /
/// `-/:;()$&@"` and `[]{}#%^*+=` / `_\|~<>$£¥•`, over a punctuation row and a
/// bottom row they share.
///
/// A view of its own rather than rows inside `LetterPane` because both typing
/// panes reach the two planes through the same `123` key. From the 注音 pane
/// (`fullWidth`) the punctuation on them is Chinese — `。，、？！`, `「」`, `…`,
/// `～` — laid out after the system 注音 keyboard's planes; the digits and the
/// marks with no full-width convention are the same keys either way. The rows
/// live in `FullWidthPunctuation` (ParleyKit), where they are tested. They also fit
/// either side without changing the keyboard's height: four 42pt rows is exactly
/// what QWERTY measures, so tapping `123` from the shorter 注音 rows still lands
/// on the same 213pt content area.
///
/// Like the panes that host it, it does not observe the bridge — see
/// `ZhuyinPane` — and is `Equatable` on what it draws.
struct SymbolPlanes: View, Equatable {
    /// Actions only. Not observed; see `ZhuyinPane`.
    let bridge: KeyboardBridge
    var dark: Bool
    var showsGlobe: Bool
    var returnKey: ReturnKeyStyle
    /// What the key that goes back says — `ABC` from QWERTY, `注音` from the
    /// 注音 pane.
    var homeLabel: String
    /// Chinese punctuation rather than ASCII — true from the 注音 pane. A plain
    /// value rather than something read off the bridge, so the planes stay a
    /// function of what they are handed.
    var fullWidth = false
    var onHome: () -> Void

    /// What the planes draw. The bridge is the same object for the process's
    /// life and `onHome` only flips the host pane's own `@State`, so neither can
    /// make two planes look different.
    static func == (a: Self, b: Self) -> Bool {
        a.dark == b.dark && a.showsGlobe == b.showsGlobe && a.returnKey == b.returnKey
            && a.homeLabel == b.homeLabel && a.fullWidth == b.fullWidth
    }

    /// Which of the two planes. Owned here, so leaving and coming back always
    /// lands on the numbers plane — which is what the system keyboard does.
    @State private var plane: Plane = .numbers

    private enum Plane {
        case numbers
        case symbols
    }

    var body: some View {
        GeometryReader { geo in
            let m = KeyRowMetrics(width: geo.size.width)
            VStack(spacing: KBMetrics.rowSpacing) {
                switch plane {
                case .numbers:
                    fixedRow(Self.keys("1234567890"), m)
                    fixedRow(
                        fullWidth
                            ? FullWidthPunctuation.numbersMiddle : Self.keys("-/:;()$&@\""), m)
                    punctuationRow(
                        m, toggleLabel: "#+=", toggleTarget: .symbols,
                        keys: fullWidth
                            ? FullWidthPunctuation.numbersPunctuation : Self.keys(".,?!'"))
                case .symbols:
                    fixedRow(
                        fullWidth ? FullWidthPunctuation.symbolsTop : Self.keys("[]{}#%^*+="), m)
                    fixedRow(
                        fullWidth
                            ? FullWidthPunctuation.symbolsMiddle : Self.keys("_\\|~<>$£¥•"), m)
                    punctuationRow(
                        m, toggleLabel: "123", toggleTarget: .numbers,
                        keys: fullWidth
                            ? FullWidthPunctuation.symbolsPunctuation : Self.keys(".,?!'"))
                }
                bottomRow(m)
            }
            .padding(.horizontal, KBMetrics.sideInset)
            .padding(.top, KBMetrics.paneTop)
            .padding(.bottom, KBMetrics.paneBottom)
        }
    }

    private static func keys(_ row: String) -> [String] { row.map { String($0) } }

    /// Ten keys at the unit width. Indexed rather than keyed by the text,
    /// because a row may carry the same mark twice.
    private func fixedRow(_ keys: [String], _ m: KeyRowMetrics) -> some View {
        row {
            ForEach(Array(keys.enumerated()), id: \.offset) { key($0.element, width: m.unit) }
        }
    }

    /// The row both planes share: the plane toggle, the punctuation keys — five
    /// from QWERTY, six from 注音, as on the system keyboards — spread to fill
    /// whatever is left, and delete.
    private func punctuationRow(
        _ m: KeyRowMetrics, toggleLabel: String, toggleTarget: Plane, keys: [String]
    ) -> some View {
        row {
            altKey(toggleLabel, width: m.wide) { plane = toggleTarget }
            ForEach(Array(keys.enumerated()), id: \.offset) { key($0.element, width: nil) }
            DeleteKey(dark: dark, width: m.wide) { bridge.backspace() }
                .equatable()
        }
    }

    private func bottomRow(_ m: KeyRowMetrics) -> some View {
        row {
            altKey(homeLabel, width: m.wide, action: onHome)
            if showsGlobe {
                GlobeKey(controller: bridge.controller, dark: dark)
                    .frame(width: m.unit, height: KBMetrics.keyHeight)
            }
            KeyButton(dark: dark, width: nil, action: { bridge.space() }) {
                Text("Space").font(.system(size: 15))
            }
            .equatable()
            .accessibilityLabel(Text("Space"))
            ReturnKey(bridge: bridge, style: returnKey, dark: dark, width: m.wide)
                .equatable()
        }
    }

    private func row<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: KBMetrics.keyGap, content: content)
            .frame(height: KBMetrics.keyHeight)
    }

    /// A key that types itself as-is. A `nil` width means "share the row's slack
    /// with your neighbours".
    private func key(_ text: String, width: CGFloat?) -> some View {
        KeyButton(dark: dark, width: width, action: { bridge.type(text) }) {
            Text(verbatim: text).font(.system(size: 22))
        }
        .equatable()
        .accessibilityLabel(Text(verbatim: text))
    }

    private func altKey(
        _ label: String, width: CGFloat, action: @escaping () -> Void
    ) -> some View {
        KeyButton(dark: dark, tint: .alt, width: width, action: action) {
            Text(verbatim: label).font(.system(size: 16, weight: .regular))
        }
        .equatable()
        .accessibilityLabel(Text(verbatim: label))
    }
}

/// Return, wherever a pane has a wide key for it.
///
/// It always inserts a newline. The host's `returnKeyType` only changes what the
/// key *says* and whether it is tinted: a keyboard extension has no way to
/// submit a form, and a key labelled Send that silently did nothing would be
/// worse than one that visibly types a line break.
///
/// The style arrives as a value rather than being read off an observed bridge,
/// for the same reason the panes stopped observing it — see `ZhuyinPane`.
struct ReturnKey: View, Equatable {
    /// Actions only. Not observed.
    let bridge: KeyboardBridge
    var style: ReturnKeyStyle
    var dark: Bool
    var width: CGFloat
    var height: CGFloat = KBMetrics.keyHeight

    static func == (a: Self, b: Self) -> Bool {
        a.style == b.style && a.dark == b.dark && a.width == b.width && a.height == b.height
    }

    var body: some View {
        KeyButton(
            dark: dark, tint: style.isAccented ? .accent : .alt, width: width, height: height,
            ink: style.isAccented ? .white : KBTheme.ink(dark),
            action: { bridge.newline() }
        ) {
            Text(style.label).font(.system(size: 15))
        }
        .accessibilityLabel(Text(style.label))
    }
}

/// What the host field wants the return key to look like: its word, its glyph,
/// and whether it is tinted. Never what it does — see `KeyboardBridge.newline()`.
///
/// A value of its own so a pane can be handed "the return key" as one
/// `Equatable` thing instead of observing the whole bridge to read three
/// properties off it.
struct ReturnKeyStyle: Equatable {
    var type: UIReturnKeyType

    var label: LocalizedStringKey {
        switch type {
        case .go: return "Go"
        case .send: return "Send"
        case .search: return "Search"
        case .done: return "Done"
        case .next: return "Next"
        default: return "return"
        }
    }

    /// The same meaning as `label`, as a glyph.
    ///
    /// The voice pane's return is a 44pt disc with no room for "Search", and
    /// the pane keeps its only colour on the record button — so it says what
    /// the key does with a symbol instead of a word. The letter pane, which has
    /// a wide key and follows the system's look, still uses the label.
    var glyph: String {
        switch type {
        case .go: return "arrow.right"
        case .send: return "paperplane.fill"
        case .search: return "magnifyingglass"
        case .done: return "checkmark"
        case .next: return "arrow.right.to.line"
        default: return "return"
        }
    }

    /// iOS tints the return key when the host has asked for an action rather
    /// than a line break, so the key reads as the way forward.
    var isAccented: Bool {
        switch type {
        case .go, .send, .search, .done: return true
        default: return false
        }
    }
}
