import AppIntents
import ParleyKit
import SwiftUI
import WidgetKit

/// "Start recording", as a system control: one of the two buttons at the
/// bottom of the lock screen (in place of the flashlight or the camera), a
/// tile in Control Center, or the Action button. From a locked phone that is
/// one press and a Face ID glance to a meeting already recording — the
/// fastest route iOS offers into an app. iOS 18 and later.
@available(iOS 18.0, *)
struct StartRecordingControl: ControlWidget {
    static let kind = "com.pathors.parley.ios.control.record"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: StartRecordingIntent()) {
                Label("Record", systemImage: "record.circle")
            }
        }
        .displayName("Start Recording")
        .description("Open Parley and start recording the meeting in the room.")
    }
}

/// The same thing as a lock-screen widget, for the row under the clock — and
/// the only form of it on iOS 17, which has no controls. A tap opens Parley
/// already recording; the widget itself shows nothing that changes, so it has
/// one entry and never asks to be reloaded.
struct StartRecordingWidget: Widget {
    static let kind = "com.pathors.parley.ios.widget.record"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: Provider()) { _ in
            StartRecordingGlyph()
                .widgetURL(QuickRecord.url)
                .containerBackground(for: .widget) { AccessoryWidgetBackground() }
        }
        .configurationDisplayName("Start Recording")
        .description("Open Parley and start recording the meeting in the room.")
        .supportedFamilies([.accessoryCircular])
    }

    struct Provider: TimelineProvider {
        func placeholder(in context: Context) -> SimpleEntry { SimpleEntry(date: .now) }
        func getSnapshot(in context: Context, completion: @escaping (SimpleEntry) -> Void) {
            completion(SimpleEntry(date: .now))
        }
        func getTimeline(in context: Context, completion: @escaping (Timeline<SimpleEntry>) -> Void) {
            completion(Timeline(entries: [SimpleEntry(date: .now)], policy: .never))
        }
    }

    struct SimpleEntry: TimelineEntry {
        let date: Date
    }
}

private struct StartRecordingGlyph: View {
    var body: some View {
        Image(systemName: "mic.fill")
            .font(.system(size: 22, weight: .semibold))
            .widgetAccentable()
            .accessibilityLabel(Text("Start Recording"))
    }
}
