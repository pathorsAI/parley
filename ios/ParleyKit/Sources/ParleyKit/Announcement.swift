import Foundation

/// One in-app "What's New" announcement, as written in `announcements/*.json`
/// at the repository root.
///
/// The folder is shared: the phone reads it today, and Android and the desktop
/// app are meant to read the very same files later, so a release's copy is
/// written once rather than three times and drifts in none of them. That is
/// why the version it ships in is *per platform* (`ships`) — the three apps
/// are released on their own schedules, and an announcement a platform never
/// gets says so with a `null` rather than by being absent from the folder.
/// See `announcements/README.md` for the schema and the rules around it.
///
/// Decoding is deliberately forgiving about the optional fields and strict
/// about nothing else: a new platform key, a new audience or a hero id this
/// build has never heard of must not stop an older build from reading the
/// file. What an older build does with a value it does not understand is
/// decided in `AnnouncementGate`, not here.
public struct Announcement: Codable, Equatable, Identifiable, Sendable {
    /// Stable and unique across the folder. By convention it starts with the
    /// month it shipped (`2026-10-polish-wave`), which also makes it a sensible
    /// tie-break when two announcements ship in the same version.
    public var id: String
    public var ships: Ships
    /// Absent means `.all`.
    public var audience: AnnouncementAudience?
    /// An id each platform looks up in its own native hero registry. Unknown
    /// or absent draws no hero — the sheet is complete without one.
    public var hero: String?
    public var cta: CallToAction?
    /// Keyed by locale: `zh-Hant` and `en`, both required (the test that reads
    /// the folder enforces it).
    public var copy: [String: Copy]

    public init(
        id: String, ships: Ships, audience: AnnouncementAudience? = nil, hero: String? = nil,
        cta: CallToAction? = nil, copy: [String: Copy]
    ) {
        self.id = id
        self.ships = ships
        self.audience = audience
        self.hero = hero
        self.cta = cta
        self.copy = copy
    }

    /// The version each platform ships it in. `nil` means never shown there.
    public struct Ships: Codable, Equatable, Sendable {
        public var ios: String?
        public var android: String?
        public var desktop: String?

        public init(ios: String? = nil, android: String? = nil, desktop: String? = nil) {
            self.ios = ios
            self.android = android
            self.desktop = desktop
        }
    }

    /// A per-platform deep link for the sheet's one button. `nil` means the
    /// button just closes the sheet.
    public struct CallToAction: Codable, Equatable, Sendable {
        public var ios: String?

        public init(ios: String? = nil) { self.ios = ios }
    }

    /// Everything the sheet says, in one language.
    public struct Copy: Codable, Equatable, Sendable {
        /// The small line above the title — "1.22 更新" / "New in 1.22".
        public var badge: String
        public var title: String
        public var body: String
        /// The one-line "also changed" footnote under the divider.
        public var also: String
        /// The button's label.
        public var button: String

        public init(badge: String, title: String, body: String, also: String, button: String) {
            self.badge = badge
            self.title = title
            self.body = body
            self.also = also
            self.button = button
        }

        /// Every field, for the checks that have to hold for all of them.
        public var fields: [String] { [badge, title, body, also, button] }
    }

    /// The two locales every announcement carries.
    public static let traditionalChinese = "zh-Hant"
    public static let english = "en"

    /// The copy for a UI language, as the app resolves it
    /// (`Bundle.main.preferredLocalizations.first`): Traditional Chinese for
    /// any `zh` localization — the app ships no Simplified, so a `zh` UI *is*
    /// the Traditional one — and English for everything else. Falls back to
    /// English if the file is missing the Chinese, so a half-written entry
    /// shows the wrong language rather than nothing.
    public func copy(forLocalization localization: String) -> Copy? {
        let key = localization.hasPrefix("zh") ? Self.traditionalChinese : Self.english
        return copy[key] ?? copy[Self.english]
    }
}

/// Who an announcement is for.
///
/// A string on disk and an enum here, with a catch-all: a future file may name
/// an audience this build predates, and the right thing for an older build to
/// do with a condition it cannot evaluate is to treat it as unmet — never to
/// decode-fail the whole folder, and never to show the announcement to
/// everyone.
public enum AnnouncementAudience: Codable, Equatable, Hashable, Sendable {
    /// Everyone upgrading.
    case all
    /// Only people who have used the Parley keyboard on this device.
    case keyboard
    case unknown(String)

    public init(rawValue: String) {
        switch rawValue {
        case "all": self = .all
        case "keyboard": self = .keyboard
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .all: return "all"
        case .keyboard: return "keyboard"
        case .unknown(let value): return value
        }
    }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// A marketing version (`CFBundleShortVersionString`), compared the way people
/// read it: component by component, numerically, with missing components as
/// zero. So `1.9 < 1.10` (a string compare gets that backwards) and
/// `1.22 == 1.22.0`.
///
/// A component that is not a number reads its leading digits (`"3-beta"` is
/// 3) and an empty one is 0. Only `init?` refuses, and only a string with no
/// digit anywhere in it — the caller then shows nothing, which is the only
/// safe reading of a version it cannot place.
public struct AppVersion: Comparable, CustomStringConvertible, Sendable {
    public let components: [Int]

    public init?(_ string: String) {
        let trimmed = string.trimmingCharacters(in: .whitespaces)
        guard trimmed.contains(where: \.isNumber) else { return nil }
        components = trimmed.split(separator: ".", omittingEmptySubsequences: false).map {
            Int($0.prefix(while: \.isNumber)) ?? 0
        }
    }

    public var description: String { components.map(String.init).joined(separator: ".") }

    private static func padded(_ a: [Int], _ b: [Int]) -> ([Int], [Int]) {
        let count = max(a.count, b.count)
        return (
            a + Array(repeating: 0, count: count - a.count),
            b + Array(repeating: 0, count: count - b.count)
        )
    }

    public static func == (lhs: AppVersion, rhs: AppVersion) -> Bool {
        let (a, b) = padded(lhs.components, rhs.components)
        return a == b
    }

    public static func < (lhs: AppVersion, rhs: AppVersion) -> Bool {
        let (a, b) = padded(lhs.components, rhs.components)
        return a.lexicographicallyPrecedes(b)
    }
}

/// Reads an `announcements/` folder: every `*.json` in it, in file-name order.
///
/// The app bundles the folder as a folder reference and the tests read the
/// repository copy through `#filePath`; both go through here so the two can
/// never disagree about what a valid file is.
public enum AnnouncementCatalog {
    /// Every announcement in the folder. A file that does not decode is
    /// skipped rather than taking the rest down with it — in a shipped build
    /// that is one missing sheet, not a missing feature; the test over the
    /// repository folder is what makes sure no such file is ever committed.
    public static func load(directory: URL) -> [Announcement] {
        let files =
            (try? FileManager.default.contentsOfDirectory(
                at: directory, includingPropertiesForKeys: nil)) ?? []
        return files
            .filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .compactMap { try? decode(Data(contentsOf: $0)) }
    }

    public static func decode(_ data: Data) throws -> Announcement {
        try JSONDecoder().decode(Announcement.self, from: data)
    }
}
