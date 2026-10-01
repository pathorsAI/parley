import SwiftUI
import WidgetKit

/// The extension's entry point, and everything it offers.
///
/// The microphone Live Activity, and one way in: "start recording" as a
/// lock-screen control (iOS 18) and as a lock-screen widget. There is still no
/// home-screen widget, and on purpose — a widget showing the last recording's
/// name is a bookmark, not information, and the app icon already opens Parley.
/// The lock screen is different because it is the one place the app icon is
/// not, and the moment a meeting starts is exactly when someone is holding a
/// locked phone. So what lives there is not information either: it is the red
/// circle, one unlock away. See `QuickRecord`.
@main
struct ParleyActivitiesBundle: WidgetBundle {
    var body: some Widget {
        MicActivityWidget()
        StartRecordingWidget()
        if #available(iOS 18.0, *) {
            StartRecordingControl()
        }
    }
}
