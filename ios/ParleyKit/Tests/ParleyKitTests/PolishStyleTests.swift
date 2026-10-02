import XCTest

@testable import ParleyKit

/// The polish style choice, and the migration from the on/off switch it
/// replaced. The rule being pinned: nobody's polish changes behind their back —
/// off stays off, on becomes exactly what "on" used to do (tidy), and someone
/// who never touched the switch gets the same default they had.
final class PolishStyleTests: XCTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "PolishStyleTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    // MARK: the stored format

    /// The raw values are stored in `UserDefaults`, in the history file, and
    /// by the desktop under the same names. Renaming one silently resets
    /// everyone who chose it.
    func testRawValuesAreTheStoredFormat() {
        XCTAssertEqual(PolishStyle.allCases.map(\.rawValue), ["off", "tidy", "concise"])
        XCTAssertEqual(PolishStyle.default, .tidy)
        XCTAssertEqual(PolishStyle.storageKey, "dictationPolishStyle")
        XCTAssertEqual(PolishStyle.legacyEnabledKey, "dictationPolishEnabled")
    }

    func testOnlyOffSkipsThePolish() {
        XCTAssertFalse(PolishStyle.off.polishes)
        XCTAssertTrue(PolishStyle.tidy.polishes)
        XCTAssertTrue(PolishStyle.concise.polishes)
    }

    // MARK: resolve — the mapping

    func testAStoredStyleWinsOverTheOldSwitch() {
        XCTAssertEqual(PolishStyle.resolve(stored: "concise", legacyEnabled: false), .concise)
        XCTAssertEqual(PolishStyle.resolve(stored: "off", legacyEnabled: true), .off)
        XCTAssertEqual(PolishStyle.resolve(stored: "tidy", legacyEnabled: nil), .tidy)
    }

    func testTheOldSwitchMapsOffToOffAndOnToTidy() {
        XCTAssertEqual(PolishStyle.resolve(stored: nil, legacyEnabled: false), .off)
        XCTAssertEqual(PolishStyle.resolve(stored: nil, legacyEnabled: true), .tidy)
    }

    func testNeverTouchedIsTidy() {
        XCTAssertEqual(PolishStyle.resolve(stored: nil, legacyEnabled: nil), .tidy)
    }

    /// A value a later build wrote (and this one does not know) falls back to
    /// the old switch rather than to a crash or to "off".
    func testAnUnknownStoredValueFallsBackToTheOldSwitch() {
        XCTAssertEqual(PolishStyle.resolve(stored: "shouty", legacyEnabled: nil), .tidy)
        XCTAssertEqual(PolishStyle.resolve(stored: "shouty", legacyEnabled: false), .off)
    }

    // MARK: current — reading UserDefaults

    func testCurrentReadsTheOldSwitchBeforeMigrating() {
        defaults.set(false, forKey: PolishStyle.legacyEnabledKey)
        XCTAssertEqual(PolishStyle.current(in: defaults), .off)
        defaults.set(true, forKey: PolishStyle.legacyEnabledKey)
        XCTAssertEqual(PolishStyle.current(in: defaults), .tidy)
    }

    func testCurrentReadsTheNewKey() {
        defaults.set("concise", forKey: PolishStyle.storageKey)
        XCTAssertEqual(PolishStyle.current(in: defaults), .concise)
    }

    func testCurrentDefaultsToTidyOnACleanInstall() {
        XCTAssertEqual(PolishStyle.current(in: defaults), .tidy)
    }

    // MARK: migrateLegacySetting — writing the new key once

    func testMigratingAnOffSwitchWritesOff() {
        defaults.set(false, forKey: PolishStyle.legacyEnabledKey)
        PolishStyle.migrateLegacySetting(in: defaults)
        XCTAssertEqual(defaults.string(forKey: PolishStyle.storageKey), "off")
    }

    func testMigratingAnOnSwitchWritesTidy() {
        defaults.set(true, forKey: PolishStyle.legacyEnabledKey)
        PolishStyle.migrateLegacySetting(in: defaults)
        XCTAssertEqual(defaults.string(forKey: PolishStyle.storageKey), "tidy")
    }

    /// The old key is left alone: a build from before the choice existed reads
    /// it after a downgrade.
    func testMigratingLeavesTheOldSwitchInPlace() {
        defaults.set(false, forKey: PolishStyle.legacyEnabledKey)
        PolishStyle.migrateLegacySetting(in: defaults)
        XCTAssertEqual(defaults.object(forKey: PolishStyle.legacyEnabledKey) as? Bool, false)
    }

    func testMigratingANeverTouchedSwitchWritesNothing() {
        PolishStyle.migrateLegacySetting(in: defaults)
        XCTAssertNil(defaults.object(forKey: PolishStyle.storageKey))
        XCTAssertEqual(PolishStyle.current(in: defaults), .tidy)
    }

    /// Once someone has chosen a style, a stale old switch must not overwrite
    /// it on the next launch.
    func testMigratingNeverOverwritesAChosenStyle() {
        defaults.set("concise", forKey: PolishStyle.storageKey)
        defaults.set(false, forKey: PolishStyle.legacyEnabledKey)
        PolishStyle.migrateLegacySetting(in: defaults)
        XCTAssertEqual(defaults.string(forKey: PolishStyle.storageKey), "concise")
    }
}
