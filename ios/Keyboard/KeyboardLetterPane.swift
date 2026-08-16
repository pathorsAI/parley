import SwiftUI

/// The typing half of the keyboard: a real QWERTY plane plus the two symbol
/// planes iOS trained everyone to expect.
///
/// It exists because a dictation keyboard that can only dictate is a keyboard
/// you have to leave for every correction, and because App Review 4.4.1 wants a
/// keyboard that still works with Full Access switched off — dictation needs
/// the network and the App Group, but typing needs neither, so this pane is
/// fully functional in that state.
///
/// The layout is arithmetic, not a fixed table: one letter key is the unit, and
/// every wide key is expressed in units so the rows still line up on a 320pt
/// SE and a 440pt Pro Max alike.
struct LetterPane: View {
    @ObservedObject var bridge: KeyboardBridge
    var dark: Bool

    @State private var plane: KeyPlane = .letters
    @State private var shift: ShiftState = .off
    @State private var lastShiftTap = Date.distantPast

    enum KeyPlane {
        case letters
        case numbers
        case symbols
    }

    /// Shift is three-state, like the system's: off, armed for exactly one
    /// letter, or locked until it is tapped off again.
    enum ShiftState {
        case off
        case oneShot
        case locked

        var isOn: Bool { self != .off }
    }

    var body: some View {
        GeometryReader { geo in
            let m = RowMetrics(width: geo.size.width)
            VStack(spacing: KBMetrics.rowSpacing) {
                switch plane {
                case .letters: letterRows(m)
                case .numbers: numberRows(m)
                case .symbols: symbolRows(m)
                }
            }
            .padding(.horizontal, KBMetrics.sideInset)
            .padding(.top, KBMetrics.paneTop)
            .padding(.bottom, KBMetrics.paneBottom)
        }
    }

    /// Every width on a row, derived from the ten keys of the top row.
    private struct RowMetrics {
        /// One letter key.
        let unit: CGFloat
        /// Shift, delete, `123`, `ABC`, return — one and a half letter keys,
        /// which is what falls out of asking three letters and a gap to cover
        /// two of them.
        let wide: CGFloat

        init(width: CGFloat) {
            let content = max(width - KBMetrics.sideInset * 2, 1)
            unit = (content - KBMetrics.keyGap * 9) / 10
            wide = (3 * unit + KBMetrics.keyGap) / 2
        }

        /// The half-key iOS insets the home row by.
        var halfKey: CGFloat { (unit + KBMetrics.keyGap) / 2 }
    }

    // MARK: planes

    @ViewBuilder
    private func letterRows(_ m: RowMetrics) -> some View {
        row { ForEach(Array("qwertyuiop"), id: \.self) { letterKey($0, width: m.unit) } }
        row { ForEach(Array("asdfghjkl"), id: \.self) { letterKey($0, width: m.unit) } }
            .padding(.horizontal, m.halfKey)
        row {
            shiftKey(width: m.wide)
            ForEach(Array("zxcvbnm"), id: \.self) { letterKey($0, width: m.unit) }
            deleteKey(width: m.wide)
        }
        bottomRow(m, planeLabel: "123", planeTarget: .numbers, showsAtKey: true)
    }

    @ViewBuilder
    private func numberRows(_ m: RowMetrics) -> some View {
        row { ForEach(Array("1234567890"), id: \.self) { textKey($0, width: m.unit) } }
        row { ForEach(Array("-/:;()$&@\""), id: \.self) { textKey($0, width: m.unit) } }
        punctuationRow(m, toggleLabel: "#+=", toggleTarget: .symbols)
        bottomRow(m, planeLabel: "ABC", planeTarget: .letters, showsAtKey: false)
    }

    @ViewBuilder
    private func symbolRows(_ m: RowMetrics) -> some View {
        row { ForEach(Array("[]{}#%^*+="), id: \.self) { textKey($0, width: m.unit) } }
        row { ForEach(Array("_\\|~<>$£¥•"), id: \.self) { textKey($0, width: m.unit) } }
        punctuationRow(m, toggleLabel: "123", toggleTarget: .numbers)
        bottomRow(m, planeLabel: "ABC", planeTarget: .letters, showsAtKey: false)
    }

    /// The row both symbol planes share: the plane toggle, five punctuation
    /// keys that spread to fill whatever is left, and delete.
    private func punctuationRow(
        _ m: RowMetrics, toggleLabel: String, toggleTarget: KeyPlane
    ) -> some View {
        row {
            planeKey(toggleLabel, to: toggleTarget, width: m.wide)
            ForEach(Array(".,?!'"), id: \.self) { character in
                textKey(character, width: nil)
            }
            deleteKey(width: m.wide)
        }
    }

    /// `123`/`ABC`, the globe, an optional `@`, the space bar, and return.
    /// Space takes whatever the fixed keys leave, which lands it at roughly the
    /// five-key width iOS gives it.
    private func bottomRow(
        _ m: RowMetrics, planeLabel: String, planeTarget: KeyPlane, showsAtKey: Bool
    ) -> some View {
        row {
            planeKey(planeLabel, to: planeTarget, width: m.wide)
            GlobeKey(controller: bridge.controller, dark: dark)
                .frame(width: m.unit, height: KBMetrics.keyHeight)
            if showsAtKey {
                textKey("@", width: m.unit)
            }
            spaceKey
            returnKey(width: m.wide)
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
        return cap(tint: .letter, width: width, label: Text(verbatim: text).font(.system(size: 24)))
        {
            bridge.type(text)
            if shift == .oneShot { shift = .off }
        }
        .accessibilityLabel(Text(verbatim: text))
    }

    /// A key that types itself as-is — digits and symbols, which shift doesn't
    /// touch. A `nil` width means "share the row's slack with your neighbours".
    private func textKey(_ character: Character, width: CGFloat?) -> some View {
        let text = String(character)
        return cap(tint: .letter, width: width, label: Text(verbatim: text).font(.system(size: 22)))
        {
            bridge.type(text)
        }
        .accessibilityLabel(Text(verbatim: text))
    }

    private func planeKey(_ label: String, to target: KeyPlane, width: CGFloat) -> some View {
        cap(
            tint: .alt, width: width,
            label: Text(verbatim: label).font(.system(size: 16, weight: .regular))
        ) {
            plane = target
            // Leaving the letters behind drops a one-shot shift on the floor,
            // the way it does on the system keyboard.
            if target != .letters, shift == .oneShot { shift = .off }
        }
        .accessibilityLabel(Text(verbatim: label))
    }

    private func shiftKey(width: CGFloat) -> some View {
        cap(
            // An engaged shift borrows the light letter cap, which is how iOS
            // shows that it is armed without adding a second colour.
            tint: shift.isOn ? .letter : .alt, width: width,
            label: Image(systemName: shiftGlyph).font(.system(size: 19, weight: .regular))
        ) {
            tapShift()
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

    private func deleteKey(width: CGFloat) -> some View {
        RepeatingKey(action: { bridge.backspace() }) { pressed in
            ZStack {
                KeyCap(dark: dark, tint: .alt, pressed: pressed)
                Image(systemName: "delete.left")
                    .font(.system(size: 19, weight: .regular))
                    .foregroundStyle(KBTheme.ink(dark))
            }
            .frame(width: width, height: KBMetrics.keyHeight)
        }
        .accessibilityLabel(Text("Delete"))
    }

    private var spaceKey: some View {
        cap(tint: .letter, width: nil, label: Text("Space").font(.system(size: 15))) {
            bridge.space()
            if shift == .oneShot { shift = .off }
        }
        .accessibilityLabel(Text("Space"))
    }

    /// Return always inserts a newline. The host's `returnKeyType` only changes
    /// what the key *says* and whether it is tinted: a keyboard extension has no
    /// way to submit a form, and a key labelled Send that silently did nothing
    /// would be worse than one that visibly types a line break.
    private func returnKey(width: CGFloat) -> some View {
        let accented = bridge.returnKeyIsAccented
        return cap(
            tint: accented ? .accent : .alt, width: width,
            label: Text(bridge.returnKeyLabel).font(.system(size: 15)),
            ink: accented ? .white : KBTheme.ink(dark)
        ) {
            bridge.newline()
            if shift == .oneShot { shift = .off }
        }
        .accessibilityLabel(Text(bridge.returnKeyLabel))
    }

    /// One cap, one label, one action. `width == nil` lets the key stretch to
    /// share whatever the row has left over.
    private func cap<Label: View>(
        tint: KeyTint,
        width: CGFloat?,
        label: Label,
        ink: Color? = nil,
        action: @escaping () -> Void
    ) -> some View {
        PressableButton(action: action) { pressed in
            ZStack {
                KeyCap(dark: dark, tint: tint, pressed: pressed)
                label.foregroundStyle(ink ?? KBTheme.ink(dark))
            }
            .frame(width: width, height: KBMetrics.keyHeight)
            .frame(maxWidth: width == nil ? .infinity : nil)
        }
    }
}
