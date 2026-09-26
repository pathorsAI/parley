import SwiftUI

/// The English typing pane: a real QWERTY plane over the two symbol planes iOS
/// trained everyone to expect (`SymbolPlanes`, shared with the 注音 pane).
///
/// It exists because a dictation keyboard that can only dictate is a keyboard
/// you have to leave for every correction, and because App Review 4.4.1 wants a
/// keyboard that still works with Full Access switched off — dictation needs
/// the network and the App Group, but typing needs neither, so this pane is
/// fully functional in that state.
///
/// The layout is arithmetic, not a fixed table: one letter key is the unit
/// (`KeyRowMetrics`), and every wide key is expressed in units so the rows still
/// line up on a 320pt SE and a 440pt Pro Max alike.
///
/// Like `ZhuyinPane`, it does not observe the bridge — see there for why — and
/// is `Equatable` on the values it draws. Its own shift and plane state still
/// redraw it; nothing published elsewhere does.
struct LetterPane: View, Equatable {
    /// Actions only. Not observed; see `ZhuyinPane`.
    let bridge: KeyboardBridge
    var dark: Bool
    var showsGlobe: Bool
    var returnKey: ReturnKeyStyle

    @State private var symbols = false
    @State private var shift: ShiftState = .off
    @State private var lastShiftTap = Date.distantPast

    /// Shift is three-state, like the system's: off, armed for exactly one
    /// letter, or locked until it is tapped off again.
    enum ShiftState {
        case off
        case oneShot
        case locked

        var isOn: Bool { self != .off }
    }

    /// What the pane draws. Shift and the plane are `@State`, which SwiftUI
    /// tracks on its own; the bridge and the key actions need no comparing.
    static func == (a: Self, b: Self) -> Bool {
        a.dark == b.dark && a.showsGlobe == b.showsGlobe && a.returnKey == b.returnKey
    }

    var body: some View {
        if symbols {
            SymbolPlanes(
                bridge: bridge, dark: dark, showsGlobe: showsGlobe, returnKey: returnKey,
                homeLabel: "ABC", onHome: { symbols = false }
            )
            .equatable()
        } else {
            letterPlane
        }
    }

    private var letterPlane: some View {
        GeometryReader { geo in
            let m = KeyRowMetrics(width: geo.size.width)
            VStack(spacing: KBMetrics.rowSpacing) {
                row { ForEach(Array("qwertyuiop"), id: \.self) { letterKey($0, width: m.unit) } }
                row { ForEach(Array("asdfghjkl"), id: \.self) { letterKey($0, width: m.unit) } }
                    // The half-key iOS insets the home row by.
                    .padding(.horizontal, m.halfKey)
                row {
                    shiftKey(width: m.wide)
                    ForEach(Array("zxcvbnm"), id: \.self) { letterKey($0, width: m.unit) }
                    DeleteKey(dark: dark, width: m.wide) { bridge.backspace() }
                        .equatable()
                }
                bottomRow(m)
            }
            .padding(.horizontal, KBMetrics.sideInset)
            .padding(.top, KBMetrics.paneTop)
            .padding(.bottom, KBMetrics.paneBottom)
        }
    }

    /// `123`, the globe when the system asks for one, `@`, the space bar, and
    /// return. Space takes whatever the fixed keys leave, which lands it at
    /// roughly the five-key width iOS gives it — and a little wider on the
    /// devices that draw their own globe below the keyboard.
    private func bottomRow(_ m: KeyRowMetrics) -> some View {
        row {
            KeyButton(dark: dark, tint: .alt, width: m.wide, action: openSymbols) {
                Text(verbatim: "123").font(.system(size: 16, weight: .regular))
            }
            .equatable()
            .accessibilityLabel(Text(verbatim: "123"))
            if showsGlobe {
                GlobeKey(controller: bridge.controller, dark: dark)
                    .frame(width: m.unit, height: KBMetrics.keyHeight)
            }
            KeyButton(dark: dark, width: m.unit, action: { bridge.type("@") }) {
                Text(verbatim: "@").font(.system(size: 22))
            }
            .equatable()
            .accessibilityLabel(Text("At sign"))
            KeyButton(dark: dark, width: nil, action: tapSpace) {
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

    // MARK: keys

    /// A letter, shown and inserted in whatever case shift currently says.
    private func letterKey(_ character: Character, width: CGFloat) -> some View {
        let text = shift.isOn ? character.uppercased() : String(character)
        return KeyButton(dark: dark, width: width, action: { type(text) }) {
            Text(verbatim: text).font(.system(size: 24))
        }
        .equatable()
        .accessibilityLabel(Text(verbatim: text))
    }

    private func shiftKey(width: CGFloat) -> some View {
        KeyButton(
            // An engaged shift borrows the light letter cap, which is how iOS
            // shows that it is armed without adding a second colour.
            dark: dark, tint: shift.isOn ? .letter : .alt, width: width, action: tapShift
        ) {
            Image(systemName: shiftGlyph).font(.system(size: 19, weight: .regular))
        }
        .accessibilityLabel(shift == .locked ? Text("Caps lock") : Text("Shift"))
    }

    private var shiftGlyph: String {
        switch shift {
        case .off: return "shift"
        case .oneShot: return "shift.fill"
        case .locked: return "capslock.fill"
        }
    }

    // MARK: behaviour

    private func type(_ text: String) {
        bridge.type(text)
        if shift == .oneShot { shift = .off }
    }

    private func tapSpace() {
        bridge.space()
        if shift == .oneShot { shift = .off }
    }

    /// Leaving the letters behind drops a one-shot shift on the floor, the way
    /// it does on the system keyboard.
    private func openSymbols() {
        symbols = true
        if shift == .oneShot { shift = .off }
    }

    /// Two taps in quick succession lock shift; anything slower toggles it.
    private func tapShift() {
        let now = Date()
        if now.timeIntervalSince(lastShiftTap) < 0.3 {
            shift = .locked
        } else {
            shift = shift.isOn ? .off : .oneShot
        }
        lastShiftTap = now
    }
}
