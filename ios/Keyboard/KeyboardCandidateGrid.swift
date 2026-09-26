import SwiftUI

/// Every candidate for the front of the 注音 buffer, as a grid — what the strip's
/// ⌄ opens when the one-row bar is not enough.
///
/// It takes the pane's own 213pt key area rather than growing the keyboard:
/// the panes are one swipe apart and a keyboard that changes height shoves the
/// host's content around (see `KBMetrics.pane`). It *replaces* the keys there
/// rather than being painted over them, because the SwiftUI tree has no
/// background of its own to paint — the backdrop is the controller's, behind
/// everything — so the root view hides the track while this is up instead.
///
/// The order is exactly the composer's: phrases first, then the first
/// syllable's characters, most likely first. The grid never re-sorts, so the
/// candidate at the head of the bar is the first cell here.
///
/// Plain values in, closures out: whether it is showing and what a tap does
/// are the bridge's business, and the view holds no state of its own.
struct CandidateGrid: View {
    var candidates: [String]
    var dark: Bool
    var pick: (String) -> Void
    var backspace: () -> Void

    /// Narrow enough that a phone gets five or six columns, wide enough for a
    /// two-character phrase at 22pt; longer phrases shrink to fit their cell.
    private static let targetCellWidth: CGFloat = 64

    var body: some View {
        GeometryReader { geo in
            let m = KeyRowMetrics(width: geo.size.width)
            HStack(alignment: .top, spacing: KBMetrics.keyGap) {
                grid(width: geo.size.width - KBMetrics.sideInset * 2 - m.wide - KBMetrics.keyGap)
                // The keys under the panel are hidden, delete with them, and
                // delete is how a wrong syllable gets fixed without leaving the
                // grid. It keeps its place at the right edge, one and a half keys
                // wide as on QWERTY, and it repeats when held.
                VStack {
                    Spacer(minLength: 0)
                    DeleteKey(dark: dark, width: m.wide, action: backspace)
                }
            }
            .padding(.horizontal, KBMetrics.sideInset)
            .padding(.top, KBMetrics.paneTop)
            .padding(.bottom, KBMetrics.paneBottom)
        }
    }

    private func grid(width: CGFloat) -> some View {
        let count = max(4, Int(width / Self.targetCellWidth))
        let columns = Array(
            repeating: GridItem(.flexible(), spacing: KBMetrics.keyGap), count: count)
        return ScrollView(.vertical, showsIndicators: false) {
            LazyVGrid(columns: columns, spacing: KBMetrics.rowSpacing) {
                // By offset: the composer can offer the same text twice — a
                // phrase and a character that happen to agree — and each is its
                // own tap.
                ForEach(Array(candidates.enumerated()), id: \.offset) { _, candidate in
                    KeyButton(dark: dark, width: nil, action: { pick(candidate) }) {
                        Text(verbatim: candidate)
                            .font(.system(size: 22))
                            .lineLimit(1)
                            .minimumScaleFactor(0.5)
                            .padding(.horizontal, 2)
                    }
                    .accessibilityLabel(Text(verbatim: candidate))
                }
            }
        }
        .frame(width: max(width, 0))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Candidates"))
    }
}
