import ParleyKit
import SwiftUI

// The pieces of the Library's Meetings overview — the phone's take on the
// desktop's 總覽 (`src/components/home/HomeScreen.tsx`): a row of blue light
// bars behind the top of the page, the getting-started list, the folders as one
// sideways row of cards, and the four newest recordings. `LibraryView` puts
// them together, because the state they act on (the scope, the folders, the
// dialogs) is its own; everything here only draws and reports taps.

// MARK: - Backdrop

/// The desktop's `HomeBackdrop`, bar for bar: thirteen vertical light bars,
/// mirrored left to right so the tall, dark-cored bars sit on the right, each
/// fading to transparent at both ends, rising into place 60 ms apart when the
/// page opens — over a faint blue wash that fades into the page.
///
/// The desktop's geometry is kept in its own pixels (a 595 px layer starting
/// 172 px above the page) and scaled down vertically, because a phone column
/// is a third of the desktop's width: at full height the bars came out as
/// thin stripes three times taller than they are wide. Horizontally they keep
/// the desktop's percentages, so the rhythm of the row is the same.
///
/// Fading to transparent rather than to a colour is what lets the same bars
/// sit on the dark page. Purely decorative: no hit testing, hidden from
/// VoiceOver, and still under Reduce Motion.
struct OverviewBackdrop: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var risen = false

    /// One bar: its column (left/right insets, % of the width), height and
    /// vertical offset from the layer's middle (desktop px), core colour and
    /// opacity, and where along its height the core sits.
    private struct Bar {
        let left: CGFloat
        let right: CGFloat
        let h: CGFloat
        let dy: CGFloat
        let core: UInt32
        var coreAlpha: Double = 1
        let o: Double
        var at: CGFloat = 0.5
    }

    private static let bars: [Bar] = [
        Bar(left: 0, right: 92.31, h: 689.363, dy: 3.18, core: 0x1469D4, o: 0.3),
        Bar(left: 7.71, right: 84.6, h: 445.749, dy: -410.63, core: 0x1979DA, o: 0.4),
        Bar(left: 15.42, right: 76.89, h: 353.586, dy: 14.1, core: 0x1D86E0, o: 0.5, at: 0.49519),
        Bar(left: 23.16, right: 69.15, h: 297.546, dy: -200.59, core: 0x2191E4, o: 0.6),
        Bar(left: 30.75, right: 61.59, h: 258, dy: -58.36, core: 0x2191E4, coreAlpha: 0.9, o: 0.7),
        Bar(left: 38.47, right: 53.82, h: 223.018, dy: -228.03, core: 0x2AACEF, coreAlpha: 0.8, o: 0.8),
        Bar(left: 46.16, right: 46.17, h: 381, dy: -203.86, core: 0x2DB6F3, coreAlpha: 0.7, o: 1),
        Bar(left: 53.82, right: 38.47, h: 261.839, dy: -288.18, core: 0x2AACEF, coreAlpha: 0.8, o: 0.8),
        Bar(left: 61.57, right: 30.72, h: 294.053, dy: -76.34, core: 0x259DE9, coreAlpha: 0.9, o: 0.7),
        Bar(left: 69.24, right: 23.07, h: 264.968, dy: -394.47, core: 0x2191E4, o: 0.6),
        Bar(left: 76.94, right: 15.35, h: 328.745, dy: -228.99, core: 0x1D86E0, o: 0.5, at: 0.49519),
        Bar(left: 84.65, right: 7.68, h: 511, dy: -112.86, core: 0x1979DA, o: 0.4),
        Bar(left: 92.36, right: -0.05, h: 571.586, dy: -322.1, core: 0x1469D4, o: 0.3),
    ]

    /// The desktop layer: 595 px tall, its top 172 px above the page.
    private static let layerTop: CGFloat = -172
    private static let layerHeight: CGFloat = 595
    /// Desktop px → points, vertically.
    private static let scale: CGFloat = 0.85
    /// How far down the page the lowest bar reaches (the first one, ending
    /// 473 px down on the desktop). The backdrop is this tall and no taller.
    static let height: CGFloat = 473 * scale
    /// The desktop's rise: up from 49.56 px below, half a second each.
    private static let rise: CGFloat = 49.56 * scale

    var body: some View {
        GeometryReader { geo in
            let width = geo.size.width
            let middle = (Self.layerTop + Self.layerHeight / 2) * Self.scale
            ZStack(alignment: .topLeading) {
                // The wash: the desktop's pale blue at 20% on light, its
                // primary at 10% under 60% on dark — faded into the page here
                // rather than covering it, since the page goes on below.
                LinearGradient(
                    colors: [washTop, Theme.background.opacity(0)],
                    startPoint: .top, endPoint: .bottom)
                ZStack(alignment: .topLeading) {
                    ForEach(Self.bars.indices, id: \.self) { i in
                        let bar = Self.bars[i]
                        let x = width * bar.left / 100
                        let w = width * (100 - bar.left - bar.right) / 100
                        let h = bar.h * Self.scale
                        let core = Color(UIColor(hex: bar.core)).opacity(bar.coreAlpha)
                        LinearGradient(
                            stops: [
                                .init(color: core.opacity(0), location: 0),
                                .init(color: core, location: bar.at),
                                .init(color: core.opacity(0), location: 1),
                            ],
                            startPoint: .top, endPoint: .bottom
                        )
                        .opacity(bar.o)
                        .frame(width: w, height: h)
                        .offset(x: x, y: middle + bar.dy * Self.scale - h / 2)
                        // Rises in on its own layer, so the rise does not fight
                        // the placement above.
                        .offset(y: risen ? 0 : Self.rise)
                        .opacity(risen ? 1 : 0)
                        .animation(
                            reduceMotion
                                ? nil
                                : .timingCurve(0.16, 1, 0.3, 1, duration: 0.5)
                                    .delay(Double(i) * 0.06),
                            value: risen)
                    }
                }
                .frame(width: width, height: Self.height, alignment: .topLeading)
                // Mirrored, as on the desktop.
                .scaleEffect(x: -1, y: 1)
                .opacity(colorScheme == .dark ? 0.15 : 0.2)
            }
            .frame(width: width, height: Self.height, alignment: .topLeading)
        }
        .frame(height: Self.height)
        .clipped()
        // Faded out at the bottom, where the page goes on below it; the top
        // is the window's edge, where the bars run off as on the desktop.
        .mask(
            LinearGradient(
                stops: [
                    .init(color: .black, location: 0),
                    .init(color: .black, location: 0.7),
                    .init(color: .clear, location: 1),
                ],
                startPoint: .top, endPoint: .bottom))
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear {
            if reduceMotion { risen = true } else { DispatchQueue.main.async { risen = true } }
        }
    }

    private var washTop: Color {
        colorScheme == .dark
            ? Theme.primary.opacity(0.06)
            : Color(UIColor(hex: 0xF0F9FF)).opacity(0.2)
    }
}

// MARK: - Section heading

/// The desktop's `text-xs font-semibold text-muted-foreground` heading.
struct OverviewHeading<Trailing: View>: View {
    let title: LocalizedStringKey
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 8) {
            Text(title)
                .font(.parley.caption.weight(.semibold))
                .foregroundStyle(Color(.secondaryLabel))
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            trailing
        }
        .frame(minHeight: 24)
    }
}

/// A heading's trailing link — 查看全部, 新增資料夾: a small blue label with its
/// icon, the icon after the text for a way on (an arrow), before it for an
/// action (a plus).
struct OverviewLinkLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) {
            configuration.icon.imageScale(.small)
            configuration.title
        }
        .font(.parley.caption)
    }
}

extension OverviewHeading where Trailing == EmptyView {
    init(title: LocalizedStringKey) {
        self.init(title: title) { EmptyView() }
    }
}

// MARK: - Folder cards

/// The folder drawing's own size in the UX file (3541:9358), and the size it
/// is shown at on a phone. The drawing is laid out in its 151×136 coordinates
/// and scaled as one, so the papers, the tab and the front keep their
/// proportions exactly; the name and count are laid out at the shown size
/// instead, so they stay at the type scale rather than shrinking with it.
enum FolderCardMetrics {
    static let drawn = CGSize(width: 151, height: 136)
    static let shownWidth: CGFloat = 140
    static let scale = shownWidth / drawn.width
    static let shown = CGSize(width: shownWidth, height: drawn.height * scale)
}

/// The desktop `FolderCard`: a grey back panel, two sheets of paper tucked in
/// at 7° (left out when the folder is empty — an empty folder is drawn empty),
/// the folder's front with its tab, and the name and recording count on the
/// front. Pressed, it takes the desktop's hover look: the back turns blue, the
/// papers rise, the front takes its blue wash and the name its blue.
struct FolderCard: View {
    let name: String
    let count: Int
    let open: () -> Void

    var body: some View {
        Button(action: open) { EmptyView() }
            .buttonStyle(FolderCardStyle(name: name, count: count))
            .accessibilityLabel(Text(verbatim: name))
            .accessibilityValue(Text("\(count) recordings"))
    }
}

private struct FolderCardStyle: ButtonStyle {
    let name: String
    let count: Int

    func makeBody(configuration: Configuration) -> some View {
        FolderDrawing(pressed: configuration.isPressed, empty: count == 0, name: name, count: count)
            .contentShape(Rectangle())
            .animation(.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.35), value: configuration.isPressed)
    }
}

private struct FolderDrawing: View {
    let pressed: Bool
    let empty: Bool
    let name: String
    let count: Int

    var body: some View {
        ZStack(alignment: .topLeading) {
            drawing
                .frame(
                    width: FolderCardMetrics.drawn.width, height: FolderCardMetrics.drawn.height,
                    alignment: .topLeading
                )
                .scaleEffect(FolderCardMetrics.scale, anchor: .topLeading)
            // The name slot: 95 px down the drawing, 12 px in from each side.
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: name)
                    .font(.parley.caption)
                    .foregroundStyle(pressed ? FolderPalette.namePressed : FolderPalette.name)
                    .lineLimit(1)
                Text("\(count) recordings")
                    .font(.parley.caption2)
                    .foregroundStyle(FolderPalette.count)
                    .lineLimit(1)
            }
            .minimumScaleFactor(0.8)
            .padding(.horizontal, 12 * FolderCardMetrics.scale)
            .padding(.top, 93 * FolderCardMetrics.scale)
            .frame(width: FolderCardMetrics.shown.width, alignment: .leading)
        }
        .frame(
            width: FolderCardMetrics.shown.width, height: FolderCardMetrics.shown.height,
            alignment: .topLeading)
    }

    private var drawing: some View {
        ZStack(alignment: .topLeading) {
            // Back panel.
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(pressed ? FolderPalette.backPressed : FolderPalette.back)
                .frame(width: 151, height: 106)
            if !empty {
                paper(
                    box: CGSize(width: 111.626, height: 116.122),
                    sheet: CGSize(width: 99.601, height: 104.765),
                    fill: FolderPalette.paperBack, at: CGPoint(x: 9.89, y: 10.9))
                paper(
                    box: CGSize(width: 106, height: 95.204),
                    sheet: CGSize(width: 96.473, height: 84.074),
                    fill: FolderPalette.paperFront, at: CGPoint(x: 29.14, y: 31.16))
            }
            // The front; the pressed drawing crossfades over the resting one.
            ZStack {
                Image("FolderFront").resizable()
                Image("FolderFrontPressed").resizable().opacity(pressed ? 1 : 0)
            }
            .frame(width: 151, height: 107)
            .offset(y: 29)
        }
    }

    /// A sheet of paper turned 7°, centred in its box; pressed, it rises.
    private func paper(box: CGSize, sheet: CGSize, fill: Color, at origin: CGPoint) -> some View {
        RoundedRectangle(cornerRadius: 4, style: .continuous)
            .fill(fill)
            .frame(width: sheet.width, height: sheet.height)
            .shadow(color: .black.opacity(0.1), radius: 3.5, x: 0, y: 4)
            .rotationEffect(.degrees(7))
            .frame(width: box.width, height: box.height)
            .offset(x: origin.x + (pressed ? 3.11 : 0), y: origin.y - (pressed ? 10.9 : 0))
    }
}

/// The folder cards' colours, from the desktop's (light / dark). Not `Theme`:
/// these are the drawing's own greys and paper whites, which no other screen
/// uses.
private enum FolderPalette {
    static let back = adaptive(0xE1E1E1, 0x1C2533)
    static let backPressed = adaptive(0xD4E5EF, 0x1D3350)
    static let paperBack = adaptive(0xFFFFFF, 0x2B3646, alpha: 0.8)
    static let paperFront = adaptive(0xFFFFFF, 0x334052)
    static let name = adaptive(0x333333, 0xE5E7EB)
    static let namePressed = adaptive(0x3B82F6, 0x60A5FA)
    static let count = adaptive(0xA3A3A3, 0x8B95A3)

    static func adaptive(_ light: UInt32, _ dark: UInt32, alpha: CGFloat = 1) -> Color {
        Color(
            UIColor { traits in
                UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
                    .withAlphaComponent(alpha)
            })
    }
}

// MARK: - Recent recordings

/// One row of 最近錄音, as on the desktop: an audio glyph, the title, and
/// "date · folder · snippet" under it on one line, with the action-item count
/// at the trailing edge when there are any. No card — rows are split by
/// hairlines (`RecentRecordingsList`).
struct RecentRecordingRow: View {
    let summary: CloudRecordingSummary
    let folderName: String?

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "waveform")
                .font(.parley.subheadline)
                .foregroundStyle(Color(.secondaryLabel))
                .frame(width: 20)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(
                    verbatim: summary.title.isEmpty
                        ? String(localized: "Untitled recording") : summary.title
                )
                .font(.parley.subheadlineEmphasized)
                .foregroundStyle(Color(.label))
                .lineLimit(1)
                Text(verbatim: meta)
                    .font(.parley.caption)
                    .foregroundStyle(Color(.secondaryLabel))
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let n = summary.actionItemsCount, n > 0 {
                HStack(spacing: 4) {
                    Image(systemName: "checklist")
                    Text(verbatim: "\(n)")
                }
                .font(.parley.caption.monospacedDigit())
                .foregroundStyle(Color(.secondaryLabel))
                .fixedSize()
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text("Action items"))
                .accessibilityValue(Text(verbatim: "\(n)"))
            }
        }
        .padding(.vertical, 11)
        .contentShape(Rectangle())
    }

    /// Short month and day in the phone's locale (May 14 / 5月14日), then the
    /// folder and the snippet when there are any.
    private var meta: String {
        let date = Date(timeIntervalSince1970: summary.createdAt / 1000)
            .formatted(.dateTime.month(.abbreviated).day())
        var parts = [date]
        if let folderName { parts.append(folderName) }
        if let snippet = summary.snippet, !snippet.isEmpty { parts.append(snippet) }
        return parts.joined(separator: " · ")
    }
}

/// Rows split by hairlines, nothing around them.
struct HairlineList<Item: Identifiable, Row: View>: View {
    let items: [Item]
    @ViewBuilder var row: (Item) -> Row

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index > 0 {
                    Rectangle()
                        .fill(Color(.separator))
                        .frame(height: 0.5)
                }
                row(item)
            }
        }
    }
}

/// 最近錄音 with nothing in it: a dashed box with the sentence, and the
/// sample offered under it when the checklist is not already offering it.
struct RecentEmptyBox: View {
    let offersSample: Bool
    let transcribing: Bool
    let useSample: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            Text("No recordings yet — start a meeting or import one.")
                .font(.parley.caption)
                .foregroundStyle(Color(.secondaryLabel))
                .multilineTextAlignment(.center)
            if offersSample {
                if transcribing {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Transcribing…")
                            .font(.parley.footnote)
                            .foregroundStyle(Color(.secondaryLabel))
                    }
                    .accessibilityElement(children: .combine)
                } else {
                    Button("Use the sample", action: useSample)
                        .font(.parley.subheadlineEmphasized)
                        .buttonStyle(.borderless)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 12)
        .padding(.vertical, 24)
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(
                    Color(.separator), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
    }
}

#if DEBUG
    #Preview("Overview pieces") {
        ScrollView {
            ZStack(alignment: .top) {
                OverviewBackdrop()
                VStack(alignment: .leading, spacing: 24) {
                    ScrollView(.horizontal) {
                        HStack(spacing: 16) {
                            FolderCard(name: "Renewals", count: 3) {}
                            FolderCard(name: "Empty", count: 0) {}
                        }
                    }
                    HairlineList(items: ScreenshotDemo.recordings) { rec in
                        RecentRecordingRow(summary: rec, folderName: "Renewals")
                    }
                    RecentEmptyBox(offersSample: true, transcribing: false) {}
                }
                .padding(20)
            }
        }
        .background(Theme.background)
    }
#endif
