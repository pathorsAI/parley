import Foundation

/// What the phone remembers about announcements: which ones it is done with.
///
/// "Seen" means *never show this one here*, whether the user actually read it
/// (dismissed the sheet), it was superseded by a newer one that was shown
/// instead, or the phone was a fresh install when it arrived. The three are not
/// told apart because nothing downstream would treat them differently.
public struct AnnouncementState: Codable, Equatable, Sendable {
    public var seen: Set<String>

    public init(seen: Set<String> = []) {
        self.seen = seen
    }
}

/// Whether the phone shows an announcement, and which — as pure rules over
/// values, so they can be tested with `swift test` on a Mac (the app target has
/// no test target of its own). The app's `AnnouncementStore` persists the state
/// and `WhatsNewPresenter` decides *when* it may ask; this decides *what* the
/// answer is.
///
/// ## The rules
///
/// 1. **A fresh install never sees one.** "What's new" is a sentence addressed
///    to someone who knew what was there before. The first launch of a build
///    that has no stored announcement state asks the Keychain whether a session
///    token is already there (`initial(bundled:hadStoredSession:)`): if it is,
///    the user signed in under an earlier build and is upgrading; if not, every
///    announcement in the bundle is marked seen on the spot, and a later
///    sign-in changes nothing — the same reasoning, and the same timing
///    constraint, as `GettingStartedState.initial`.
/// 2. **Only what this version actually ships.** `ships.ios` must be set and at
///    most the running version (`AppVersion`, numeric by component). An entry
///    committed ahead of its release sits in the bundle doing nothing, and one
///    with `ios: null` is another platform's news.
/// 3. **Only for its audience.** `.keyboard` needs the keyboard to have been
///    used on this phone; an audience this build does not know is unmet.
/// 4. **One sheet, the newest.** Several unseen at once — someone skipped a
///    few releases — shows only the newest (highest `ships.ios`, then the
///    later id), and the older ones are retired alongside it: the user has
///    been told what is new *now*, and a queue of stale sheets on the following
///    launches would be the app talking about itself for a week.
///
/// An announcement whose audience is unmet is left alone rather than retired:
/// if the user picks up the keyboard later, the sheet about the keyboard is
/// still waiting — unless something newer has been shown in the meantime,
/// which retires it with the rest.
public enum AnnouncementGate {

    /// What the store should do right now.
    public struct Decision: Equatable, Sendable {
        /// The one to present, if any.
        public var show: Announcement?
        /// What to mark seen *when `show` is dismissed*: `show` itself and every
        /// older released announcement it supersedes. Empty when nothing shows.
        public var retire: Set<String>

        public init(show: Announcement? = nil, retire: Set<String> = []) {
            self.show = show
            self.retire = retire
        }

        public static let nothing = Decision()
    }

    /// The state the phone starts with the first time a build that has
    /// announcements runs.
    ///
    /// `hadStoredSession` is whether the Keychain already held a session token
    /// before anything in this launch could have written one — an existing user
    /// updating. Anyone else is a new install and starts with every bundled
    /// announcement already behind them, including ones for versions later than
    /// this build: those are in the bundle too and were written about a version
    /// this person will also have been a new user of.
    public static func initial(bundled: [Announcement], hadStoredSession: Bool) -> AnnouncementState {
        hadStoredSession ? AnnouncementState() : AnnouncementState(seen: Set(bundled.map(\.id)))
    }

    /// The decision for this launch.
    ///
    /// - Parameters:
    ///   - announcements: what the bundle carries.
    ///   - state: what the phone has already seen.
    ///   - appVersion: the running build's `CFBundleShortVersionString`. One
    ///     that cannot be read shows nothing.
    ///   - keyboardUsed: whether the Parley keyboard has been used here.
    public static func decide(
        announcements: [Announcement], state: AnnouncementState, appVersion: String,
        keyboardUsed: Bool
    ) -> Decision {
        guard let running = AppVersion(appVersion) else { return .nothing }

        // Released on iOS, in this version or earlier, and not yet behind us.
        let released: [(Announcement, AppVersion)] = announcements.compactMap { item in
            guard !state.seen.contains(item.id),
                let raw = item.ships.ios, let ships = AppVersion(raw), ships <= running
            else { return nil }
            return (item, ships)
        }

        let candidates = released.filter {
            audienceMet($0.0.audience ?? .all, keyboardUsed: keyboardUsed)
        }
        guard
            let newest = candidates.max(by: { a, b in
                a.1 == b.1 ? a.0.id < b.0.id : a.1 < b.1
            })
        else { return .nothing }

        // Everything released that the newest one outranks, audience or not.
        let retired = released.filter { item, ships in
            ships < newest.1 || (ships == newest.1 && item.id < newest.0.id)
        }
        return Decision(show: newest.0, retire: Set(retired.map(\.0.id)).union([newest.0.id]))
    }

    public static func audienceMet(_ audience: AnnouncementAudience, keyboardUsed: Bool) -> Bool {
        switch audience {
        case .all: return true
        case .keyboard: return keyboardUsed
        case .unknown: return false
        }
    }
}
