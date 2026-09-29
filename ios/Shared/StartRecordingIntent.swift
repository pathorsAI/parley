import AppIntents
import Foundation
import ParleyKit

/// Open Parley on the Record tab and start recording the meeting.
///
/// What the lock-screen control performs, and what Siri runs for "Record with
/// Parley". It does nothing itself but open `QuickRecord.url`; the app takes it
/// from there (`QuickRecordInbox`), so every door onto a recording — this, the
/// lock-screen widget's tap, the red circle — ends in the same
/// `MeetingRecorder.start`. See `QuickRecord` for why this brings the app
/// forward instead of recording in the background the way
/// `StartDictationIntent` does.
///
/// Compiled into both the app and the widget extension. The control is
/// declared in the extension, and a control's intent has to be there; an
/// intent that opens the app also has to be known to the app, or iOS unlocks
/// the phone and then has nothing to hand the result to.
@available(iOS 18.0, *)
struct StartRecordingIntent: AppIntent {
    static let title: LocalizedStringResource = "Start Recording"
    static let description = IntentDescription("Open Parley and start recording the meeting in the room.")
    static let openAppWhenRun = true

    init() {}

    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(QuickRecord.url))
    }
}
