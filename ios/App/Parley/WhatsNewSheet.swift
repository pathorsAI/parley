import ParleyKit
import SwiftUI
import UIKit

/// The What's New sheet: one announcement, once, after an update. See
/// `WhatsNewPresenter` for when it comes up and `AnnouncementGate` for which.
///
/// Plain on purpose, in the app's own register — white page, ink text, one
/// blue: a picture of the change (the hero, when the registry has one), a small
/// blue badge naming the release, a title that says what the user will now
/// *see*, a sentence of how, a hairline, and one line of whatever else changed.
/// One button, the same flat blue the sign-in button is, because it is the one
/// action on the surface.
///
/// ## Height
///
/// A bottom sheet as tall as what it says, not a fixed half-screen with a gap
/// under the button. The content is measured and the sheet's only detent is
/// that height. When the content outgrows most of the screen — the largest
/// accessibility text sizes do — the detent becomes `.large` and the text
/// scrolls, while the button stays pinned below it, as on the sign-in page: the
/// one control that matters is never the part pushed off screen.
struct WhatsNewSheet: View {
    let announcement: Announcement
    let onDone: () -> Void

    /// The copy in the app's UI language — the same answer every
    /// `Localizable.xcstrings` string gets, so the sheet never speaks a
    /// different language from the screen under it.
    private let localization = Bundle.main.preferredLocalizations.first ?? "en"

    @State private var contentHeight: CGFloat = 0
    @State private var footerHeight: CGFloat = 0

    /// Above this share of the screen the sheet stops fitting and goes large.
    private static let maxShare: CGFloat = 0.85

    init(announcement: Announcement, onDone: @escaping () -> Void) {
        self.announcement = announcement
        self.onDone = onDone
    }

    var body: some View {
        let copy = announcement.copy(forLocalization: localization)
        VStack(spacing: 0) {
            ScrollView {
                if let copy { content(copy) }
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollDisabled(fits)

            if let copy { footer(copy) }
        }
        .background(Theme.background)
        .presentationDetents([detent])
        .presentationDragIndicator(.visible)
        .presentationBackground(Theme.background)
    }

    // MARK: height

    /// The two measured parts, and nothing for the home indicator: a
    /// `.height` detent is the height of the sheet's safe area, and the system
    /// adds the inset below it. Counting it here left a home indicator's worth
    /// of blank page between the text and the button.
    private var measured: CGFloat { contentHeight + footerHeight }

    private var screenHeight: CGFloat {
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.screen.bounds.height }
            .first ?? 844
    }

    private var fits: Bool { measured <= screenHeight * Self.maxShare }

    /// Before the first layout pass there is nothing measured yet; `.medium`
    /// is only ever the first frame's guess, replaced before the sheet has
    /// finished coming up.
    private var detent: PresentationDetent {
        guard contentHeight > 0 else { return .medium }
        return fits ? .height(ceil(measured)) : .large
    }

    // MARK: content

    private func content(_ copy: Announcement.Copy) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let hero = WhatsNewHero.view(for: announcement.hero, localization: localization) {
                hero
                    .frame(maxWidth: .infinity)
                    .frame(height: WhatsNewHero.height)
                    .clipShape(RoundedRectangle(cornerRadius: WhatsNewHero.corner, style: .continuous))
                    // A picture of the sentence below it, which VoiceOver
                    // reads anyway.
                    .accessibilityHidden(true)
                    .padding(.bottom, 20)
            }

            Text(verbatim: copy.badge)
                .font(.parley.caption.weight(.semibold))
                .foregroundStyle(Theme.primary)

            Text(verbatim: copy.title)
                .font(.parley.dmSans(ParleyTypography.Face.bold, size: 20, relativeTo: .title3))
                .foregroundStyle(Color(.label))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .padding(.top, 6)

            Text(verbatim: copy.body)
                .font(.parley.subheadline)
                .foregroundStyle(Color(.secondaryLabel))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 8)

            Rectangle()
                .fill(Color(.separator))
                .frame(height: 0.5)
                .padding(.vertical, 16)

            also(copy.also)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        // Clear of the drag indicator above.
        .padding(.top, 28)
        .padding(.bottom, 20)
        .background(
            GeometryReader { proxy in
                Color.clear.preference(key: ContentHeightKey.self, value: proxy.size.height)
            }
        )
        .onPreferenceChange(ContentHeightKey.self) { contentHeight = $0 }
    }

    /// "**Also** long dictations now scroll…" — the prefix from the app's
    /// string catalog, the rest from the announcement.
    private func also(_ text: String) -> some View {
        (Text("Also")
            .font(.parley.dmSans(ParleyTypography.Face.bold, size: 13, relativeTo: .footnote))
            .foregroundColor(Color(.label))
            + Text(verbatim: " ")
            + Text(verbatim: text)
            .foregroundColor(Color(.secondaryLabel)))
            .font(.parley.footnote)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: the button

    /// The sign-in button's look (`OnboardingView.callToAction`): flat
    /// `primary`, white label, `Theme.radius`.
    private func footer(_ copy: Announcement.Copy) -> some View {
        Button(action: onDone) {
            Text(verbatim: copy.button)
                .font(.parley.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 15)
                // Fixed white: the fill is the signal blue in both appearances.
                .foregroundStyle(.white)
                .background(Theme.primary, in: RoundedRectangle(cornerRadius: Theme.radius))
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 20)
        .padding(.top, 4)
        .padding(.bottom, 12)
        .background(
            GeometryReader { proxy in
                Color.clear.preference(key: FooterHeightKey.self, value: proxy.size.height)
            }
        )
        .onPreferenceChange(FooterHeightKey.self) { footerHeight = $0 }
    }
}

private struct ContentHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

private struct FooterHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
