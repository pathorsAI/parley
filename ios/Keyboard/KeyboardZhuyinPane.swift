import ParleyKit
import SwiftUI

/// The 注音 pane: 傳統注音 typing on the 大千 layout, one syllable at a time.
///
/// The keys are 大千 as it is actually defined — a mapping onto a QWERTY board —
/// so the top row is **eleven** wide (`1234567890-`) and the three below it are
/// ten. A tidy 4×10 grid would have to drop `ㄦ`, and 兒/二/而/耳 are not optional.
///
/// The two middle rows are **staggered rather than centred**: a third of a key
/// pitch in, then two thirds, which is the offset a physical keyboard has and
/// the one the system 注音 keyboard copies. Centring them (half a key each, the
/// way QWERTY's home row is inset) put the rows a sixth of a key off from where
/// a 注音 typist's thumb expects them.
///
/// The fourth row's eleventh column is **delete**, an ordinary single-width key
/// sitting directly under `ㄦ`, because that is where the system keyboard puts
/// it and muscle memory for ⌫ is the one thing a 注音 typist brings with them.
///
/// Five rows where QWERTY has four, in the same 213pt: `KBMetrics.zhuyinKeyHeight`
/// is derived rather than chosen so the pane cannot come out a different height
/// from its neighbours on the track. Everything about how a keystroke turns into
/// a character lives in `ZhuyinComposer` (ParleyKit), which is why this file has
/// no state beyond which plane is showing.
///
/// **It does not observe the bridge.** The bridge is one `ObservableObject`, and
/// every keystroke publishes on it — the composition and the candidates, and
/// while dictating the microphone level twelve times a second. A pane that held
/// it as `@ObservedObject` was invalidated by every one of those, and so was
/// every pane beside it on the track: each 注音 key re-evaluated some seventy
/// key bodies across this pane and the off-screen QWERTY one, to draw keys
/// none of which had changed. So the bridge is held for its actions only, the
/// three things the keys actually draw from it arrive as plain values, and the
/// pane is `Equatable` on them — `KeyboardRootView` wraps it in `.equatable()`
/// and SwiftUI skips its body whenever they are unchanged, which on a keystroke
/// is always.
struct ZhuyinPane: View, Equatable {
    /// Actions only. Holding it as `@ObservedObject` is what this type exists
    /// not to do; see above.
    let bridge: KeyboardBridge
    var dark: Bool
    var showsGlobe: Bool
    var returnKey: ReturnKeyStyle

    @State private var symbols = false

    /// What the pane draws. The bridge is the same object for the process's
    /// life, and every key's action is a function of that key alone, so
    /// neither needs comparing.
    static func == (a: Self, b: Self) -> Bool {
        a.dark == b.dark && a.showsGlobe == b.showsGlobe && a.returnKey == b.returnKey
    }

    var body: some View {
        if symbols {
            SymbolPlanes(
                bridge: bridge, dark: dark, showsGlobe: showsGlobe, returnKey: returnKey,
                homeLabel: "注音", onHome: { symbols = false }
            )
            .equatable()
        } else {
            zhuyinPlane
        }
    }

    private var zhuyinPlane: some View {
        GeometryReader { geo in
            let m = KeyRowMetrics(
                width: geo.size.width, columns: ZhuyinDachen.rows[0].count)
            // One column, key to matching key: what the stagger is measured in.
            let pitch = m.unit + KBMetrics.keyGap
            VStack(spacing: KBMetrics.zhuyinRowSpacing) {
                symbolRow(ZhuyinDachen.rows[0], unit: m.unit)
                symbolRow(ZhuyinDachen.rows[1], unit: m.unit, leading: pitch / 3)
                symbolRow(ZhuyinDachen.rows[2], unit: m.unit, leading: 2 * pitch / 3)
                row {
                    ForEach(ZhuyinDachen.rows[3], id: \.self) { key in
                        symbolKey(key, width: m.unit)
                    }
                    DeleteKey(
                        dark: dark, width: m.unit, height: KBMetrics.zhuyinKeyHeight
                    ) {
                        bridge.backspace()
                    }
                    .equatable()
                }
                functionRow(m)
            }
            .padding(.horizontal, KBMetrics.sideInset)
            .padding(.top, KBMetrics.paneTop)
            .padding(.bottom, KBMetrics.paneBottom)
        }
    }

    /// One row of 大千 symbols, pushed `leading` points to the right of the row
    /// above and then left-aligned — the keys keep the eleven-column unit width,
    /// so a staggered row is the same keys as the top row's, just offset. The
    /// trailing `Spacer` is what makes it an offset rather than a stretch: a row
    /// of ten fixed-width keys would otherwise be free to spread itself out.
    private func symbolRow(
        _ keys: [Character], unit: CGFloat, leading: CGFloat = 0
    ) -> some View {
        row {
            ForEach(keys, id: \.self) { key in
                symbolKey(key, width: unit)
            }
            Spacer(minLength: 0)
        }
        .padding(.leading, leading)
    }

    /// `123`, the globe where the system asks for one, space, return.
    ///
    /// No delete: it sits in the symbol block's eleventh column, under `ㄦ`,
    /// where the system 注音 keyboard has it. `123` and return are two and a
    /// half keys each rather than the one and a half QWERTY gives them, which
    /// is what the system keyboard leaves for a row with no shift in it.
    private func functionRow(_ m: KeyRowMetrics) -> some View {
        row {
            KeyButton(
                dark: dark, tint: .alt, width: m.extraWide,
                height: KBMetrics.zhuyinKeyHeight,
                action: { symbols = true }
            ) {
                Text(verbatim: "123").font(.system(size: 16, weight: .regular))
            }
            .equatable()
            .accessibilityLabel(Text(verbatim: "123"))
            if showsGlobe {
                GlobeKey(controller: bridge.controller, dark: dark)
                    .frame(width: m.unit, height: KBMetrics.zhuyinKeyHeight)
            }
            // Space is the first tone while a syllable is being typed and
            // "yes, that one" while candidates are showing — see
            // `ZhuyinComposer.space()`. The label stays put: a key whose
            // caption changes under the finger is harder to aim at than one
            // whose meaning follows the state.
            KeyButton(
                dark: dark, width: nil, height: KBMetrics.zhuyinKeyHeight,
                action: { bridge.space() }
            ) {
                Text("Space").font(.system(size: 15))
            }
            .equatable()
            .accessibilityLabel(Text("Space"))
            ReturnKey(
                bridge: bridge, style: returnKey, dark: dark, width: m.extraWide,
                height: KBMetrics.zhuyinKeyHeight
            )
            .equatable()
        }
    }

    private func row<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(spacing: KBMetrics.keyGap, content: content)
            .frame(height: KBMetrics.zhuyinKeyHeight)
    }

    /// One 大千 key. The tone marks share the plane and the cap with the symbols
    /// — they are part of the reading, not commands — and differ only in what
    /// they do to the buffer.
    private func symbolKey(_ key: Character, width: CGFloat) -> some View {
        let symbol = ZhuyinDachen.symbol(for: key) ?? key
        let tone = ZhuyinTone.mark(symbol)
        return KeyButton(
            dark: dark, width: width, height: KBMetrics.zhuyinKeyHeight,
            action: {
                if let tone {
                    bridge.zhuyinTone(tone)
                } else {
                    bridge.zhuyinSymbol(symbol)
                }
            }
        ) {
            Text(verbatim: String(symbol)).font(.system(size: 19))
        }
        .equatable()
        .accessibilityLabel(Self.label(symbol: symbol, tone: tone))
    }

    /// A tone mark read aloud as "ˊ" is nothing; VoiceOver gets the tone's name
    /// instead. Every other key is its own symbol, which VoiceOver already
    /// pronounces.
    private static func label(symbol: Character, tone: ZhuyinTone?) -> Text {
        switch tone {
        case .second: return Text("Second tone")
        case .third: return Text("Third tone")
        case .fourth: return Text("Fourth tone")
        case .neutral: return Text("Neutral tone")
        case .first, nil: return Text(verbatim: String(symbol))
        }
    }
}
