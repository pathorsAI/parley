import SwiftUI

/// The top of a tab's root page — Library, Settings: the page's title at
/// large-title size, leading, with the page's actions (if any) level with it
/// on the trailing side, and room above it.
///
/// Drawn in the page rather than by the navigation bar: the bar's height is
/// the system's, so a title inside it (or the system large title under it)
/// could not be given more space above, nor sit level with the buttons and at
/// the same height on a page without any. Every tab root uses this one header,
/// so their titles line up from tab to tab. The root hides the navigation bar
/// (`.toolbar(.hidden, for: .navigationBar)`); pages pushed from it bring
/// their own bar and back button back.
struct TabPageHeader<Trailing: View>: View {
    let title: LocalizedStringKey
    @ViewBuilder var trailing: Trailing

    /// Above the title, under the status bar.
    static var topSpace: CGFloat { 30 }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Text(title)
                .font(.parley.largeTitle)
                .foregroundStyle(Color(.label))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            trailing
        }
        .padding(.horizontal, 20)
        .padding(.top, Self.topSpace)
        .padding(.bottom, 10)
    }
}

extension TabPageHeader where Trailing == EmptyView {
    init(_ title: LocalizedStringKey) {
        self.init(title: title) { EmptyView() }
    }
}

/// The header's actions as one control: icons and labels in a capsule of
/// Liquid Glass on iOS 26, of material before it — what the toolbar drew
/// around them when they were toolbar items.
struct HeaderActions<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        // Glyphs at body size, as the toolbar drew them; labels a step smaller.
        let row = HStack(spacing: 20) { content }
            .font(.parley.body)
            .padding(.horizontal, 18)
            .frame(height: 44)
        if #available(iOS 26.0, *) {
            row.glassEffect(.regular.interactive(), in: .capsule)
        } else {
            row.background(.regularMaterial, in: Capsule())
        }
    }
}

/// A search field in the page, for a root page with no navigation bar to put
/// `.searchable` in: the magnifier, the field, and a clear button once there
/// is something to clear. Return or dragging the list puts the keyboard away.
struct PageSearchField: View {
    @Binding var text: String
    let prompt: Text
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(Color(.secondaryLabel))
                .accessibilityHidden(true)
            TextField(text: $text, prompt: prompt) { prompt }
                .focused($focused)
                .submitLabel(.search)
                .autocorrectionDisabled()
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Color(.tertiaryLabel))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Clear"))
            }
        }
        .font(.parley.body)
        .padding(.horizontal, 14)
        .frame(height: 44)
        .background(Color(.tertiarySystemFill), in: Capsule())
        .contentShape(Capsule())
        .onTapGesture { focused = true }
    }
}
