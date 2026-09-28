import AVFoundation
import Foundation
import OSLog
import ParleyKit
import UIKit

/// The loggers the app writes to, by category. Every one of them is in
/// `ParleyLog.reportableCategories`, which is the list a report's log is built
/// from — see there for why that is an allowlist, and for the rule that a
/// logger which ever writes user content gets a category that is *not* in it.
enum AppLog {
    static let sync = Logger(subsystem: ParleyLog.subsystem, category: ParleyLog.Category.sync.rawValue)
    static let recording = Logger(
        subsystem: ParleyLog.subsystem, category: ParleyLog.Category.recording.rawValue)
    static let capture = Logger(
        subsystem: ParleyLog.subsystem, category: ParleyLog.Category.capture.rawValue)
    static let feedback = Logger(
        subsystem: ParleyLog.subsystem, category: ParleyLog.Category.feedback.rawValue)
}

/// The last twenty things that went wrong, as codes, kept across launches.
///
/// Across launches because the report that most needs them is a crash report,
/// and that one is built by the *next* process — which cannot read a single
/// line of the crashed one's log. What it can read is this.
///
/// Lives in the app's own `UserDefaults`, not the App Group: the keyboard has no
/// business reading it, and does not write to it either.
enum DiagnosticsJournal {
    private static let key = "feedback.recentErrors"
    private static let lock = NSLock()

    /// Note a failure. `message` is short, and carries no user content; it is
    /// scrubbed on the way in regardless (`RecentErrorLog.record`).
    static func record(_ code: String, _ message: String = "") {
        lock.lock()
        defer { lock.unlock() }
        var log = read()
        log.record(code: code, message: message)
        if let data = try? JSONEncoder().encode(log) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }

    static var entries: [FeedbackDiagnostics.RecentError] {
        lock.lock()
        defer { lock.unlock() }
        return read().entries
    }

    private static func read() -> RecentErrorLog {
        guard let data = UserDefaults.standard.data(forKey: key),
            let log = try? JSONDecoder().decode(RecentErrorLog.self, from: data)
        else { return RecentErrorLog() }
        return log
    }
}

/// Assembles `diagnostics` (§5) for a report: the app, the phone, the moment,
/// the recent errors and a scrubbed log.
///
/// Everything here is read at the moment the report is built, not remembered
/// from earlier — a report about a sync that is failing *now* should say how
/// many recordings are waiting *now*.
enum DiagnosticsCollector {
    /// How far back the log is read. The log store holds much more than this
    /// in a long-running process, and reading it all is slow; the half hour
    /// before a report is where the explanation is.
    private static let logWindow: TimeInterval = 30 * 60

    static func collect(
        context: FeedbackDiagnostics.Context?, includeLog: Bool, crash: JSONValue? = nil
    ) async -> FeedbackDiagnostics {
        let phone = await MainActor.run { phoneContext() }
        let log = includeLog ? await Task.detached(priority: .utility) { readLog() }.value : nil
        let errors = DiagnosticsJournal.entries
        return FeedbackDiagnostics(
            app: .init(
                version: ParleyClientIdentity.appVersion, build: ParleyClientIdentity.appBuild),
            os: .init(name: "iOS", version: phone.osVersion),
            device: .init(
                model: deviceModel(), locale: Locale.current.identifier(.bcp47),
                timezone: TimeZone.current.identifier),
            context: (context ?? .init()).merging(phone.context),
            recentErrors: errors.isEmpty ? nil : errors,
            log: log.flatMap { $0.isEmpty ? nil : $0 },
            crash: crash)
    }

    private struct Phone {
        let osVersion: String
        let context: FeedbackDiagnostics.Context
    }

    @MainActor
    private static func phoneContext() -> Phone {
        Phone(
            osVersion: UIDevice.current.systemVersion,
            context: .init(
                audioRoute: audioRoute(),
                micPermission: micPermission(),
                syncPendingCount: MeetingUploader.pendingCount,
                syncLastError: MeetingUploader.lastSyncErrorCode ?? DiagnosticsJournal.entries
                    .last(where: { $0.code.hasPrefix("sync_") })?.code,
                signedIn: KeychainStore.get(AppState.tokenKey) != nil))
    }

    /// `iPhone15,2`, the identifier a crash log and Apple's device list use —
    /// not the marketing name, which is a lookup table this app would have to
    /// keep current. The simulator reports its host's architecture as the
    /// machine, so it is asked for the model it is pretending to be.
    static func deviceModel() -> String {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] {
            return simulated
        }
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
    }

    /// Where the microphone would be listening from. Inputs first — that is the
    /// question — and outputs when the session is inactive and reports no
    /// input at all, which is most of the time a report is sent: a route with
    /// A2DP out is a route whose microphone is the phone's own.
    static func audioRoute() -> String {
        let route = AVAudioSession.sharedInstance().currentRoute
        if let input = route.inputs.first?.portType {
            switch input {
            case .builtInMic: return "builtInMic"
            case .bluetoothHFP: return "bluetoothHFP"
            case .headsetMic, .lineIn: return "wired"
            case .usbAudio: return "usb"
            default: return "other"
            }
        }
        switch route.outputs.first?.portType {
        case .bluetoothA2DP?: return "bluetoothA2DP"
        case .bluetoothHFP?: return "bluetoothHFP"
        case .headphones?, .lineOut?: return "wired"
        case .usbAudio?: return "usb"
        case .builtInSpeaker?, .builtInReceiver?: return "builtInMic"
        default: return "other"
        }
    }

    static func micPermission() -> String {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return "granted"
        case .denied: return "denied"
        default: return "undetermined"
        }
    }

    /// This process's own log, filtered to our subsystem and the reportable
    /// categories, scrubbed, newest last. Off the main thread: `OSLogStore`
    /// walks the whole store and can take the better part of a second.
    ///
    /// `.currentProcessIdentifier` is the only scope an iOS app is allowed, and
    /// it is also the right one: it cannot reach the keyboard extension, which
    /// is a separate process, nor any other app.
    private static func readLog() -> String {
        guard let store = try? OSLogStore(scope: .currentProcessIdentifier) else { return "" }
        let since = store.position(date: Date().addingTimeInterval(-logWindow))
        let predicate = NSPredicate(format: "subsystem == %@", ParleyLog.subsystem)
        guard let entries = try? store.getEntries(at: since, matching: predicate) else { return "" }
        let lines = entries.compactMap { entry -> DiagnosticLogEntry? in
            guard let log = entry as? OSLogEntryLog else { return nil }
            return DiagnosticLogEntry(
                date: log.date, subsystem: log.subsystem, category: log.category,
                level: level(log.level), message: log.composedMessage)
        }
        return DiagnosticLogFormatter.format(lines)
    }

    private static func level(_ level: OSLogEntryLog.Level) -> String {
        switch level {
        case .debug: return "debug"
        case .info: return "info"
        case .notice: return "notice"
        case .error: return "error"
        case .fault: return "fault"
        default: return "log"
        }
    }
}
