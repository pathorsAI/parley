import SwiftUI
import UIKit

/// Parley's type scale, in the Pathors faces.
///
/// The landing site (`landing`, `components/v2/v2.css`) sets DM Sans as the UI
/// face and reserves Alexandria for display. This mirrors that split:
///
/// - **DM Sans** is everything the user reads — body, labels, headings.
/// - **Alexandria** is *only* the Parley wordmark and large display numerals.
///   It is a display face; at 15pt in a list row it just looks like DM Sans
///   with worse spacing, so headings stay in DM Sans.
///
/// **Chinese falls back to the system face.** Neither DM Sans nor Alexandria
/// has a single CJK glyph, and the app defaults to Traditional Chinese, so most
/// text on screen is drawn by PingFang TC and only the Latin runs are ours.
/// That is deliberate, and CoreText does it per glyph without being asked. The
/// metrics survive it: PingFang TC is 1.400em tall (ascent 1060 / descent 340
/// per 1000 upm) against DM Sans' 1.302em (992 / 310), so a mixed line takes
/// PingFang's box and is exactly as tall as an all-Chinese line — no ragged
/// leading in a paragraph that mixes the two. DM Sans is in fact a closer match
/// to PingFang than the system font it replaces, which shortens the same line
/// to about 1.2em. What does not match is cap height (DM Sans 700 vs PingFang
/// 860 per em), so Chinese reads a touch larger next to Latin at the same point
/// size — true of SF Pro as well, so it is not a regression, but it is why the
/// scale is not tuned any smaller.
///
/// The faces are registered by `UIAppFonts` in the app target's `Info.plist`
/// (generated from `ios/App/project.yml`). An app target needs nothing beyond
/// that — no `CTFontManagerRegisterFontsForURL` call at launch. They are
/// deliberately *not* on the keyboard extension, which runs under a hard memory
/// cap.
///
/// Call sites use `.font(.parley.body)` rather than `Font.custom` directly, and
/// every role below is built with `relativeTo:` so Dynamic Type still scales it.
struct ParleyTypography {
    /// PostScript names, as `UIFont(name:)` resolves them. Verified against the
    /// shipped files' `name` table (ID 6).
    enum Face {
        static let regular = "DMSans-Regular"  // 400
        static let medium = "DMSans-Medium"  // 500
        static let semibold = "DMSans-SemiBold"  // 600
        static let bold = "DMSans-Bold"  // 700

        static let displaySemibold = "Alexandria-SemiBold"  // 600
        static let displayBold = "Alexandria-Bold"  // 700

        static let all = [regular, medium, semibold, bold, displaySemibold, displayBold]
    }

    // MARK: - The scale
    //
    // Sizes match the iOS defaults for the same roles, so swapping
    // `.font(.title3)` for `.font(.parley.title3)` changes the face and the
    // weight but not the layout.

    var largeTitle: Font { Font.custom(Face.bold, size: 34, relativeTo: .largeTitle) }
    var title: Font { Font.custom(Face.bold, size: 28, relativeTo: .title) }
    var title2: Font { Font.custom(Face.semibold, size: 22, relativeTo: .title2) }
    var title3: Font { Font.custom(Face.semibold, size: 20, relativeTo: .title3) }
    var headline: Font { Font.custom(Face.semibold, size: 17, relativeTo: .headline) }
    var body: Font { Font.custom(Face.regular, size: 17, relativeTo: .body) }
    var callout: Font { Font.custom(Face.regular, size: 16, relativeTo: .callout) }
    var subheadline: Font { Font.custom(Face.regular, size: 15, relativeTo: .subheadline) }
    var footnote: Font { Font.custom(Face.regular, size: 13, relativeTo: .footnote) }
    var caption: Font { Font.custom(Face.regular, size: 12, relativeTo: .caption) }
    var caption2: Font { Font.custom(Face.regular, size: 11, relativeTo: .caption2) }

    /// DM Sans Medium at body size, for a label that needs to sit slightly
    /// forward of `body` without becoming a `headline`.
    var bodyEmphasized: Font { Font.custom(Face.medium, size: 17, relativeTo: .body) }
    /// The same, one step down — the usual weight for a row's secondary label.
    var subheadlineEmphasized: Font {
        Font.custom(Face.medium, size: 15, relativeTo: .subheadline)
    }

    // MARK: - Display (Alexandria)

    /// The Parley wordmark. Nothing else.
    var wordmark: Font { wordmark(size: 22) }
    func wordmark(size: CGFloat) -> Font {
        Font.custom(Face.displayBold, size: size, relativeTo: .title2)
    }

    /// A large standalone numeral — a duration, a count, a stat. Tabular
    /// figures so a ticking timer doesn't shuffle its own digits sideways.
    var displayNumber: Font { displayNumber(size: 34) }
    func displayNumber(size: CGFloat) -> Font {
        Font.custom(Face.displaySemibold, size: size, relativeTo: .largeTitle).monospacedDigit()
    }

    // MARK: - Escape hatch

    /// For the rare size the scale doesn't cover. Prefer a named role; if you
    /// find yourself calling this twice for the same thing, add the role here.
    func dmSans(_ face: String = Face.regular, size: CGFloat, relativeTo style: Font.TextStyle)
        -> Font
    {
        Font.custom(face, size: size, relativeTo: style)
    }

    /// Which of the bundled faces the runtime can actually resolve. Empty means
    /// everything registered; anything listed means `UIAppFonts` and the copied
    /// resources have drifted apart and that role is silently falling back to
    /// the system face.
    static func unresolvedFaces() -> [String] {
        Face.all.filter { UIFont(name: $0, size: 12) == nil }
    }
}

extension Font {
    /// `.font(.parley.body)`
    static let parley = ParleyTypography()
}

#if DEBUG
    private struct TypeScaleSpecimen: View {
        private let mixed = "會議紀錄 Meeting notes"

        var body: some View {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    registration

                    row("largeTitle", .parley.largeTitle)
                    row("title", .parley.title)
                    row("title2", .parley.title2)
                    row("title3", .parley.title3)
                    row("headline", .parley.headline)
                    row("body", .parley.body)
                    row("bodyEmphasized", .parley.bodyEmphasized)
                    row("callout", .parley.callout)
                    row("subheadline", .parley.subheadline)
                    row("footnote", .parley.footnote)
                    row("caption", .parley.caption)
                    row("caption2", .parley.caption2)

                    Divider().overlay(Theme.border)

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Parley")
                            .font(.parley.wordmark)
                            .foregroundStyle(Theme.brandGradient)
                        Text("12:34")
                            .font(.parley.displayNumber)
                            .foregroundStyle(Theme.brandGradient)
                        Text("Alexandria — wordmark and display numerals only")
                            .font(.parley.caption)
                            .foregroundStyle(Theme.mutedForeground)
                    }

                    // A paragraph that mixes the two scripts on every line: the
                    // thing to eyeball is whether the leading stays even.
                    Text(
                        "Parley 會把整場會議錄下來，transcribe 之後產生 findings，"
                            + "然後把重點寫回 Parley。Latin and 中文 share the line."
                    )
                    .font(.parley.body)
                    .foregroundStyle(Theme.foreground)
                    .padding(12)
                    .background(Theme.tintedSurface, in: RoundedRectangle(cornerRadius: Theme.radius))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
            }
            .background(Theme.background)
        }

        @ViewBuilder private var registration: some View {
            let missing = ParleyTypography.unresolvedFaces()
            Text(
                missing.isEmpty
                    ? "All 6 faces registered"
                    : "NOT REGISTERED: \(missing.joined(separator: ", "))"
            )
            .font(.caption)  // system font on purpose: this must render even if ours don't
            .foregroundStyle(missing.isEmpty ? Theme.success : Theme.destructive)
        }

        private func row(_ name: String, _ font: Font) -> some View {
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                    .font(.caption2)
                    .foregroundStyle(Theme.mutedForeground)
                Text(mixed)
                    .font(font)
                    .foregroundStyle(Theme.foreground)
            }
        }
    }

    #Preview("Type scale — light") {
        TypeScaleSpecimen().preferredColorScheme(.light)
    }

    #Preview("Type scale — dark") {
        TypeScaleSpecimen().preferredColorScheme(.dark)
    }

    #Preview("Type scale — XXL") {
        TypeScaleSpecimen()
            .environment(\.dynamicTypeSize, .accessibility2)
    }
#endif
