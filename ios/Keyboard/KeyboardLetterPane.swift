import ParleyKit
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
/// is `Equatable` on the values it draws. Its plane state redraws it, and so
/// does shift, which it observes on its own small object (`ShiftModel`) rather
/// than through the bridge: a shift change redraws this pane and nothing else,
/// and nothing else published on the bridge redraws it.
struct LetterPane: View, Equatable {
    /// Actions only. Not observed; see `ZhuyinPane`.
    let bridge: KeyboardBridge
    var dark: Bool
    var showsGlobe: Bool
    var returnKey: ReturnKeyStyle

    @State private var symbols = false
    /// Shift lives with the controller, not here, because the controller is
    /// what knows when it should arm by itself: the start of the field, after
    /// `. `, after a line break — see `AutoCapitalization`.
    @ObservedObject private var shift: ShiftModel
    /// Whether the space bar is steering the caret, observed on its own for
    /// the reason shift is — see `SpaceCursorModel`.
    @ObservedObject private var cursor: SpaceCursorModel

    init(bridge: KeyboardBridge, dark: Bool, showsGlobe: Bool, returnKey: ReturnKeyStyle) {
        self.bridge = bridge
        self.dark = dark
        self.showsGlobe = showsGlobe
        self.returnKey = returnKey
        self.shift = bridge.shift
        self.cursor = bridge.spaceCursor
    }

    /// What the pane draws. Shift and the plane are observed on their own;
    /// the bridge and the key actions need no comparing.
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

    /// Four rows of caps, and every key's touch target reaching out to meet its
    /// neighbours' and the pane's edges — see `RowReach`.
    ///
    /// Shift is read here, outside the `GeometryReader`, and handed to the keys
    /// as a value. Read inside the reader's closure it went stale: the pane's
    /// body re-ran on every shift change, but the reader did not always re-run
    /// its closure for an observed object's change, and the letters kept the
    /// case they had. On the simulator the letter after a line break came out
    /// lower case, and a words-capitalised field typed `HI YO` for `hi yo`. A
    /// captured value is part of what the reader compares.
    ///
    /// The space bar's trackpad is read out here for the same reason, and
    /// reaches the keys through the environment (`keysRecede`).
    private var letterPlane: some View {
        let shiftState = shift.state
        let receding = cursor.steering
        return GeometryReader { geo in
            let m = KeyRowMetrics(width: geo.size.width)
            VStack(spacing: KBMetrics.rowSpacing) {
                letterRow(Array("qwertyuiop"), m, shift: shiftState, reach: Self.reach(0))
                // The half-key iOS insets the home row by. It belongs to `a`
                // and `l`: a finger in that strip means the key beside it.
                letterRow(
                    Array("asdfghjkl"), m, shift: shiftState,
                    reach: Self.reach(
                        1, leading: KBMetrics.sideInset + m.halfKey,
                        trailing: KBMetrics.sideInset + m.halfKey)
                )
                .padding(.horizontal, m.halfKey)
                row {
                    let reach = Self.reach(2)
                    shiftKey(shiftState, width: m.wide, reach: reach.key(first: true))
                    ForEach(Array("zxcvbnm"), id: \.self) {
                        letterKey($0, shift: shiftState, width: m.unit, reach: reach.key())
                    }
                    DeleteKey(
                        dark: dark, width: m.wide, reach: reach.key(last: true),
                        action: bridge.backspace, repeatAction: bridge.backspaceRepeat,
                        onRelease: bridge.backspaceReleased
                    )
                    .equatable()
                }
                bottomRow(m)
            }
            .padding(.horizontal, KBMetrics.sideInset)
            .padding(.top, KBMetrics.paneTop)
            .padding(.bottom, KBMetrics.paneBottom)
        }
        .environment(\.keysRecede, receding)
        // The keys' targets stop at the pane's edge (see `RowReach`). The
        // panes sit side by side on one track, and an end key reaching past
        // its own pane would take touches meant for the pane beside it.
        .contentShape(Rectangle())
    }

    private static func reach(
        _ row: Int, leading: CGFloat = KBMetrics.sideInset,
        trailing: CGFloat = KBMetrics.sideInset
    ) -> RowReach {
        RowReach(
            row: row, of: 4, spacing: KBMetrics.rowSpacing, leading: leading, trailing: trailing)
    }

    private func letterRow(
        _ letters: [Character], _ m: KeyRowMetrics, shift: ShiftLatch.State, reach: RowReach
    ) -> some View {
        row {
            ForEach(Array(letters.enumerated()), id: \.offset) { i, c in
                letterKey(c, shift: shift, width: m.unit, reach: reach.key(i, of: letters.count))
            }
        }
    }

    /// `123`, the globe when the system asks for one, `@`, the space bar, and
    /// return. Space takes whatever the fixed keys leave, which lands it at
    /// roughly the five-key width iOS gives it — and a little wider on the
    /// devices that draw their own globe below the keyboard.
    private func bottomRow(_ m: KeyRowMetrics) -> some View {
        let reach = Self.reach(3)
        return row {
            KeyButton(
                dark: dark, tint: .alt, width: m.wide, reach: reach.key(first: true),
                action: openSymbols
            ) {
                Text(verbatim: "123").font(.system(size: 16, weight: .regular))
            }
            .equatable()
            .accessibilityLabel(Text(verbatim: "123"))
            if showsGlobe {
                GlobeKey(controller: bridge.controller, dark: dark, reach: reach.key())
                    .frame(width: m.unit, height: KBMetrics.keyHeight)
            }
            KeyButton(
                dark: dark, width: m.unit, reach: reach.key(), callout: "@",
                action: { bridge.type("@") }
            ) {
                Text(verbatim: "@").font(.system(size: 22))
            }
            .equatable()
            .accessibilityLabel(Text("At sign"))
            // Held still, the space bar becomes a trackpad; see `SpaceKey`.
            SpaceKey(bridge: bridge, dark: dark, reach: reach.key())
                .equatable()
            ReturnKey(
                bridge: bridge, style: returnKey, dark: dark, width: m.wide,
                reach: reach.key(last: true)
            )
            .equatable()
        }
    }

    private func row<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: KBMetrics.keyGap, content: content)
            .frame(height: KBMetrics.keyHeight)
    }

    // MARK: keys

    /// A letter, shown and inserted in whatever case shift currently says.
    /// Typing it is what spends a one-shot shift: the controller re-decides
    /// shift after every edit.
    private func letterKey(
        _ character: Character, shift: ShiftLatch.State, width: CGFloat, reach: EdgeInsets
    ) -> some View {
        let text = shift.isOn ? character.uppercased() : String(character)
        return KeyButton(
            dark: dark, width: width, reach: reach, callout: text, action: { bridge.type(text) }
        ) {
            Text(verbatim: text).font(.system(size: 24))
        }
        .equatable()
        .accessibilityLabel(Text(verbatim: text))
    }

    /// Shift acts on touch-down, as the system's does, so a shift and the
    /// letter after it can overlap in time the way thumbs actually type them.
    /// The release does nothing.
    private func shiftKey(_ shift: ShiftLatch.State, width: CGFloat, reach: EdgeInsets)
        -> some View
    {
        KeyButton(
            // An engaged shift borrows the light letter cap, which is how iOS
            // shows that it is armed without adding a second colour.
            dark: dark, tint: shift.isOn ? .letter : .alt, width: width, reach: reach,
            action: {}, onPressDown: { bridge.tapShift() }
        ) {
            Image(systemName: Self.glyph(shift)).font(.system(size: 19, weight: .regular))
        }
        .accessibilityLabel(shift == .locked ? Text("Caps lock") : Text("Shift"))
    }

    private static func glyph(_ shift: ShiftLatch.State) -> String {
        switch shift {
        case .off: return "shift"
        case .oneShot: return "shift.fill"
        case .locked: return "capslock.fill"
        }
    }

    // MARK: behaviour

    /// Leaving the letters behind drops a one-shot shift on the floor, the way
    /// it does on the system keyboard.
    private func openSymbols() {
        symbols = true
        bridge.shift.update { $0.dropOneShot() }
    }
}

/// The letter pane's shift, published on its own.
///
/// Not a `@Published` field on `KeyboardBridge`: everything that observes the
/// bridge redraws on every keystroke, and the letter pane exists not to. This
/// object publishes only a change of state, and only the letter pane observes
/// it. The controller drives it — `settle` after every edit and caret move,
/// from `AutoCapitalization` — and the shift key taps it.
final class ShiftModel: ObservableObject {
    @Published private(set) var state: ShiftLatch.State = .off
    private var latch = ShiftLatch()

    /// Change the latch; publish only if what the keys show changed.
    func update(_ change: (inout ShiftLatch) -> Void) {
        change(&latch)
        if state != latch.state { state = latch.state }
    }
}
