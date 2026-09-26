import SwiftUI

/// The three tabs, in the order the tab bar shows them.
enum AppTab: Hashable {
    case record, library, settings
}

/// Which tab is up, and requests that cross from one tab to another.
///
/// The selection used to be `@State` inside `MainTabs`, which meant nothing
/// below the tab bar could change it. Settings' "Show the getting-started list
/// again" has to: the list it brings back lives on the Library, and a button
/// that resets something the user cannot see reads as a button that did
/// nothing. So the selection is lifted here and handed down as an environment
/// object, and a cross-tab request is a counter the destination watches.
@MainActor
final class TabRouter: ObservableObject {
    @Published var tab: AppTab = .record

    /// Bumped each time something asks the Library to bring the checklist
    /// into view. A counter rather than a `Bool`, so two requests in a row are
    /// two changes and the Library never has to hand a flag back. The Library
    /// remembers the last value it acted on — it may not exist yet when the
    /// request is made (a tab is built on its first visit), and it has to act
    /// on a request it was not around to see change.
    @Published private(set) var checklistRequest = 0

    /// Switch to the Library and show the getting-started list at the top of it.
    func showGettingStarted() {
        checklistRequest += 1
        tab = .library
    }
}
