import MetricKit
import Network
import ParleyKit
import SwiftUI
import UIKit

/// The one place a report is made, queued, sent and confirmed, and the one
/// place the app-wide prompts (the screenshot toast, the crash banner, the
/// post-delete toast) are raised.
///
/// The prompts that belong to a screen — the empty transcript, the truncated
/// banner, the stuck sync, the dropped microphone, the re-transcription chips —
/// are drawn by that screen, from the state it already holds, and only come
/// here to ask whether they may show (`mayOffer`) and to send.
///
/// ## What leaves the phone, and when
///
/// Only a report the user tapped for, plus crash reports while "Send crash
/// reports automatically" is on (the default). A report is the trigger, a
/// recording id when there is one, whatever the user typed, the chips they
/// picked, a screenshot they chose to keep, and `diagnostics` — see
/// `DiagnosticsCollector` for what that is and `DiagnosticsScrubber` for what
/// is removed from it. Recordings, transcript text and keyboard input are never
/// part of one.
@MainActor
final class FeedbackCenter: ObservableObject {
    static let shared = FeedbackCenter()

    /// Settings › Feedback & diagnostics. On unless the user turns it off.
    static let autoSendCrashReportsKey = "feedback.autoSendCrashReports"

    static var autoSendCrashReports: Bool {
        get { UserDefaults.standard.object(forKey: autoSendCrashReportsKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: autoSendCrashReportsKey) }
    }

    let prompts = FeedbackPromptStore.shared

    /// Its own client rather than `AppState.cloud`: reports are sent from
    /// places that hold no `AppState` (MetricKit's callback, the network
    /// monitor), and the only thing the two share is the Keychain token — which
    /// is read per request either way.
    private let cloud = CloudClient { KeychainStore.get(AppState.tokenKey) }
    private let queue: FeedbackQueue? = (try? FeedbackQueue.defaultDirectory()).map(
        FeedbackQueue.init(directory:))
    private let crashReporter = CrashReporter()
    private let pathMonitor = NWPathMonitor()
    private var started = false
    /// The report sheet is up. A screenshot taken while writing a report is not
    /// a new report.
    private(set) var reportPresented = false

    // MARK: launch

    /// Subscribe to MetricKit, watch for screenshots and for the network coming
    /// back, and drain whatever an earlier run left queued. Called from the
    /// app's `init`, because MetricKit delivers the previous run's crash to the
    /// subscriber as soon as it is added and a subscriber added later misses
    /// nothing but gets it later.
    func start() {
        guard !started else { return }
        started = true
        #if DEBUG
            // The screenshot demo is a camera pointed at fixtures; a banner or a
            // toast in a store screenshot is a bug in the screenshot.
            if ScreenshotDemo.isActive { return }
        #endif

        crashReporter.onDiagnostics = { [weak self] crashes in
            Task { @MainActor in self?.received(crashes) }
        }
        MXMetricManager.shared.add(crashReporter)

        NotificationCenter.default.addObserver(
            forName: UIApplication.userDidTakeScreenshotNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.userTookScreenshot() }
        }

        // Fires once straight away with the current path, which is the launch
        // drain, and again every time the network comes back.
        pathMonitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in await self?.drain() }
        }
        pathMonitor.start(queue: DispatchQueue(label: "com.pathors.parley.feedback.path"))
    }

    /// The app is on screen: the moment to raise anything that was waiting for
    /// a scene to draw in. Called on every foregrounding.
    func sceneBecameActive() {
        guard started else { return }
        #if DEBUG
            if ScreenshotDemo.isActive { return }
        #endif
        raiseCrashBannerIfNeeded()
        #if DEBUG
            previewIfAsked()
        #endif
    }

    #if DEBUG
        /// `-ParleyFeedbackPreview screenshot|crash` puts one of the floating
        /// surfaces on screen without a real screenshot or a real crash — the
        /// only way to look at them in a simulator, which neither posts the
        /// screenshot notification nor receives MetricKit payloads. Nothing is
        /// queued, sent or recorded against the frequency limits by the crash
        /// preview; the screenshot preview runs the real path, limits included.
        private func previewIfAsked() {
            guard let preview = UserDefaults.standard.string(forKey: "ParleyFeedbackPreview")
            else { return }
            UserDefaults.standard.removeObject(forKey: "ParleyFeedbackPreview")
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(1.5))
                switch preview {
                case "screenshot":
                    userTookScreenshot()
                case "crash":
                    FeedbackOverlay.shared.show(
                        CrashBanner(
                            send: { _ in FeedbackOverlay.shared.dismiss(.top, used: true) },
                            decline: { _ in FeedbackOverlay.shared.dismiss(.top, used: true) }),
                        on: .top, duration: nil)
                default:
                    break
                }
            }
        }
    #endif

    /// A sign-in completed: reports queued while signed out can now go out
    /// under the account, and the server may have been refusing an expired
    /// token until a moment ago.
    func signedIn() {
        Task { await drain() }
    }

    // MARK: prompts

    func mayOffer(_ trigger: FeedbackTrigger, recordingId: String?) -> Bool {
        #if DEBUG
            if ScreenshotDemo.isActive { return false }
        #endif
        return prompts.mayOffer(trigger, recordingId: recordingId)
    }

    func noteOffered(_ trigger: FeedbackTrigger, recordingId: String?) {
        prompts.noteOffered(trigger, recordingId: recordingId)
    }

    func noteDismissed(_ trigger: FeedbackTrigger) {
        prompts.noteDismissed(trigger)
    }

    // MARK: sending

    /// Build a report, queue it, confirm it, and try to deliver it.
    ///
    /// "Sent. Thank you." is shown as soon as the report is safely queued, not
    /// when the server has answered: from the user's side the report is done —
    /// the queue delivers it on the next launch, network change or sign-in if
    /// it cannot go now — and a spinner that waits on a phone with no signal
    /// would be the one thing in this feature that asks the user to wait.
    func send(
        _ trigger: FeedbackTrigger, recordingId: String? = nil,
        context: FeedbackDiagnostics.Context? = nil, message: String? = nil,
        tags: [String]? = nil, screenshot: Data? = nil, crash: JSONValue? = nil,
        id: String = UUID().uuidString.lowercased(), confirm: Bool = true
    ) async {
        var context = context ?? .init()
        if context.recordingId == nil { context.recordingId = recordingId }
        // A crash report is built by a later process than the one that
        // crashed, so this process's log is about something else entirely and
        // is left out rather than presented as context it is not.
        let diagnostics = await DiagnosticsCollector.collect(
            context: context, includeLog: trigger != .crash, crash: crash)
        let payload = FeedbackPayload(
            id: id, trigger: trigger, recordingId: recordingId, message: message, tags: tags,
            diagnostics: diagnostics)
        do {
            try await queue?.enqueue(payload, screenshot: screenshot)
            AppLog.feedback.notice(
                "queued \(trigger.rawValue, privacy: .public) report \(id, privacy: .public)")
        } catch {
            AppLog.feedback.error("could not queue a report: \(FeedbackErrorCode.of(error), privacy: .public)")
            if confirm { toast(String(localized: "Couldn't save the report. Try again.")) }
            return
        }
        if confirm { toast(String(localized: "Sent. Thank you.")) }
        await drain()
    }

    /// Deliver whatever is queued. Safe to call from anywhere at any time —
    /// the queue lets one pass run and tells the others what is left.
    func drain() async {
        guard let queue else { return }
        let cloud = self.cloud
        let result = await queue.drain { payload, screenshot in
            try await cloud.submitFeedback(payload: payload, screenshot: screenshot)
        }
        if result.delivered > 0 || result.dropped > 0 || result.stoppedOn != nil {
            AppLog.feedback.notice(
                "feedback drain: \(result.delivered, privacy: .public) sent, \(result.dropped, privacy: .public) dropped, \(result.remaining, privacy: .public) left, stopped on \(result.stoppedOn ?? "-", privacy: .public)"
            )
        }
    }

    // MARK: the report sheet

    /// Open 「回報問題」 over whatever is on screen. `manual` from Settings,
    /// `screenshot` from the screenshot toast with the snapshot it took.
    func presentReport(_ trigger: FeedbackTrigger, screenshot: UIImage? = nil) {
        guard !reportPresented, let presenter = FeedbackOverlay.topViewController() else {
            AppLog.feedback.error(
                "report sheet not shown: \(self.reportPresented ? "already up" : "no presenter", privacy: .public)"
            )
            return
        }
        AppLog.feedback.notice("report sheet opened for \(trigger.rawValue, privacy: .public)")
        reportPresented = true
        let holder = PresentedSheet()
        let view = ReportProblemView(
            screenshot: screenshot,
            send: { [weak self] message, keptScreenshot in
                holder.dismiss()
                self?.reportPresented = false
                let jpeg = keptScreenshot.flatMap(FeedbackImage.jpeg(from:))
                Task { await self?.send(trigger, message: message, screenshot: jpeg) }
            },
            cancel: { [weak self] in
                holder.dismiss()
                self?.reportPresented = false
                // Closing the sheet a screenshot toast opened is closing that
                // prompt. The manual sheet is exempt from the limits anyway.
                self?.noteDismissed(trigger)
            })
        let host = UIHostingController(rootView: view.tint(Theme.primary))
        host.overrideUserInterfaceStyle = FeedbackOverlay.interfaceStyle()
        host.presentationController?.delegate = holder
        holder.host = host
        holder.onSwipeDismiss = { [weak self] in
            self?.reportPresented = false
            self?.noteDismissed(trigger)
        }
        presenter.present(host, animated: true)
    }

    /// Keeps the hosting controller reachable from the SwiftUI closures that
    /// have to close it, and hears the swipe-down that closes it without them.
    private final class PresentedSheet: NSObject, UIAdaptivePresentationControllerDelegate {
        weak var host: UIViewController?
        var onSwipeDismiss: (() -> Void)?

        func dismiss() {
            host?.dismiss(animated: true)
        }

        func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
            onSwipeDismiss?()
        }
    }

    // MARK: toasts

    func toast(_ text: String) {
        FeedbackOverlay.shared.show(
            FeedbackToast(text: text), on: .bottom, duration: 2.5)
    }

    /// `screenshot`: the user took one. Offer — never insist — to report the
    /// screen, with a picture of it the app drew itself.
    private func userTookScreenshot() {
        // The crash banner also lives at the top; it outranks this offer.
        guard UIApplication.shared.applicationState == .active, !reportPresented,
            !FeedbackOverlay.shared.isShowing(.top),
            mayOffer(.screenshot, recordingId: nil)
        else { return }
        // Taken now, before the toast exists, so the picture is of what the
        // user screenshotted and not of the offer to report it. The toast is in
        // a window of its own and would not be in it anyway.
        guard let image = FeedbackImage.snapshotAppWindow() else { return }
        noteOffered(.screenshot, recordingId: nil)
        FeedbackOverlay.shared.show(
            FeedbackToast(
                text: String(localized: "Report this screen?"),
                action: String(localized: "Report"),
                perform: { [weak self] in
                    FeedbackOverlay.shared.dismiss(.top, used: true)
                    self?.presentReport(.screenshot, screenshot: image)
                }),
            // Top, not bottom: for these five seconds the system screenshot
            // thumbnail sits in the bottom corner and would crowd the offer.
            on: .top, duration: 5,
            onIgnored: { [weak self] in self?.noteDismissed(.screenshot) })
    }

    /// `delete_failed`: the user just deleted a recording that came back empty
    /// or cut short. The library decides the condition; this offers the report.
    func offerReportAfterDelete(recordingId: String, context: FeedbackDiagnostics.Context) {
        guard mayOffer(.deleteFailed, recordingId: recordingId) else { return }
        noteOffered(.deleteFailed, recordingId: recordingId)
        FeedbackOverlay.shared.show(
            FeedbackToast(
                text: String(localized: "Deleted. Send us diagnostics for this recording?"),
                action: String(localized: "Send report"),
                perform: { [weak self] in
                    FeedbackOverlay.shared.dismiss(.bottom, used: true)
                    Task {
                        await self?.send(.deleteFailed, recordingId: recordingId, context: context)
                    }
                }),
            on: .bottom, duration: 5,
            onIgnored: { [weak self] in self?.noteDismissed(.deleteFailed) })
    }

    // MARK: crashes

    private func received(_ crashes: [PendingCrash]) {
        if Self.autoSendCrashReports {
            Task { await sendPendingCrashes() }
        } else {
            raiseCrashBannerIfNeeded()
        }
    }

    /// Send every crash that is waiting, and forget it once it is queued. The
    /// queue owns delivery from there, under the same id.
    func sendPendingCrashes() async {
        for crash in PendingCrashStore.load() {
            await send(
                .crash, crash: CrashDiagnosticJSON.decode(crash.json), id: crash.id,
                confirm: false)
            PendingCrashStore.remove(crash.id)
        }
    }

    /// With auto-send off, ask — once per crash, at the top of the screen.
    ///
    /// Only for a *crash*. The banner says Parley closed unexpectedly, and a
    /// hang is not that: the app froze for a moment and carried on. With
    /// auto-send on, hangs go with everything else; with it off, a hang on its
    /// own is not worth a banner whose sentence would be false, and it is
    /// dropped unsent. A hang that arrived with a crash rides along with the
    /// crash's answer.
    private func raiseCrashBannerIfNeeded() {
        let pending = PendingCrashStore.load()
        if Self.autoSendCrashReports {
            // Turned back on since these arrived, or delivered before the
            // setting was read: the user's standing answer is "send".
            if !pending.isEmpty { Task { await sendPendingCrashes() } }
            return
        }
        guard pending.contains(where: { $0.kind == "crash" }) else {
            pending.forEach { PendingCrashStore.remove($0.id) }
            return
        }
        guard !FeedbackOverlay.shared.isShowing(.top) else { return }
        FeedbackOverlay.shared.show(
            CrashBanner(
                send: { [weak self] alwaysSend in
                    FeedbackOverlay.shared.dismiss(.top, used: true)
                    if alwaysSend { Self.autoSendCrashReports = true }
                    Task { await self?.sendPendingCrashes() }
                },
                decline: { alwaysSend in
                    FeedbackOverlay.shared.dismiss(.top, used: true)
                    // "Always send" ticked and then "Don't send" is a person
                    // who wants the next one sent but not this one — which is
                    // exactly what doing both says.
                    if alwaysSend { Self.autoSendCrashReports = true }
                    PendingCrashStore.load().forEach { PendingCrashStore.remove($0.id) }
                }),
            on: .top, duration: nil)
    }
}

/// Turning the app's own screen into the JPEG a report carries.
enum FeedbackImage {
    /// §5: long edge 1600 px, JPEG quality 0.7.
    static let maxLongEdge: CGFloat = 1_600
    static let quality: CGFloat = 0.7
    /// §3: the server refuses a screenshot over 1.5 MB. A dense screen can
    /// exceed that at 0.7, so quality steps down until it fits rather than the
    /// report being refused for good by the queue.
    static let maxBytes = 1_500_000

    /// A picture of the app's own window, drawn by the app — never read out of
    /// Photos, and never including anything outside Parley. The feedback
    /// overlays are windows of their own and are not in it.
    @MainActor
    static func snapshotAppWindow() -> UIImage? {
        guard let window = FeedbackOverlay.appWindow(), window.bounds.width > 0 else { return nil }
        let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
        return renderer.image { _ in
            _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
        }
    }

    static func jpeg(from image: UIImage) -> Data? {
        let pixels = CGSize(
            width: image.size.width * image.scale, height: image.size.height * image.scale)
        let longEdge = max(pixels.width, pixels.height)
        let factor = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1
        let target = CGSize(
            width: (pixels.width * factor).rounded(), height: (pixels.height * factor).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let resized = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        var q = quality
        while q >= 0.3 {
            if let data = resized.jpegData(compressionQuality: q), data.count <= maxBytes {
                return data
            }
            q -= 0.1
        }
        return nil
    }
}
