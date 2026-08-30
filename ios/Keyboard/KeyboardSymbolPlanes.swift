import SwiftUI

/// The two symbol planes iOS trained everyone to expect: `1234567890` /
/// `-/:;()$&@"` and `[]{}#%^*+=` / `_\|~<>$£¥•`, over a punctuation row and a
/// bottom row they share.
///
/// A view of its own rather than rows inside `LetterPane` because both typing
/// panes reach the same two planes through the same `123` key. They also fit
/// either side without changing the keyboard's height: four 42pt rows is exactly
/// what QWERTY measures, so tapping `123` from the shorter 注音 rows still lands
/// on the same 213pt content area.
struct SymbolPlanes: View {
    @ObservedObject var bridge: KeyboardBridge
    var dark: Bool
    /// What the key that goes back says — `ABC` from QWERTY, `注音` from the
    /// 注音 pane.
    var homeLabel: String
    var onHome: () -> Void

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
                    row { ForEach(Array("1234567890"), id: \.self) { key($0, width: m.unit) } }
                    row { ForEach(Array("-/:;()$&@\""), id: \.self) { key($0, width: m.unit) } }
                    punctuationRow(m, toggleLabel: "#+=", toggleTarget: .symbols)
                case .symbols:
                    row { ForEach(Array("[]{}#%^*+="), id: \.self) { key($0, width: m.unit) } }
                    row { ForEach(Array("_\\|~<>$£¥•"), id: \.self) { key($0, width: m.unit) } }
                    punctuationRow(m, toggleLabel: "123", toggleTarget: .numbers)
                }
                bottomRow(m)
            }
            .padding(.horizontal, KBMetrics.sideInset)
            .padding(.top, KBMetrics.paneTop)
            .padding(.bottom, KBMetrics.paneBottom)
        }
    }

    /// The row both planes share: the plane toggle, five punctuation keys that
    /// spread to fill whatever is left, and delete.
    private func punctuationRow(
        _ m: KeyRowMetrics, toggleLabel: String, toggleTarget: Plane
    ) -> some View {
        row {
            altKey(toggleLabel, width: m.wide) { plane = toggleTarget }
            ForEach(Array(".,?!'"), id: \.self) { character in
                key(character, width: nil)
            }
            DeleteKey(dark: dark, width: m.wide) { bridge.backspace() }
        }
    }

    /// The mode key keeps the corner it has on every pane, so `123` does not
    /// become the one plane you have to leave before you can change keyboard.
    private func bottomRow(_ m: KeyRowMetrics) -> some View {
        row {
            ModeKey(bridge: bridge, dark: dark, width: m.mode)
            altKey(homeLabel, width: m.wide, action: onHome)
            if bridge.showsGlobe {
                GlobeKey(controller: bridge.controller, dark: dark)
                    .frame(width: m.unit, height: KBMetrics.keyHeight)
            }
            KeyButton(dark: dark, shape: .pill, width: nil, action: { bridge.space() }) {
                Text("Space").font(.system(size: 15))
            }
            .accessibilityLabel(Text("Space"))
            ReturnKey(bridge: bridge, dark: dark, width: m.wide)
        }
    }

    private func row<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: KBMetrics.keyGap, content: content)
            .frame(height: KBMetrics.keyHeight)
    }

    /// A key that types itself as-is. A `nil` width means "share the row's slack
    /// with your neighbours".
    private func key(_ character: Character, width: CGFloat?) -> some View {
        let text = String(character)
        return KeyButton(dark: dark, width: width, action: { bridge.type(text) }) {
            Text(verbatim: text).font(.system(size: 22))
        }
        .accessibilityLabel(Text(verbatim: text))
    }

    private func altKey(
        _ label: String, width: CGFloat, action: @escaping () -> Void
    ) -> some View {
        KeyButton(dark: dark, tint: .alt, shape: .pill, width: width, action: action) {
            Text(verbatim: label).font(.system(size: 16, weight: .regular))
        }
        .accessibilityLabel(Text(verbatim: label))
    }
}

/// Return, wherever a pane has a wide key for it.
///
/// It always inserts a newline. The host's `returnKeyType` only changes what the
/// key *says* and whether it is tinted: a keyboard extension has no way to
/// submit a form, and a key labelled Send that silently did nothing would be
/// worse than one that visibly types a line break.
struct ReturnKey: View {
    @ObservedObject var bridge: KeyboardBridge
    var dark: Bool
    var width: CGFloat
    var height: CGFloat = KBMetrics.keyHeight

    var body: some View {
        let accented = bridge.returnKeyIsAccented
        return KeyButton(
            dark: dark, tint: accented ? .accent : .alt, shape: .pill, width: width,
            height: height,
            ink: accented ? .white : KBTheme.ink(dark),
            action: { bridge.newline() }
        ) {
            Text(bridge.returnKeyLabel).font(.system(size: 15))
        }
        .accessibilityLabel(Text(bridge.returnKeyLabel))
    }
}
