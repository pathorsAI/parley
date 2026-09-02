import Foundation

/// Whether to attempt the private jump back to the host app — and, when the
/// answer is no, which of the four reasons it was.
///
/// ## Why this is not a version check any more
///
/// It used to be `if #available(iOS 26.4, *) { return false }`, written from the
/// reports that Apple closed the host-return path in 26.4. Two things were
/// wrong with that, and only one of them was the version number:
///
/// - **The number was probably wrong.** Keyboards in the same category are
///   observably still returning users to their host app on iPadOS 26.5. A
///   blanket "26.4 and up: no" was switching off a path that works.
/// - **A compiled-in answer cannot be corrected.** Whatever number we picked,
///   getting it wrong in either direction costs an App Store release — and the
///   ground truth moves with every iOS point update, in both directions.
///
/// So the decision moved to runtime and is made from three inputs, none of
/// which is a guess about the future: a remote flag we control, evidence this
/// device has collected about itself, and the OS version as a *key* rather than
/// as a threshold.
///
/// ## The order, and why it is this order
///
/// 1. `enabled == false` — the kill switch. Nothing outranks it; it exists to
///    be usable in an App Review emergency without a build.
/// 2. `byOSVersion["26.5"]` — a targeted answer for one iOS. `false` turns that
///    version off; `true` turns it on **and overrides the ledger**, which is
///    the only way to re-arm devices that have already given up locally.
/// 3. The ledger — this device has attempted and failed `failureBudget` times
///    in a row on this exact OS build, so stop paying the user for the
///    experiment.
/// 4. Otherwise: attempt. Optimism is the default because a failed attempt is
///    silent and cheap, and because pessimism is what produced the bug.
///
/// ## Optimism has to be bounded, and the ledger is the bound
///
/// An attempt that fails costs the user roughly a second of a screen saying
/// they are about to be sent back, before it changes its mind and asks them to
/// swipe. That is a fine price to pay once to *find out*, and a bad one to pay
/// on every dictation forever. The ledger keys on the full OS build string, so
/// the budget refills when the device updates — which is exactly when the
/// answer might have changed, and is how a fleet recovers on its own if Apple
/// puts the path back.
public enum HostReturnPolicy {
    public enum Decision: Equatable, Sendable {
        case attempt
        case skip(Reason)

        public var isAttempt: Bool { self == .attempt }
    }

    public enum Reason: String, Equatable, Sendable {
        /// The keyboard could not read the host's bundle id, so there is no
        /// destination to jump to. Checked first because it is the only reason
        /// that is about this session rather than about the installation.
        case noHost
        /// The remote kill switch is off.
        case remotelyDisabled
        /// Remotely disabled for this iOS version specifically.
        case disabledForThisOS
        /// This OS build has spent its failure budget on this device.
        case budgetSpent
    }

    public static func decide(
        host: String?,
        flags: FeatureFlags.HostReturn,
        consecutiveFailures: Int,
        osVersion: String
    ) -> Decision {
        guard let host, !host.isEmpty else { return .skip(.noHost) }
        if flags.enabled == false { return .skip(.remotelyDisabled) }
        if let forThisOS = flags.byOSVersion?[osVersion] {
            return forThisOS ? .attempt : .skip(.disabledForThisOS)
        }
        if consecutiveFailures >= flags.effectiveFailureBudget { return .skip(.budgetSpent) }
        return .attempt
    }

    /// `"26.5"` — the key `byOSVersion` is written against. Deliberately
    /// major.minor: patch releases are not where this behaviour changes, and a
    /// flag document listing every build would be unmaintainable.
    public static func osVersionKey(_ version: OperatingSystemVersion) -> String {
        "\(version.majorVersion).\(version.minorVersion)"
    }
}

/// What this device has learned about whether the jump actually lands.
///
/// The whole point of the class is that it is *evidence*, not a prediction: the
/// app attempts the jump, watches whether it got backgrounded, and writes down
/// what happened. That is the only source of truth that stays correct across an
/// iOS release nobody has tested yet.
///
/// Keyed on the full OS build string (`"Version 26.5 (Build 23F79)"`), so an OS
/// update resets the count to zero and the device tries again by itself.
/// `@unchecked` for `UserDefaults` alone, which Apple documents as thread-safe
/// but has never marked `Sendable`. Nothing else here is mutable state.
public struct HostReturnLedger: @unchecked Sendable {
    private let defaults: UserDefaults?
    private let osBuild: String

    private var buildKey: String { "hostReturn.ledger.build" }
    private var failuresKey: String { "hostReturn.ledger.failures" }

    public init(defaults: UserDefaults?, osBuild: String) {
        self.defaults = defaults
        self.osBuild = osBuild
    }

    public static let shared = HostReturnLedger(
        defaults: UserDefaults(suiteName: DictationChannel.appGroup),
        osBuild: ProcessInfo.processInfo.operatingSystemVersionString)

    /// Failures in a row on this OS build. A different build than the one on
    /// record reads as zero — the update is the reset.
    public func consecutiveFailures() -> Int {
        guard let defaults, defaults.string(forKey: buildKey) == osBuild else { return 0 }
        return defaults.integer(forKey: failuresKey)
    }

    /// The jump landed: the app went to the background. Clears the count so a
    /// device that works keeps working even after an unrelated bad run.
    public func recordSuccess() {
        defaults?.set(osBuild, forKey: buildKey)
        defaults?.set(0, forKey: failuresKey)
    }

    /// The jump did not land: the app was still in the foreground when the
    /// grace period expired.
    public func recordFailure() {
        let next = consecutiveFailures() + 1
        defaults?.set(osBuild, forKey: buildKey)
        defaults?.set(next, forKey: failuresKey)
    }
}
