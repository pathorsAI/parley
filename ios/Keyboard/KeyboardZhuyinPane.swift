import ParleyKit
import SwiftUI

/// The 注音 pane: 傳統注音 typing on the 大千 layout, one syllable at a time.
///
/// The keys are 大千 as it is actually defined — a mapping onto a QWERTY board —
/// so the top row is **eleven** wide (`1234567890-`) and the three below it are
/// ten, centred under it by the same half-key inset QWERTY's home row uses. A
/// tidy 4×10 grid would have to drop `ㄦ`, and 兒/二/而/耳 are not optional.
///
/// Five rows where QWERTY has four, in the same 213pt: `KBMetrics.zhuyinKeyHeight`
/// is derived rather than chosen so the pane cannot come out a different height
/// from its neighbours on the track. Everything about how a keystroke turns into
/// a character lives in `ZhuyinComposer` (ParleyKit), which is why this file has
/// no state beyond which plane is showing.
struct ZhuyinPane: View {
    @ObservedObject var bridge: KeyboardBridge
    var dark: Bool

    @State private var symbols = false

    var body: some View {
        if symbols {
            SymbolPlanes(
                bridge: bridge, dark: dark, homeLabel: "注音",
                onHome: { symbols = false })
        } else {
            zhuyinPlane
        }
    }

    private var zhuyinPlane: some View {
        GeometryReader { geo in
            let m = KeyRowMetrics(
                width: geo.size.width, columns: ZhuyinDachen.rows[0].count)
            VStack(spacing: KBMetrics.zhuyinRowSpacing) {
                ForEach(Array(ZhuyinDachen.rows.enumerated()), id: \.offset) { index, keys in
                    row {
                        ForEach(keys, id: \.self) { key in
                            symbolKey(key, width: m.unit)
                        }
                    }
                    .padding(.horizontal, index == 0 ? 0 : m.halfKey)
                }
                functionRow(m)
            }
            .padding(.horizontal, KBMetrics.sideInset)
            .padding(.top, KBMetrics.paneTop)
            .padding(.bottom, KBMetrics.paneBottom)
        }
    }

    /// `123`, the globe where the system asks for one, space, delete, return.
    ///
    /// Delete lives here rather than beside the symbols, because all 41 大千 keys
    /// are spoken for — there is no shift row to borrow a corner from.
    private func functionRow(_ m: KeyRowMetrics) -> some View {
        row {
            KeyButton(
                dark: dark, tint: .alt, width: m.wide, height: KBMetrics.zhuyinKeyHeight,
                action: { symbols = true }
            ) {
                Text(verbatim: "123").font(.system(size: 16, weight: .regular))
            }
            .accessibilityLabel(Text(verbatim: "123"))
            if bridge.showsGlobe {
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
            .accessibilityLabel(Text("Space"))
            DeleteKey(dark: dark, width: m.wide, height: KBMetrics.zhuyinKeyHeight) {
                bridge.backspace()
            }
            ReturnKey(
                bridge: bridge, dark: dark, width: m.wide,
                height: KBMetrics.zhuyinKeyHeight)
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
