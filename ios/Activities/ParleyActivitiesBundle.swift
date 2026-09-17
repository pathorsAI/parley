import SwiftUI
import WidgetKit

/// The extension's entry point, and everything it offers.
///
/// One widget, and it is a Live Activity rather than a home-screen one. Parley
/// has nothing to put on a home screen that the app icon does not already say —
/// a widget showing the last recording's name is a bookmark, not information —
/// whereas the microphone is a fact about *right now* that the app cannot show
/// when it is not the thing on screen. That is the whole reason this target
/// exists, so it holds exactly the one thing.
@main
struct ParleyActivitiesBundle: WidgetBundle {
    var body: some Widget {
        MicActivityWidget()
    }
}
