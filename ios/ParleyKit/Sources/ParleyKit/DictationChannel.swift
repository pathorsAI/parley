import Foundation

/// The shared channel between the Parley keyboard extension and the container
/// app. A keyboard extension cannot open the microphone (iOS forbids it since
/// iOS 8, Full Access included), so dictation runs in the app and the transcript
/// is handed back through the App Group container.
///
/// Four single-writer mailboxes, each with its own Darwin notification, so the
/// two processes never contend on the same file:
///   - `downlink` (app → keyboard): the growing transcript + session state.
///   - `uplink`   (keyboard → app): the session request, host bundle id, stop.
///   - `window`   (app → keyboard): the microphone window — whether the next
///     tap will be served where the user is, or has to open Parley.
///   - `window control` (keyboard → app): end the window now.
///
/// The window pair is separate from the session pair on purpose: a window
/// outlives any one dictation and most of what it has to say happens when no
/// session exists at all.
///
/// Darwin notifications carry no payload — they are pure "go re-read" signals.
/// The files are the source of truth, which is what makes this robust to the
/// keyboard being suspended/killed while the app is foregrounded: whatever it
/// missed is still sitting in `downlink` when it comes back (see
/// `KeyboardViewController.drainPending`).
public enum DictationChannel {
    /// Must match the `com.apple.security.application-groups` entitlement on
    /// both the app and the keyboard target.
    public static let appGroup = "group.com.pathors.parley.ios"

    /// app → keyboard: the transcript grew or the state changed.
    public static let downNote = "com.pathors.parley.dictation.down"
    /// keyboard → app: stop was requested (the app is running during dictation,
    /// so a Darwin note reaches it; starting instead goes through the URL so it
    /// can launch a suspended app).
    public static let upNote = "com.pathors.parley.dictation.up"
    /// app → keyboard: the microphone window opened, closed, or ticked. Its own
    /// note rather than `downNote` because the window outlives sessions — most
    /// of what it announces happens when there is no downlink to speak of.
    public static let windowNote = "com.pathors.parley.dictation.window"
    /// keyboard → app: end the microphone window now.
    public static let windowControlNote = "com.pathors.parley.dictation.window-control"

    /// The URL the keyboard opens to start a session. The app routes this in
    /// `onOpenURL`. The session id round-trips so a stale downlink from a prior
    /// dictation is never mistaken for this one.
    public static func startURL(session: String) -> URL {
        URL(string: "parley://dictate?session=\(session)")!
    }

    public static func session(fromStart url: URL) -> String? {
        guard url.scheme == "parley", url.host == "dictate",
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        else { return nil }
        return items.first { $0.name == "session" }?.value
    }

    // MARK: downlink (app writes, keyboard reads)

    /// Live transcript state the keyboard renders and inserts.
    public struct Downlink: Codable, Sendable {
        public var session: String
        /// Settled text — everything the keyboard should have inserted by now.
        public var committed: String
        /// Tentative tail shown above the keys, never inserted.
        public var partial: String
        public var state: State
        public var errorMessage: String?
        /// When the app last wrote this file (stamped by `writeDownlink`).
        /// Optional so files written before the field existed still decode. The
        /// keyboard uses it to bound how long a finished session's tail is still
        /// worth inserting after a relaunch (see `KeyboardViewController`).
        public var updatedAt: Date?

        public enum State: String, Codable, Sendable {
            case starting, listening, finishing, done, error
            /// The relay socket dropped and the app is redialling it. The
            /// microphone is still open and the audio is being held, so this
            /// is a pause in the words arriving — deliberately not `error`,
            /// which is where the session actually ends.
            case reconnecting
        }

        public init(
            session: String, committed: String = "", partial: String = "",
            state: State = .starting, errorMessage: String? = nil,
            updatedAt: Date? = nil
        ) {
            self.session = session
            self.committed = committed
            self.partial = partial
            self.state = state
            self.errorMessage = errorMessage
            self.updatedAt = updatedAt
        }
    }

    public static func writeDownlink(_ value: Downlink) {
        var stamped = value
        stamped.updatedAt = Date()
        write(stamped, to: "dictation-down.json")
        post(downNote)
    }

    public static func readDownlink() -> Downlink? {
        read("dictation-down.json")
    }

    // MARK: uplink (keyboard writes, app reads)

    /// The keyboard's request to the app.
    public struct Uplink: Codable, Sendable {
        public var session: String
        /// The host app the keyboard was typing into, captured best-effort for
        /// the pre-iOS-26.4 auto-return. `nil` when it could not be resolved.
        public var hostBundleID: String?
        public var stopRequested: Bool
        /// How much of `committed` the keyboard has already inserted. Persisted
        /// here so a keyboard that was killed mid-session does not double-insert
        /// when it relaunches.
        public var insertedCount: Int

        public init(
            session: String, hostBundleID: String? = nil,
            stopRequested: Bool = false, insertedCount: Int = 0
        ) {
            self.session = session
            self.hostBundleID = hostBundleID
            self.stopRequested = stopRequested
            self.insertedCount = insertedCount
        }
    }

    public static func writeUplink(_ value: Uplink) {
        write(value, to: "dictation-up.json")
        post(upNote)
    }

    public static func readUplink() -> Uplink? {
        read("dictation-up.json")
    }

    // MARK: microphone window (app writes state, keyboard writes control)

    /// Publish the window the app is actually holding. Stamped on every write:
    /// the stamp is what lets the keyboard tell an open window from the file a
    /// killed process left behind (see `MicWindowState`).
    public static func writeWindow(_ value: MicWindowState) {
        var stamped = value
        stamped.updatedAt = Date()
        write(stamped, to: "dictation-window.json")
        post(windowNote)
    }

    public static func readWindow() -> MicWindowState? {
        read("dictation-window.json")
    }

    /// The keyboard asking for the window to end now.
    public static func writeWindowControl(_ value: MicWindowControl) {
        write(value, to: "dictation-window-control.json")
        post(windowControlNote)
    }

    public static func readWindowControl() -> MicWindowControl? {
        read("dictation-window-control.json")
    }

    public static func clear() {
        for name in [
            "dictation-down.json", "dictation-up.json",
            "dictation-window.json", "dictation-window-control.json",
        ] {
            if let url = container?.appendingPathComponent(name) {
                try? FileManager.default.removeItem(at: url)
            }
        }
    }

    // MARK: file plumbing

    private static var container: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    }

    private static func write<T: Encodable>(_ value: T, to name: String) {
        guard let url = container?.appendingPathComponent(name),
            let data = try? JSONEncoder().encode(value)
        else { return }
        try? data.write(to: url, options: .atomic)
    }

    private static func read<T: Decodable>(_ name: String) -> T? {
        guard let url = container?.appendingPathComponent(name),
            let data = try? Data(contentsOf: url)
        else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    // MARK: Darwin notifications

    public static func post(_ name: String) {
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(name as CFString), nil, nil, true)
    }
}

/// A live subscription to a Darwin notification. Darwin's C callback cannot
/// capture context, so the observer's `self` pointer is threaded through as the
/// observer argument and unwrapped in the (capture-free) trampoline. Keep the
/// instance alive for as long as you want the notification.
public final class DarwinObserver {
    private let name: String
    private let handler: () -> Void

    public init(_ name: String, handler: @escaping () -> Void) {
        self.name = name
        self.handler = handler
        let this = Unmanaged.passUnretained(self).toOpaque()
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            this,
            { _, observer, _, _, _ in
                guard let observer else { return }
                Unmanaged<DarwinObserver>.fromOpaque(observer)
                    .takeUnretainedValue().handler()
            },
            name as CFString, nil, .deliverImmediately)
    }

    deinit {
        CFNotificationCenterRemoveObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque(),
            CFNotificationName(name as CFString), nil)
    }
}
