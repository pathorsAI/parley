import Foundation
import XCTest

@testable import ParleyKit

/// The keyboard's clipboard history and the paste chip's rules. What matters
/// most here is what is *not* kept — a password, a one-time code, a copy of the
/// user's ID number — because the history is a file of things people copied in
/// other apps, and every exclusion that fails is a secret written to disk.
final class ClipboardHistoryTests: XCTestCase {
    private var directory: URL!
    private let clock = ClipboardTestClock(Date(timeIntervalSinceReferenceDate: 800_000_000))
    private let retention = ClipboardTestRetention(.oneDay)

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ClipboardHistoryTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func makeStore() -> ClipboardHistoryStore {
        let clock = clock
        let retention = retention
        return ClipboardHistoryStore(
            directory: directory, now: { clock.now }, retention: { retention.value })
    }

    // MARK: exclusions

    func testConcealedPasteboardsAreNeverKept() {
        for marker in ClipboardRules.concealedTypes {
            XCTAssertEqual(
                ClipboardRules.exclusion(for: "hunter2", types: ["public.utf8-plain-text", marker]),
                .concealed, marker)
        }
        XCTAssertTrue(ClipboardRules.isConcealed(types: ["com.agilebits.onepassword"]))
        XCTAssertFalse(ClipboardRules.isConcealed(types: ["public.utf8-plain-text"]))
    }

    func testOneTimeCodesAreNotKept() {
        XCTAssertEqual(ClipboardRules.exclusion(for: "1234"), .oneTimeCode)
        XCTAssertEqual(ClipboardRules.exclusion(for: " 482913 "), .oneTimeCode)
        XCTAssertEqual(ClipboardRules.exclusion(for: "12345678"), .oneTimeCode)
        // Outside four to eight digits it is just a number.
        XCTAssertNil(ClipboardRules.exclusion(for: "123"))
        XCTAssertNil(ClipboardRules.exclusion(for: "123456789"))
        // A phone number has punctuation, and is something worth keeping.
        XCTAssertNil(ClipboardRules.exclusion(for: "0912-345-678"))
    }

    func testTokensAndPasswordsAreNotKept() {
        XCTAssertEqual(
            ClipboardRules.exclusion(for: "ghp_8fK2mQ9xLr4TzW1vB7nC3yH6pJ0sD5eA"), .secretLike)
        XCTAssertEqual(ClipboardRules.exclusion(for: "Tr0ub4dor&3xyzAB"), .secretLike)
        XCTAssertEqual(
            ClipboardRules.exclusion(for: "sk-proj-Ab12Cd34Ef56Gh78Ij90Kl12"), .secretLike)
        // Two classes are enough once it is long: a hex digest.
        XCTAssertEqual(
            ClipboardRules.exclusion(for: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b"), .secretLike)
    }

    func testOrdinaryTextIsKept() {
        // Long but with spaces.
        XCTAssertNil(ClipboardRules.exclusion(for: "Meet me at the station at 3:30 PM, OK?"))
        // No spaces, but Chinese — tokens are ASCII.
        XCTAssertNil(ClipboardRules.exclusion(for: "今天天氣很好我們去公園散步吧好不好呢"))
        // URLs and emails match a token's shape and are the most common copies.
        XCTAssertNil(
            ClipboardRules.exclusion(for: "https://example.com/Some/Path?id=42&Ref=abc"))
        XCTAssertNil(ClipboardRules.exclusion(for: "www.Example123.com/path"))
        XCTAssertNil(ClipboardRules.exclusion(for: "Jack.Wang2024@pathors.com"))
        // One class, long: a word.
        XCTAssertNil(ClipboardRules.exclusion(for: "internationalization"))
        // Low entropy: repetition is not a key.
        XCTAssertFalse(ClipboardRules.looksSecret("aaaaaaaaaaaaaaaaaaaaB1!"))
        // Short.
        XCTAssertFalse(ClipboardRules.looksSecret("Ab1!xyz"))
    }

    func testEmptyAndOverlongTextIsNotKept() {
        XCTAssertEqual(ClipboardRules.exclusion(for: "  \n "), .empty)
        let long = String(repeating: "字", count: ClipboardHistory.maxLength + 1)
        XCTAssertEqual(ClipboardRules.exclusion(for: long), .tooLong)
        let exact = String(repeating: "字", count: ClipboardHistory.maxLength)
        XCTAssertNil(ClipboardRules.exclusion(for: exact))
    }

    func testACopyOfASensitiveSnippetIsNotKept() {
        let blocked = SnippetStore.sensitiveValues(in: [
            Snippet(kind: .nationalID, label: "身分證字號", value: "A123456789"),
            Snippet(kind: .mobile, label: "手機", value: "0912345678"),
        ])
        XCTAssertEqual(blocked, ["A123456789"])
        XCTAssertEqual(
            ClipboardRules.exclusion(for: "a123 456 789", blocked: blocked), .sensitiveInfo)
        // The mobile is not sensitive, so a copy of it is kept.
        XCTAssertNil(ClipboardRules.exclusion(for: "0912-345-678", blocked: blocked))
    }

    // MARK: the list

    func testNewestFirstAndRepeatsMoveToTheTop() {
        var history = ClipboardHistory()
        history.add("one", at: clock.now)
        history.add("two", at: clock.now.addingTimeInterval(1))
        let firstID = history.items.last?.id
        history.add("one", at: clock.now.addingTimeInterval(2))
        XCTAssertEqual(history.items.map(\.text), ["one", "two"])
        // The same item, moved — not a second one.
        XCTAssertEqual(history.items.first?.id, firstID)
    }

    func testOnlyTheNewestFiftyUnpinnedAreKept() {
        var history = ClipboardHistory()
        history.add("pinned", at: clock.now)
        history.setPinned(history.items[0].id, true)
        for i in 0..<60 {
            history.add("item \(i)", at: clock.now.addingTimeInterval(TimeInterval(i + 1)))
        }
        XCTAssertEqual(history.recent.count, ClipboardHistory.maxRecent)
        XCTAssertEqual(history.recent.first?.text, "item 59")
        XCTAssertEqual(history.recent.last?.text, "item 10")
        // Pinned items do not count against the cap and are not pushed out.
        XCTAssertEqual(history.pinned.map(\.text), ["pinned"])
    }

    func testRetentionExpiresUnpinnedItemsOnly() {
        var history = ClipboardHistory()
        history.add("old pinned", at: clock.now)
        history.setPinned(history.items[0].id, true)
        history.add("old", at: clock.now)
        history.add("fresh", at: clock.now.addingTimeInterval(23 * 3600))

        history.prune(now: clock.now.addingTimeInterval(24 * 3600 + 1), retention: .oneDay)
        XCTAssertEqual(Set(history.items.map(\.text)), ["old pinned", "fresh"])

        history.prune(now: clock.now.addingTimeInterval(30 * 24 * 3600), retention: .sevenDays)
        XCTAssertEqual(history.items.map(\.text), ["old pinned"])
    }

    func testRetentionIntervals() {
        XCTAssertEqual(ClipboardRetention.oneHour.interval, 3600)
        XCTAssertEqual(ClipboardRetention.oneDay.interval, 86_400)
        XCTAssertEqual(ClipboardRetention.sevenDays.interval, 604_800)
        XCTAssertEqual(ClipboardRetention.default, .oneDay)
    }

    // MARK: the store

    func testStoreCapturesPinsDeletesAndClears() throws {
        let store = makeStore()
        XCTAssertEqual(store.capture("hello"), .stored)
        XCTAssertEqual(store.capture("482913"), .excluded(.oneTimeCode))
        XCTAssertEqual(
            store.capture("secret", types: ["org.nspasteboard.ConcealedType"]),
            .excluded(.concealed))
        clock.advance(1)
        store.capture("world")

        var history = store.load()
        XCTAssertEqual(history.items.map(\.text), ["world", "hello"])

        let hello = try XCTUnwrap(history.items.last)
        history = store.setPinned(hello.id, true)
        XCTAssertEqual(history.pinned.map(\.text), ["hello"])

        history = store.remove(history.recent[0].id)
        XCTAssertEqual(history.items.map(\.text), ["hello"])

        store.clearAll()
        XCTAssertTrue(store.load().items.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.fileURL.path))
    }

    func testStoreExpiresOnLoadAndWritesThePrunedListBack() {
        let store = makeStore()
        store.capture("old")
        retention.value = .oneHour
        clock.advance(3601)
        XCTAssertTrue(store.load().items.isEmpty)
        // Gone from the file too, not just from what was returned.
        let data = try? Data(contentsOf: store.fileURL)
        XCTAssertEqual(data.flatMap { String(data: $0, encoding: .utf8) }, "[]")
    }

    func testRemovingMatchingValuesForgetsCopiesOfASensitiveSnippet() {
        let store = makeStore()
        store.capture("A123 456 789")
        store.capture("keep me")
        let history = store.remove(matching: ["A123456789"])
        XCTAssertEqual(history.items.map(\.text), ["keep me"])
    }

    func testAnUnreadableFileIsAnEmptyHistoryAndABadRowCostsOneRow() throws {
        let store = makeStore()
        try Data("not json".utf8).write(to: store.fileURL)
        XCTAssertTrue(store.load().items.isEmpty)

        let good = ClipboardItem(text: "kept", capturedAt: clock.now)
        let json = """
            [\(String(data: try JSONEncoder().encode(good), encoding: .utf8)!), {"text": "no id"}]
            """
        try Data(json.utf8).write(to: store.fileURL)
        XCTAssertEqual(store.load().items.map(\.text), ["kept"])
    }

    // MARK: the paste chip

    func testTheFirstLookIsABaselineNotAnOffer() {
        let (offer, shows) = PasteOffer.evaluate(
            changeCount: 7, hasText: true, remembered: nil, now: clock.now)
        XCTAssertFalse(shows)
        XCTAssertTrue(offer.closed)
        XCTAssertEqual(offer.changeCount, 7)
    }

    func testANewCopyIsOfferedForThreeMinutes() {
        let baseline = PasteOffer(changeCount: 7, noticedAt: clock.now, closed: true)
        let later = clock.now.addingTimeInterval(600)
        let (offer, shows) = PasteOffer.evaluate(
            changeCount: 8, hasText: true, remembered: baseline, now: later)
        XCTAssertTrue(shows)
        XCTAssertEqual(offer.noticedAt, later)

        // Still the same copy two minutes on: still offered, from when it was
        // first noticed rather than from this look.
        let (same, stillShows) = PasteOffer.evaluate(
            changeCount: 8, hasText: true, remembered: offer, now: later.addingTimeInterval(120))
        XCTAssertTrue(stillShows)
        XCTAssertEqual(same.noticedAt, later)

        let (_, expired) = PasteOffer.evaluate(
            changeCount: 8, hasText: true, remembered: offer,
            now: later.addingTimeInterval(PasteOffer.lifetime))
        XCTAssertFalse(expired)
    }

    func testAClosedOfferStaysClosedForThatCopy() {
        let offer = PasteOffer(changeCount: 8, noticedAt: clock.now, closed: false).closing
        let (_, shows) = PasteOffer.evaluate(
            changeCount: 8, hasText: true, remembered: offer, now: clock.now)
        XCTAssertFalse(shows)
        // The next copy is a new offer.
        let (_, next) = PasteOffer.evaluate(
            changeCount: 9, hasText: true, remembered: offer, now: clock.now)
        XCTAssertTrue(next)
    }

    func testParleysOwnCopyIsNotOffered() {
        let own = PasteOffer.ownWrite(changeCount: 12, at: clock.now)
        let (_, shows) = PasteOffer.evaluate(
            changeCount: 12, hasText: true, remembered: own, now: clock.now)
        XCTAssertFalse(shows)
    }

    func testANonTextCopyIsNotOffered() {
        let baseline = PasteOffer(changeCount: 1, noticedAt: clock.now, closed: true)
        let (offer, shows) = PasteOffer.evaluate(
            changeCount: 2, hasText: false, remembered: baseline, now: clock.now)
        XCTAssertFalse(shows)
        XCTAssertTrue(offer.closed)
    }

    func testThePasteOfferRoundTripsThroughTheSharedDefaults() throws {
        let suite = "ClipboardHistoryTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        XCTAssertNil(ClipboardSettings.pasteOffer(in: defaults))
        ClipboardSettings.noteOwnWrite(changeCount: 5, now: clock.now, in: defaults)
        XCTAssertEqual(
            ClipboardSettings.pasteOffer(in: defaults),
            PasteOffer(changeCount: 5, noticedAt: clock.now, closed: true))
    }

    func testSettingsDefaults() throws {
        let suite = "ClipboardHistoryTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        // Both reads of the pasteboard are opted into, never assumed.
        XCTAssertFalse(ClipboardSettings.autoCapture(in: defaults))
        XCTAssertFalse(ClipboardSettings.previewInStrip(in: defaults))
        XCTAssertEqual(ClipboardSettings.retention(in: defaults), .oneDay)

        ClipboardSettings.setAutoCapture(true, in: defaults)
        ClipboardSettings.setPreviewInStrip(true, in: defaults)
        ClipboardSettings.setRetention(.sevenDays, in: defaults)
        XCTAssertTrue(ClipboardSettings.autoCapture(in: defaults))
        XCTAssertTrue(ClipboardSettings.previewInStrip(in: defaults))
        XCTAssertEqual(ClipboardSettings.retention(in: defaults), .sevenDays)

        defaults.set("fortnight", forKey: ClipboardSettings.retentionKey)
        XCTAssertEqual(ClipboardSettings.retention(in: defaults), .oneDay)
    }

    func testTheChipLabel() {
        XCTAssertEqual(PasteChipLabel.make(hasURL: true, previewText: nil), .url)
        XCTAssertEqual(PasteChipLabel.make(hasURL: false, previewText: nil), .text)
        XCTAssertEqual(
            PasteChipLabel.make(hasURL: false, previewText: "明天下午三點在\n台北車站見面喔"),
            .preview("明天下午三點在 台北車站…"))
        XCTAssertEqual(PasteChipLabel.make(hasURL: false, previewText: "short"), .preview("short"))
        // A secret-shaped string falls back to the type, preview or not.
        XCTAssertEqual(
            PasteChipLabel.make(hasURL: false, previewText: "Tr0ub4dor&3xyzAB"), .text)
        XCTAssertEqual(PasteChipLabel.make(hasURL: true, previewText: "   "), .url)
    }

    func testSettingsLinks() {
        for link in SettingsLink.allCases {
            XCTAssertEqual(SettingsLink(url: link.url), link)
        }
        XCTAssertEqual(SettingsLink.clipboard.url.absoluteString, "parley://settings/clipboard")
        XCTAssertNil(SettingsLink(url: URL(string: "parley://dictate?session=x")!))
        XCTAssertNil(SettingsLink(url: URL(string: "parley://settings/nope")!))
        XCTAssertNil(SettingsLink(url: URL(string: "https://settings/clipboard")!))
    }
}

private final class ClipboardTestClock: @unchecked Sendable {
    var now: Date
    init(_ now: Date) { self.now = now }
    func advance(_ seconds: TimeInterval) { now = now.addingTimeInterval(seconds) }
}

private final class ClipboardTestRetention: @unchecked Sendable {
    var value: ClipboardRetention
    init(_ value: ClipboardRetention) { self.value = value }
}
