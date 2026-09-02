import Foundation

/// Server-controlled switches for behaviour we cannot decide correctly at build
/// time.
///
/// There is exactly one of these today and it is the reason the file exists:
/// the private jump back to the host app (`HostReturn`). That path is built on
/// undocumented AppKit/UIKit internals, which means two things a shipped binary
/// cannot cope with on its own:
///
/// 1. **We can be wrong about where it works.** The gate it replaces was
///    `#available(iOS 26.4, *)`, written when the reports said Apple had closed
///    the door in 26.4. Devices on 26.5 are observably still being returned to
///    their host app by other keyboards in the category, so the gate was
///    turning off a path that works. A compiled-in answer to "does this iOS
///    still allow it" is a guess that takes a full App Store release to correct.
/// 2. **We may need it off in a hurry.** A private-API path is the kind of
///    thing App Review can object to under 2.5.1 after the fact. Being able to
///    stop attempting it without shipping a build is worth more than any
///    cleverness in the path itself.
///
/// ## Fail-safe, in both directions
///
/// Nothing here is allowed to break dictation. Every read is synchronous and
/// comes from a local cache; the network only ever *updates* that cache, out of
/// band. A device that has never reached the server, or reaches a server with
/// no flag document published, uses `FeatureFlags()` — the compiled defaults,
/// which is the behaviour as if this file did not exist.
public struct FeatureFlags: Codable, Sendable, Equatable {
    public var hostReturn: HostReturn

    /// How the jump back to the host app is allowed to behave.
    ///
    /// Three fields, deliberately of decreasing bluntness — see
    /// `HostReturnPolicy.decide` for the order they are consulted in.
    public struct HostReturn: Codable, Sendable, Equatable {
        /// The kill switch. `false` stops every attempt on every device,
        /// whatever else says otherwise, and is the field to reach for if
        /// Review objects. `nil` — the normal state — means "no opinion",
        /// **not** "off".
        public var enabled: Bool?

        /// Per-OS override, keyed `"major.minor"` (`"26.4"`, `"26.5"`). This is
        /// how a specific iOS is turned off without disabling the feature, and
        /// equally how one is turned back *on* after devices there have given
        /// up on their own (a `true` here outranks the local failure ledger,
        /// which is the only way to re-arm a fleet remotely).
        public var byOSVersion: [String: Bool]?

        /// How many consecutive failed attempts on one OS build before a device
        /// stops trying and goes straight to the swipe-back guidance. Clamped
        /// to at least 1: a budget of 0 would be `enabled: false` said in a
        /// confusing way.
        public var failureBudget: Int?

        public init(
            enabled: Bool? = nil, byOSVersion: [String: Bool]? = nil,
            failureBudget: Int? = nil
        ) {
            self.enabled = enabled
            self.byOSVersion = byOSVersion
            self.failureBudget = failureBudget
        }

        public var effectiveFailureBudget: Int { max(1, failureBudget ?? 2) }
    }

    public init(hostReturn: HostReturn = .init()) {
        self.hostReturn = hostReturn
    }

    /// Decoding never fails on a missing section. A flag document that only
    /// mentions some future feature must leave `hostReturn` at its default
    /// rather than throwing, because a throw here is indistinguishable from
    /// "the server is down" and would quietly freeze the fleet on whatever was
    /// cached.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hostReturn = try container.decodeIfPresent(HostReturn.self, forKey: .hostReturn) ?? .init()
    }
}

/// The cached copy of `FeatureFlags`, in the App Group so the keyboard
/// extension can read the same answer the app acts on.
///
/// A file rather than `UserDefaults` for the same reason `DictationChannel`
/// uses files: a single writer, an atomic write, and a reader that can be
/// killed at any moment and still find the last good value.
public struct FeatureFlagStore: Sendable {
    /// `nil` when the App Group is unavailable (it never is in the shipped app,
    /// but it is in tests and in previews). Everything degrades to the
    /// compiled defaults rather than to a crash.
    private let containerURL: URL?
    private let fileName = "feature-flags.json"

    public init(containerURL: URL?) {
        self.containerURL = containerURL
    }

    public static let shared = FeatureFlagStore(
        containerURL: FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: DictationChannel.appGroup))

    private var url: URL? { containerURL?.appendingPathComponent(fileName) }

    /// The flags to act on right now. Synchronous and total: no network, no
    /// throwing, and compiled defaults when there is nothing cached.
    public func load() -> FeatureFlags {
        guard let url, let data = try? Data(contentsOf: url),
            let flags = try? JSONDecoder().decode(FeatureFlags.self, from: data)
        else { return FeatureFlags() }
        return flags
    }

    public func save(_ flags: FeatureFlags) {
        guard let url, let data = try? JSONEncoder().encode(flags) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
