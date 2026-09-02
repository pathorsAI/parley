import XCTest

@testable import ParleyKit

final class FeatureFlagsTests: XCTestCase {
    private func decode(_ json: String) throws -> FeatureFlags {
        try JSONDecoder().decode(FeatureFlags.self, from: Data(json.utf8))
    }

    /// The state the fleet is in until the endpoint exists. It has to decode to
    /// "no opinion" rather than throw: a throw is indistinguishable from the
    /// server being down, and the caller's response to that is to keep the
    /// cache — so a throwing empty document would freeze every device on
    /// whatever it last saw.
    func testAnEmptyDocumentIsTheCompiledDefault() throws {
        XCTAssertEqual(try decode("{}"), FeatureFlags())
    }

    func testAnUnknownSectionIsIgnored() throws {
        XCTAssertEqual(try decode(#"{"somethingElse": {"x": 1}}"#), FeatureFlags())
    }

    func testAPartialHostReturnSectionKeepsTheRestAtDefault() throws {
        let flags = try decode(#"{"hostReturn": {"enabled": false}}"#)
        XCTAssertEqual(flags.hostReturn.enabled, false)
        XCTAssertNil(flags.hostReturn.byOSVersion)
        XCTAssertEqual(flags.hostReturn.effectiveFailureBudget, 2)
    }

    func testTheFullDocumentRoundTrips() throws {
        let flags = try decode(
            #"{"hostReturn": {"enabled": true, "byOSVersion": {"26.4": false}, "failureBudget": 3}}"#
        )
        XCTAssertEqual(flags.hostReturn.enabled, true)
        XCTAssertEqual(flags.hostReturn.byOSVersion, ["26.4": false])
        XCTAssertEqual(flags.hostReturn.effectiveFailureBudget, 3)

        let encoded = try JSONEncoder().encode(flags)
        XCTAssertEqual(try JSONDecoder().decode(FeatureFlags.self, from: encoded), flags)
    }
}

final class FeatureFlagStoreTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
        try super.tearDownWithError()
    }

    func testNothingCachedIsTheCompiledDefault() {
        XCTAssertEqual(FeatureFlagStore(containerURL: directory).load(), FeatureFlags())
    }

    func testWhatIsSavedIsWhatIsLoaded() {
        let store = FeatureFlagStore(containerURL: directory)
        let flags = FeatureFlags(hostReturn: .init(enabled: false, failureBudget: 5))
        store.save(flags)
        XCTAssertEqual(store.load(), flags)
    }

    /// A half-written or hand-mangled file must not take dictation down with
    /// it — the cache is an optimisation, and the compiled default is always a
    /// valid answer.
    func testCorruptCacheFallsBackRatherThanThrowing() throws {
        let store = FeatureFlagStore(containerURL: directory)
        try Data("not json".utf8)
            .write(to: directory.appendingPathComponent("feature-flags.json"))
        XCTAssertEqual(store.load(), FeatureFlags())
    }

    /// Previews, tests, and any build where the App Group entitlement is
    /// missing. Reads and writes are no-ops rather than crashes.
    func testNoContainerIsSurvivable() {
        let store = FeatureFlagStore(containerURL: nil)
        store.save(FeatureFlags(hostReturn: .init(enabled: false)))
        XCTAssertEqual(store.load(), FeatureFlags())
    }
}
