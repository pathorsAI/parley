import XCTest

@testable import ParleyKit

private let anyHost = "com.apple.MobileSMS"

final class HostReturnPolicyTests: XCTestCase {
    private func decide(
        host: String? = anyHost,
        _ flags: FeatureFlags.HostReturn = .init(),
        failures: Int = 0,
        os: String = "26.5"
    ) -> HostReturnPolicy.Decision {
        HostReturnPolicy.decide(
            host: host, flags: flags, consecutiveFailures: failures, osVersion: os)
    }

    // MARK: the default is to try

    /// The bug this whole change exists for: a stock device on a brand-new iOS
    /// used to be refused by a compiled-in version check. It now tries.
    func testAFreshDeviceOnAnUnknownOSAttempts() {
        XCTAssertEqual(decide(), .attempt)
    }

    func testNoHostIsTheOnlyReasonCheckedBeforeTheFlags() {
        XCTAssertEqual(decide(host: nil, .init(enabled: true)), .skip(.noHost))
        XCTAssertEqual(decide(host: "", .init(enabled: true)), .skip(.noHost))
    }

    // MARK: the kill switch

    func testTheKillSwitchStopsEverything() {
        XCTAssertEqual(decide(.init(enabled: false)), .skip(.remotelyDisabled))
    }

    /// The switch has to outrank the per-OS override, or "turn it off
    /// everywhere" would silently spare whichever versions were listed — the
    /// exact moment that guarantee has to hold is an App Review emergency.
    func testTheKillSwitchOutranksAPerOSOptIn() {
        let flags = FeatureFlags.HostReturn(enabled: false, byOSVersion: ["26.5": true])
        XCTAssertEqual(decide(flags), .skip(.remotelyDisabled))
    }

    /// `nil` is "no opinion", not "off". A flag document that has never
    /// mentioned host-return must not disable it.
    func testAnAbsentEnabledFlagIsNotAnOff() {
        XCTAssertEqual(decide(.init(enabled: nil)), .attempt)
    }

    // MARK: per-OS override

    func testAnOSCanBeTurnedOff() {
        let flags = FeatureFlags.HostReturn(byOSVersion: ["26.4": false])
        XCTAssertEqual(decide(flags, os: "26.4"), .skip(.disabledForThisOS))
        XCTAssertEqual(decide(flags, os: "26.5"), .attempt)
    }

    /// The remote re-arm. Devices that gave up locally are only reachable
    /// through this, so a `true` here has to beat a spent budget.
    func testAPerOSOptInOverridesASpentBudget() {
        let flags = FeatureFlags.HostReturn(byOSVersion: ["26.5": true])
        XCTAssertEqual(decide(flags, failures: 99, os: "26.5"), .attempt)
    }

    // MARK: the ledger's budget

    func testTheBudgetIsSpentOnlyOnceItIsReached() {
        let flags = FeatureFlags.HostReturn(failureBudget: 2)
        XCTAssertEqual(decide(flags, failures: 1), .attempt)
        XCTAssertEqual(decide(flags, failures: 2), .skip(.budgetSpent))
        XCTAssertEqual(decide(flags, failures: 3), .skip(.budgetSpent))
    }

    func testTheDefaultBudgetIsTwo() {
        XCTAssertEqual(decide(failures: 1), .attempt)
        XCTAssertEqual(decide(failures: 2), .skip(.budgetSpent))
    }

    /// A budget of zero would mean "never attempt", which is `enabled: false`
    /// said in a way nobody would read as a kill switch. Clamped so the two
    /// controls stay distinguishable.
    func testAZeroBudgetIsClampedRatherThanBeingASecretKillSwitch() {
        XCTAssertEqual(FeatureFlags.HostReturn(failureBudget: 0).effectiveFailureBudget, 1)
        XCTAssertEqual(FeatureFlags.HostReturn(failureBudget: -5).effectiveFailureBudget, 1)
        XCTAssertEqual(decide(.init(failureBudget: 0), failures: 0), .attempt)
        XCTAssertEqual(decide(.init(failureBudget: 0), failures: 1), .skip(.budgetSpent))
    }

    // MARK: the version key

    func testTheOSKeyIsMajorMinor() {
        let version = OperatingSystemVersion(majorVersion: 26, minorVersion: 5, patchVersion: 1)
        XCTAssertEqual(HostReturnPolicy.osVersionKey(version), "26.5")
    }
}

final class HostReturnLedgerTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "parley.tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    private func makeLedger(build: String = "Version 26.5 (Build 23F79)") -> HostReturnLedger {
        HostReturnLedger(defaults: defaults, osBuild: build)
    }

    func testAFreshLedgerHasNoFailures() {
        XCTAssertEqual(makeLedger().consecutiveFailures(), 0)
    }

    func testFailuresAccumulate() {
        let subject = makeLedger()
        subject.recordFailure()
        subject.recordFailure()
        XCTAssertEqual(subject.consecutiveFailures(), 2)
    }

    func testASuccessClearsTheCount() {
        let subject = makeLedger()
        subject.recordFailure()
        subject.recordFailure()
        subject.recordSuccess()
        XCTAssertEqual(subject.consecutiveFailures(), 0)
    }

    /// The self-healing property. An OS update is the one event that can change
    /// the answer, so it is the event that refills the budget — without it a
    /// device that gave up on 26.4 would still be giving up on 27.
    func testAnOSUpdateResetsTheCount() {
        let before = makeLedger(build: "Version 26.4 (Build 23E200)")
        before.recordFailure()
        before.recordFailure()
        XCTAssertEqual(before.consecutiveFailures(), 2)

        let after = makeLedger(build: "Version 26.5 (Build 23F79)")
        XCTAssertEqual(after.consecutiveFailures(), 0)
    }

    /// One slot, holding the most recent build. A count is only ever read back
    /// by the build that wrote it — anything else, including a downgrade, reads
    /// zero and gets a fresh budget. Keeping a count per build would be a
    /// dictionary that only ever grows, to answer a question ("how did 26.4 do,
    /// three updates ago") nothing asks.
    func testTheCountBelongsToTheBuildThatWroteIt() {
        makeLedger(build: "A").recordFailure()
        XCTAssertEqual(makeLedger(build: "B").consecutiveFailures(), 0)
        makeLedger(build: "B").recordFailure()
        XCTAssertEqual(makeLedger(build: "B").consecutiveFailures(), 1)
        XCTAssertEqual(makeLedger(build: "A").consecutiveFailures(), 0)
    }

    /// No App Group — previews, tests, a build missing the entitlement. Reads
    /// and writes are no-ops rather than crashes.
    func testNoDefaultsIsZeroRatherThanACrash() {
        let orphan = HostReturnLedger(defaults: nil, osBuild: "A")
        orphan.recordFailure()
        XCTAssertEqual(orphan.consecutiveFailures(), 0)
    }
}
