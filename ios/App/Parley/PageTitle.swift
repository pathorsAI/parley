import SwiftUI

/// A tab's own page title, at large-title size on the toolbar's row — leading,
/// level with whatever actions the page puts on the trailing side — instead of
/// the system's large title on a line of its own under them.
///
/// Every tab root uses it (Library, Settings), so the titles sit at the same
/// height with the same space above them whether a page has toolbar buttons
/// or not; the system large title only went up to the bar's row when it had
/// nothing beside it.
///
/// Put it in the page's `.toolbar` together with
/// `.navigationBarTitleDisplayMode(.inline)`. The page keeps its
/// `navigationTitle` (VoiceOver, the back button of pushed pages); the empty
/// `principal` item keeps the bar from also drawing that title in the middle.
struct PageTitle: ToolbarContent {
    let title: LocalizedStringKey

    init(_ title: LocalizedStringKey) {
        self.title = title
    }

    var body: some ToolbarContent {
        if #available(iOS 26.0, *) {
            // No glass capsule behind a title: it is text, not a button.
            ToolbarItem(placement: .topBarLeading) { text }
                .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .topBarLeading) { text }
        }
        ToolbarItem(placement: .principal) {
            Color.clear.frame(width: 1, height: 1).accessibilityHidden(true)
        }
    }

    private var text: some View {
        Text(title)
            .font(.parley.largeTitle)
            .foregroundStyle(Color(.label))
            .fixedSize()
            .accessibilityAddTraits(.isHeader)
    }
}
