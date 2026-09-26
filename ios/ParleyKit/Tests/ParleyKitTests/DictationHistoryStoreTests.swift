import XCTest

@testable import ParleyKit

/// The history is the only record of what someone dictated once the session
/// ends, so what is tested here is that it keeps what it should (including the
/// failed sessions, which are the ones worth rescuing), forgets what it should,
/// honours the switch, and never takes the app down over a bad file.
final class DictationHistoryStoreTests: XCTestCase {
    private var directory: URL!
    /// The store's clock. Tests move it rather than sleeping.
    private let clock = TestClock(Date(timeIntervalSinceReferenceDate: 800_000_000))
    private let enabled = TestFlag(true)

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("DictationHistoryStoreTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func makeStore() -> DictationHistoryStore {
        let clock = clock
        let enabled = enabled
        return DictationHistoryStore(
            directory: directory, now: { clock.now }, isEnabled: { enabled.value })
    }

    private func entry(
        _ text: String, startedAgo seconds: TimeInterval = 0, source: DictationHistoryEntry.Source = .keyboard
    ) -> DictationHistoryEntry {
        DictationHistoryEntry(
            text: text, startedAt: clock.now.addingTimeInterval(-seconds), durationMs: 4_200,
            source: source, hostBundleID: "com.apple.mobilenotes")
    }

    // MARK: retention

    /// 200 is the cap: the 201st entry evicts the oldest, and only the oldest.
    func testTheTwoHundredAndFirstEntryEvictsTheOldest() {
        let store = makeStore()
        var first: DictationHistoryEntry?
        for i in 0..<DictationHistoryStore.maxEntries {
            let e = entry("entry \(i)")
            if i == 0 { first = e }
            store.append(e)
            clock.advance(1)
        }
        XCTAssertEqual(store.load().count, 200)
        XCTAssertEqual(store.load().last?.id, first?.id)

        let newest = entry("entry 200")
        let after = store.append(newest)

        XCTAssertEqual(after?.count, 200)
        XCTAssertEqual(after?.first?.id, newest.id)
        XCTAssertFalse(after?.contains { $0.id == first?.id } ?? true)
        XCTAssertEqual(store.load().map(\.text).last, "entry 1")
    }

    /// A 31-day-old entry is gone after the next write.
    func testAnEntryOlderThanThirtyDaysIsDroppedOnWrite() {
        let store = makeStore()
        let old = entry("last month", startedAgo: 31 * 24 * 3600)
        let recent = entry("yesterday", startedAgo: 24 * 3600)
        // Written while each was still fresh: the stale one goes in first, with
        // the clock 31 days back, the way it would have been at the time.
        clock.advance(-31 * 24 * 3600)
        store.append(DictationHistoryEntry(
            id: old.id, text: old.text, startedAt: old.startedAt, durationMs: 1, source: .keyboard))
        clock.advance(31 * 24 * 3600)

        let after = store.append(recent)

        XCTAssertEqual(after?.map(\.text), ["yesterday"])
        XCTAssertEqual(store.load().map(\.text), ["yesterday"])
    }

    /// …and after a load, with no write in between: an entry that aged out while
    /// the app was not running is gone the moment the history is looked at, and
    /// the file itself stops carrying it.
    func testAnEntryOlderThanThirtyDaysIsDroppedOnLoad() throws {
        let store = makeStore()
        store.append(entry("still here", startedAgo: 24 * 3600))
        store.append(entry("about to expire", startedAgo: 29 * 24 * 3600))
        XCTAssertEqual(store.load().count, 2)

        // Two days pass with nothing written: the second is now 31 days old.
        clock.advance(2 * 24 * 3600)

        XCTAssertEqual(store.load().map(\.text), ["still here"])
        // A fresh store over the same file sees the pruned list, not the old one.
        let raw = try Data(contentsOf: store.fileURL)
        let onDisk = try JSONDecoder().decode([DictationHistoryEntry].self, from: raw)
        XCTAssertEqual(onDisk.map(\.text), ["still here"])
    }

    // MARK: what gets kept

    /// The case the whole feature exists for: a session that ended in `.error`
    /// with words already settled. The store has no notion of end states — the
    /// coordinator calls `append` for `.done`, `.error` and `micTaken` alike —
    /// so what this pins is that such an entry is kept verbatim, with its
    /// source and host, and comes back first.
    func testAnErroredSessionWithTextIsSaved() {
        let store = makeStore()
        store.append(entry("an earlier one", startedAgo: 600))
        let rescued = DictationHistoryEntry(
            text: "Lost the connection mid-sentence but these words were settled",
            startedAt: clock.now.addingTimeInterval(-40), durationMs: 38_000,
            source: .actionButton, hostBundleID: nil)

        store.append(rescued)

        let loaded = store.load()
        XCTAssertEqual(loaded.first, rescued)
        XCTAssertEqual(loaded.count, 2)
    }

    /// Blank text is never an entry: an error before anything was said has
    /// nothing to rescue, and a row with no words in it is noise.
    func testBlankTextIsNotKept() {
        let store = makeStore()
        XCTAssertNil(store.append(entry("  \n ")))
        XCTAssertEqual(store.load(), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.fileURL.path))
    }

    // MARK: the switch and "Clear all"

    /// Off means off: nothing is written, not even the file. What was already
    /// there stays until "Clear all".
    func testTheSwitchOffPreventsWrites() {
        let store = makeStore()
        store.append(entry("before the switch"))

        enabled.value = false
        XCTAssertNil(store.append(entry("while off")))
        XCTAssertEqual(store.load().map(\.text), ["before the switch"])

        enabled.value = true
        store.append(entry("after turning it back on"))
        XCTAssertEqual(store.load().count, 2)
    }

    func testTheSwitchOffOnAnEmptyHistoryWritesNoFile() {
        enabled.value = false
        let store = makeStore()
        store.append(entry("while off"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.fileURL.path))
    }

    func testClearAllEmptiesTheFile() {
        let store = makeStore()
        store.append(entry("one"))
        store.append(entry("two"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.fileURL.path))

        store.clearAll()

        XCTAssertFalse(FileManager.default.fileExists(atPath: store.fileURL.path))
        XCTAssertEqual(store.load(), [])
        // And a fresh store over the same directory agrees.
        XCTAssertEqual(makeStore().load(), [])
    }

    func testRemoveTakesOneEntryAndLeavesTheRest() {
        let store = makeStore()
        let keep = entry("keep", startedAgo: 10)
        let drop = entry("drop")
        store.append(keep)
        store.append(drop)

        XCTAssertEqual(store.remove(id: drop.id), [keep])
        XCTAssertEqual(store.load(), [keep])
    }

    // MARK: the file

    /// Written by one store, read by another over the same directory — which is
    /// what a relaunch is. Every field survives, dates to the sub-second.
    func testRoundTripThroughTheJSONFile() throws {
        let written = [
            DictationHistoryEntry(
                text: "嗨 Anna，跟你說一聲我的新電話號碼是 0912345678，之後再聊！",
                startedAt: clock.now.addingTimeInterval(-12.345), durationMs: 9_876,
                source: .keyboard, hostBundleID: "jp.naver.line"),
            DictationHistoryEntry(
                text: "Pick up milk", startedAt: clock.now.addingTimeInterval(-3_600.5),
                durationMs: 1_200, source: .actionButton, hostBundleID: nil),
        ]
        let first = makeStore()
        for e in written.reversed() { first.append(e) }

        XCTAssertEqual(first.fileURL.lastPathComponent, "dictation-history.json")
        XCTAssertEqual(makeStore().load(), written)
    }

    /// A torn write, a hand-edited file, a future format — none of it may take
    /// the app down. It loads as empty, and the next write replaces it.
    func testACorruptFileLoadsAsEmpty() throws {
        try Data("{ this is not [ json".utf8).write(to: directory.appendingPathComponent(
            DictationHistoryStore.fileName))
        let store = makeStore()

        XCTAssertEqual(store.load(), [])

        store.append(entry("after the corruption"))
        XCTAssertEqual(makeStore().load().map(\.text), ["after the corruption"])
    }

    /// Unset means on. A phone that has never opened Settings keeps history.
    func testTheSwitchDefaultsToOn() throws {
        let suite = "DictationHistoryStoreTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        XCTAssertTrue(DictationHistoryStore.isEnabled(in: defaults))
        defaults.set(false, forKey: DictationHistoryStore.enabledKey)
        XCTAssertFalse(DictationHistoryStore.isEnabled(in: defaults))
    }
}

private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date
    init(_ start: Date) { current = start }
    var now: Date {
        lock.lock()
        defer { lock.unlock() }
        return current
    }
    func advance(_ seconds: TimeInterval) {
        lock.lock()
        current = current.addingTimeInterval(seconds)
        lock.unlock()
    }
}

private final class TestFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Bool
    init(_ value: Bool) { stored = value }
    var value: Bool {
        get {
            lock.lock()
            defer { lock.unlock() }
            return stored
        }
        set {
            lock.lock()
            stored = newValue
            lock.unlock()
        }
    }
}
