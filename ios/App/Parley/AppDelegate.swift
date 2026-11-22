import UIKit

/// The UIKit door SwiftUI has no equivalent for: the system relaunching (or
/// waking) the app to report background `URLSession` transfers (parley#727).
///
/// The session is re-created in `didFinishLaunching`, on every launch, because
/// a background launch for transfer events may never build a scene — and the
/// delegate that hears about finished uploads has to exist before the system
/// starts delivering them.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        BackgroundAudioUpload.shared.onUploadedWithoutWaiter = { id in
            Task { await MeetingUploader.finishAfterBackgroundUpload(id: id) }
        }
        BackgroundAudioUpload.shared.activate()
        return true
    }

    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        BackgroundAudioUpload.shared.handleEvents(identifier: identifier, completion: completionHandler)
    }
}
