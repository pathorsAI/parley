import XCTest

@testable import ParleyKit

final class AnnouncementGateTests: XCTestCase {

    private func item(
        _ id: String, ios: String?, android: String? = nil, desktop: String? = nil,
        audience: AnnouncementAudience? = nil
    ) -> Announcement {
        let copy = Announcement.Copy(badge: "b", title: "t", body: "x", also: "a", button: "ok")
        return Announcement(
            id: id, ships: .init(ios: ios, android: android, desktop: desktop), audience: audience,
            copy: ["en": copy, "zh-Hant": copy])
    }

    // MARK: first launch

    func testANewInstallSeesNothingAndHasEverythingMarkedSeen() {
        let bundled = [item("a", ios: "1.22"), item("b", ios: "1.30")]

        let state = AnnouncementGate.initial(bundled: bundled, hadStoredSession: false)
        let decision = AnnouncementGate.decide(
            announcements: bundled, state: state, appVersion: "1.22", keyboardUsed: true)

        XCTAssertEqual(state.seen, ["a", "b"])
        XCTAssertEqual(decision, .nothing)
    }

    func testAnExistingUserUpgradingIsShownIt() {
        let bundled = [item("a", ios: "1.22")]

        let state = AnnouncementGate.initial(bundled: bundled, hadStoredSession: true)
        let decision = AnnouncementGate.decide(
            announcements: bundled, state: state, appVersion: "1.22", keyboardUsed: false)

        XCTAssertEqual(state.seen, [])
        XCTAssertEqual(decision.show?.id, "a")
        XCTAssertEqual(decision.retire, ["a"])
    }

    // MARK: versions

    func testAnAnnouncementForALaterVersionWaits() {
        let decision = AnnouncementGate.decide(
            announcements: [item("a", ios: "1.23")], state: AnnouncementState(),
            appVersion: "1.22", keyboardUsed: true)

        XCTAssertEqual(decision, .nothing)
    }

    func testAnEarlierVersionStillShowsToSomeoneWhoSkippedIt() {
        let decision = AnnouncementGate.decide(
            announcements: [item("a", ios: "1.9")], state: AnnouncementState(),
            appVersion: "1.10", keyboardUsed: true)

        XCTAssertEqual(decision.show?.id, "a")
    }

    func testOtherPlatformsVersionsAreIrrelevantOnIOS() {
        let iosToo = item("a", ios: "1.22", android: nil, desktop: nil)
        let androidOnly = item("b", ios: nil, android: "1.15", desktop: "0.9")

        let decision = AnnouncementGate.decide(
            announcements: [iosToo, androidOnly], state: AnnouncementState(),
            appVersion: "9.0", keyboardUsed: true)

        XCTAssertEqual(decision.show?.id, "a")
        XCTAssertEqual(decision.retire, ["a"], "an Android-only entry is not ours to retire")

        let onlyAndroid = AnnouncementGate.decide(
            announcements: [androidOnly], state: AnnouncementState(), appVersion: "9.0",
            keyboardUsed: true)
        XCTAssertEqual(onlyAndroid, .nothing)
    }

    func testAnUnreadableAppVersionShowsNothing() {
        let decision = AnnouncementGate.decide(
            announcements: [item("a", ios: "1.0")], state: AnnouncementState(),
            appVersion: "", keyboardUsed: true)

        XCTAssertEqual(decision, .nothing)
    }

    // MARK: several at once

    func testOnlyTheNewestShowsAndTheOlderOnesAreRetiredWithIt() {
        let bundled = [
            item("2026-08-old", ios: "1.20"),
            item("2026-10-new", ios: "1.22"),
            item("2026-09-mid", ios: "1.21"),
            item("2026-12-future", ios: "1.24"),
        ]

        let decision = AnnouncementGate.decide(
            announcements: bundled, state: AnnouncementState(), appVersion: "1.22.1",
            keyboardUsed: true)

        XCTAssertEqual(decision.show?.id, "2026-10-new")
        XCTAssertEqual(decision.retire, ["2026-08-old", "2026-09-mid", "2026-10-new"])
    }

    func testTwoInTheSameVersionBreakTheTieOnTheLaterID() {
        let decision = AnnouncementGate.decide(
            announcements: [item("2026-10-b", ios: "1.22"), item("2026-10-a", ios: "1.22")],
            state: AnnouncementState(), appVersion: "1.22", keyboardUsed: true)

        XCTAssertEqual(decision.show?.id, "2026-10-b")
        XCTAssertEqual(decision.retire, ["2026-10-a", "2026-10-b"])
    }

    // MARK: audience

    func testAKeyboardAnnouncementWaitsForTheKeyboardToBeUsed() {
        let bundled = [item("kb", ios: "1.22", audience: .keyboard)]

        let unused = AnnouncementGate.decide(
            announcements: bundled, state: AnnouncementState(), appVersion: "1.22",
            keyboardUsed: false)
        let used = AnnouncementGate.decide(
            announcements: bundled, state: AnnouncementState(), appVersion: "1.22",
            keyboardUsed: true)

        XCTAssertEqual(unused, .nothing)
        XCTAssertEqual(used.show?.id, "kb")
    }

    func testAnUnmetAudienceFallsBackToTheNewestOneThatIsMet() {
        let bundled = [
            item("2026-09-all", ios: "1.21"),
            item("2026-10-kb", ios: "1.22", audience: .keyboard),
        ]

        let decision = AnnouncementGate.decide(
            announcements: bundled, state: AnnouncementState(), appVersion: "1.22",
            keyboardUsed: false)

        XCTAssertEqual(decision.show?.id, "2026-09-all")
        XCTAssertEqual(decision.retire, ["2026-09-all"], "the newer keyboard one keeps waiting")
    }

    func testAnAudienceThisBuildDoesNotKnowIsUnmet() throws {
        let json = Data(
            #"{"id":"x","ships":{"ios":"1.0"},"audience":"watch","copy":{}}"#.utf8)
        let decoded = try AnnouncementCatalog.decode(json)

        XCTAssertEqual(decoded.audience, .unknown("watch"))
        XCTAssertEqual(
            AnnouncementGate.decide(
                announcements: [decoded], state: AnnouncementState(), appVersion: "1.0",
                keyboardUsed: true),
            .nothing)
    }

    // MARK: seen

    func testASeenAnnouncementIsNeverShownAgain() {
        let decision = AnnouncementGate.decide(
            announcements: [item("a", ios: "1.22")], state: AnnouncementState(seen: ["a"]),
            appVersion: "1.22", keyboardUsed: true)

        XCTAssertEqual(decision, .nothing)
    }

    // MARK: copy

    func testCopyFollowsTheUILanguage() {
        let zh = Announcement.Copy(badge: "中", title: "中", body: "中", also: "中", button: "好")
        let en = Announcement.Copy(badge: "en", title: "en", body: "en", also: "en", button: "OK")
        let announcement = Announcement(
            id: "a", ships: .init(ios: "1.0"), copy: ["zh-Hant": zh, "en": en])

        XCTAssertEqual(announcement.copy(forLocalization: "zh-Hant"), zh)
        XCTAssertEqual(announcement.copy(forLocalization: "zh-TW"), zh)
        XCTAssertEqual(announcement.copy(forLocalization: "en"), en)
        XCTAssertEqual(announcement.copy(forLocalization: "ja"), en)
    }

    // MARK: version comparison

    func testVersionsCompareNumericallyByComponent() throws {
        func v(_ s: String) throws -> AppVersion { try XCTUnwrap(AppVersion(s)) }

        XCTAssertLessThan(try v("1.9"), try v("1.10"))
        XCTAssertEqual(try v("1.22"), try v("1.22.0"))
        XCTAssertEqual(try v("1.22.0.0"), try v("1.22"))
        XCTAssertLessThan(try v("1.22"), try v("1.22.1"))
        XCTAssertLessThan(try v("1.99"), try v("2"))
        XCTAssertGreaterThan(try v("10.0"), try v("9.9.9"))
        XCTAssertEqual(try v("1.22-beta"), try v("1.22"))
        XCTAssertNil(AppVersion(""))
        XCTAssertNil(AppVersion("beta"))
    }
}
