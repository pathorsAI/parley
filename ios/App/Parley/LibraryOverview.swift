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

/// One of 最近錄音's rows: a waveform glyph, the title, and the meta line the
/// desktop's list has — when the meeting was and how many people spoke.
struct RecentRecordingRow: View {
    let summary: CloudRecordingSummary

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "waveform")
                .font(.parley.subheadline)
                .foregroundStyle(Color(.secondaryLabel))
                .frame(width: 20)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(
                    verbatim: summary.title.isEmpty
                        ? String(localized: "Untitled recording") : summary.title
                )
                .font(.parley.subheadlineEmphasized)
                .foregroundStyle(Color(.label))
                .lineLimit(1)
                RecordingMetaLine(summary: summary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 11)
        .contentShape(Rectangle())
    }
}

/// A recording's meta, as the desktop's list gives it: when the meeting was,
/// and how many people spoke. Nothing from the transcript — a row says which
/// meeting this is, the recording says what was in it — and no duration,
/// folder or findings count, which the list's folder pages, the recording and
/// its summary already carry.
///
/// Shared by the overview's recent rows and the full list, so the two lists
/// read the same.
struct RecordingMetaLine: View {
    let summary: CloudRecordingSummary

    var body: some View {
        HStack(spacing: 12) {
            Text(verbatim: Self.dateLabel(summary.createdAt))
                .fixedSize()
            if let n = summary.speakerCount, n > 0 {
                HStack(spacing: 4) {
                    Image(systemName: "person.2")
                    Text(verbatim: "\(n)")
                }
                .fixedSize()
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text("Speakers"))
                .accessibilityValue(Text(verbatim: "\(n)"))
            }
        }
        // A clock time and a count: tabular figures, so rows line up.
        .font(.parley.caption.monospacedDigit())
        .foregroundStyle(Color(.secondaryLabel))
        .lineLimit(1)
    }

    /// Locale-formatted rather than one hard-coded `M/d HH:mm`: an English phone
    /// expects Aug 9, 3:20 PM where a Chinese one expects 8月9日 下午3:20.
    ///
    /// The year is added for anything outside the current one. Without it a
    /// list sorted newest first reads as out of order the moment it crosses a
    /// new year: Mar 8 (this year) above Jul 17 (last year) looks backwards.
    static func dateLabel(_ epochMs: Double, now: Date = .now) -> String {
        let date = Date(timeIntervalSince1970: epochMs / 1000)
        let style = Date.FormatStyle.dateTime.month(.abbreviated).day().hour().minute()
        guard Calendar.current.isDate(date, equalTo: now, toGranularity: .year) else {
            return date.formatted(style.year())
        }
        return date.formatted(style)
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

/// Nothing to list — the desktop's `EmptyRecords`: its empty-box illustration
/// (UX 3541:9456, a light and a dark drawing), a title, and a hint that says
/// how this place fills up. `action`, when given, sits under the hint: the
/// library's own door into import, for instance.
struct EmptyRecordsView<Action: View>: View {
    let title: LocalizedStringKey
    let hint: LocalizedStringKey
    @ViewBuilder var action: Action

    var body: some View {
        VStack(spacing: 4) {
            EmptyRecordsIllustration()
                .frame(width: 120, height: 105.84)
                .padding(.bottom, 16)
                .accessibilityHidden(true)
            Text(title)
                .font(.parley.subheadline)
                .foregroundStyle(Color(.secondaryLabel))
            Text(hint)
                .font(.parley.caption)
                .foregroundStyle(Color(.tertiaryLabel))
                .frame(maxWidth: 280)
            action
                .padding(.top, 14)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
    }
}

extension EmptyRecordsView where Action == EmptyView {
    init(title: LocalizedStringKey, hint: LocalizedStringKey) {
        self.init(title: title, hint: hint) { EmptyView() }
    }
}

/// The desktop's empty-box illustration, `public/library/empty-records.svg`
/// and its `-dark` twin, drawn here as vectors from the very same path data.
///
/// Not the SVG in the asset catalog: the catalog turns an SVG into a bitmap at
/// build time, and iOS does not draw the file's masks faithfully either, so
/// the box came out soft at any size. Drawn live, the lines are as sharp as
/// the screen. The SVG's two masks (a stroke kept inside its own face) are a
/// clip to the face here.
struct EmptyRecordsIllustration: View {
    @Environment(\.colorScheme) private var colorScheme

    /// The SVG's viewBox.
    private static let box = CGSize(width: 80.2525, height: 70.5882)

    private static let leftFace = SVGPathData.path(
        "M0.16631 58.2022V28.5393L47.1326 39.3258V70.5618L0.16631 58.2022Z")
    private static let rightFace = SVGPathData.path(
        "M80.1663 20.7059L46.284 39.6657V70.5882L80.1663 50.9513V20.7059Z")
    private static let rim = SVGPathData.path(
        "M0.16631 28.7059L36.5708 11.0535L80.1663 21.1765")
    private static let handle = SVGPathData.path(
        "M24.9508 40.8807L20.3911 39.7753L16.6346 38.8362C15.2038 38.4785 13.7388 39.2827 13.2724 40.6818C12.7498 42.2497 13.68 43.9291 15.2864 44.3177L23.6296 46.3363C25.087 46.6888 26.5641 45.8336 26.984 44.3942C27.4322 42.8575 26.5065 41.2578 24.9508 40.8807Z")
    private static let sheet = SVGPathData.path(
        "M14.1663 31.7808V7.71653C14.1663 5.1739 16.5075 3.27655 18.995 3.80331L53.495 11.1092C55.3438 11.5007 56.6663 13.1326 56.6663 15.0224V33.7808L46.6663 39.2808L14.1663 31.7808Z")
    private static let sheetDashes = SVGPathData.path(
        "M14.1663 31.7808V31.2794M56.6663 33.7808V33.2597M14.1663 30.2767V29.2741M14.1663 28.2714V27.2687M14.1663 26.266V25.2634M14.1663 24.2607V23.258M14.1663 22.2553V21.2527M14.1663 20.25V19.2473M14.1663 18.2446V17.242M14.1663 16.2393V15.2366M14.1663 14.2339V13.2312M14.1663 12.2286V11.2259M14.1663 10.2232V9.22055M14.1663 8.21787V7.71653C14.1663 7.56605 14.1745 7.41784 14.1905 7.27225M14.3848 6.40565C14.483 6.12193 14.612 5.85362 14.7675 5.60428M15.3182 4.90752C15.5269 4.69639 15.7585 4.50872 16.0083 4.34831M16.804 3.95387C17.0802 3.85338 17.3694 3.78274 17.6673 3.74552M18.5554 3.73489C18.7011 3.74945 18.8478 3.77213 18.995 3.80331L19.4742 3.90478M20.4325 4.10772L21.3908 4.31066M22.3492 4.5136L23.3075 4.71654M24.2658 4.91948L25.2242 5.12242M26.1825 5.32536L27.1408 5.52831M28.0992 5.73125L29.0575 5.93419M30.0158 6.13713L30.9742 6.34007M31.9325 6.54301L32.8908 6.74595M33.8492 6.94889L34.8075 7.15183M35.7658 7.35478L36.7242 7.55772M37.6825 7.76066L38.6408 7.9636M39.5992 8.16654L40.5575 8.36948M41.5158 8.57242L42.4742 8.77536M43.4325 8.97831L44.3908 9.18125M45.3492 9.38419L46.3075 9.58713M47.2658 9.79007L48.2242 9.99301M49.1825 10.196L50.1408 10.3989M51.0992 10.6018L52.0575 10.8048M53.0158 11.0077L53.495 11.1092C53.6446 11.1409 53.7908 11.1807 53.9331 11.2281M54.7546 11.6103C55.0145 11.7694 55.2538 11.9569 55.4687 12.1681M56.0393 12.8721C56.2013 13.1261 56.3352 13.3991 56.437 13.6863M56.6407 14.5692C56.6576 14.7182 56.6663 14.8695 56.6663 15.0224V15.5435M56.6663 16.5856V17.6277M56.6663 18.6699V19.712M56.6663 20.7541V21.7963M56.6663 22.8384V23.8805M56.6663 24.9226V25.9648M56.6663 27.0069V28.049M56.6663 29.0912V30.1333M56.6663 31.1754V32.2176")

    /// The two drawings' colours: the light file, and the dark one's slate
    /// faces and navy sheet.
    private struct Palette {
        let leftFace, rightFace, ink, sheet, dashes: Color
    }
    private static let light = Palette(
        leftFace: Color(UIColor(hex: 0xFAFAFA)), rightFace: Color(UIColor(hex: 0xF5F5F5)),
        ink: Color(UIColor(hex: 0x535353)), sheet: Color(UIColor(hex: 0xE5F6FF)),
        dashes: Color(UIColor(hex: 0xC7ECFD)))
    private static let dark = Palette(
        leftFace: Color(UIColor(hex: 0x1E2836)), rightFace: Color(UIColor(hex: 0x253141)),
        ink: Color(UIColor(hex: 0x7B8899)), sheet: Color(UIColor(hex: 0x1F3D63)),
        dashes: Color(UIColor(hex: 0x4A86C5)))

    var body: some View {
        let c = colorScheme == .dark ? Self.dark : Self.light
        Canvas { ctx, size in
            ctx.scaleBy(x: size.width / Self.box.width, y: size.height / Self.box.height)
            // A face, then its outline kept inside it: the SVG's
            // `mask="url(#…)"` on a 1.52 stroke, i.e. a clip to the face.
            for (face, fill, join) in [
                (Self.leftFace, c.leftFace, CGLineJoin.miter),
                (Self.rightFace, c.rightFace, CGLineJoin.round),
            ] {
                ctx.fill(face, with: .color(fill))
                var inside = ctx
                inside.clip(to: face)
                inside.stroke(face, with: .color(c.ink), style: StrokeStyle(lineWidth: 1.52471, lineJoin: join))
            }
            ctx.stroke(Self.rim, with: .color(c.ink), lineWidth: 0.762353)
            ctx.fill(Self.handle, with: .color(c.ink))
            ctx.stroke(Self.handle, with: .color(c.ink), lineWidth: 0.762353)
            ctx.fill(Self.sheet, with: .color(c.sheet.opacity(0.7)))
            ctx.stroke(Self.sheetDashes, with: .color(c.dashes), lineWidth: 1)
        }
        .accessibilityHidden(true)
    }
}

/// Just enough of SVG path data for the illustrations ported from the
/// desktop: absolute M, L, H, V, C and Z, with repeated coordinate pairs.
enum SVGPathData {
    static func path(_ d: String) -> Path {
        var path = Path()
        var numbers: [CGFloat] = []
        var command: Character = " "
        var current = CGPoint.zero
        var start = CGPoint.zero

        func flush() {
            var n = numbers[...]
            func take() -> CGFloat? { n.isEmpty ? nil : n.removeFirst() }
            switch command {
            case "M":
                var first = true
                while let x = take(), let y = take() {
                    current = CGPoint(x: x, y: y)
                    if first { path.move(to: current); start = current; first = false }
                    else { path.addLine(to: current) }
                }
            case "L":
                while let x = take(), let y = take() {
                    current = CGPoint(x: x, y: y); path.addLine(to: current)
                }
            case "H":
                while let x = take() { current.x = x; path.addLine(to: current) }
            case "V":
                while let y = take() { current.y = y; path.addLine(to: current) }
            case "C":
                while let x1 = take(), let y1 = take(), let x2 = take(), let y2 = take(),
                    let x = take(), let y = take()
                {
                    current = CGPoint(x: x, y: y)
                    path.addCurve(to: current, control1: CGPoint(x: x1, y: y1), control2: CGPoint(x: x2, y: y2))
                }
            case "Z":
                path.closeSubpath(); current = start
            default: break
            }
            numbers.removeAll()
        }

        var token = ""
        func endNumber() {
            if let v = Double(token) { numbers.append(CGFloat(v)) }
            token = ""
        }
        for ch in d {
            if "MLHVCZ".contains(ch) {
                endNumber(); flush(); command = ch
            } else if ch == " " || ch == "," {
                endNumber()
            } else if ch == "-" && !token.isEmpty && token.last != "e" {
                endNumber(); token = "-"
            } else {
                token.append(ch)
            }
        }
        endNumber(); flush()
        return path
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
                        RecentRecordingRow(summary: rec)
                    }
                    RecentEmptyBox(offersSample: true, transcribing: false) {}
                }
                .padding(20)
            }
        }
        .background(Theme.background)
    }
#endif
