import XCTest

@testable import ParleyKit

/// The store is the difference between a phone that can play a meeting back and
/// one that can only upload it, so what is tested here is ownership: a file that
/// arrives is the store's, a file that leaves is gone, and nothing it is handed
/// can write outside its own directory.
final class LocalAudioStoreTests: XCTestCase {
    private var base: URL!
    private var store: LocalAudioStore!

    override func setUpWithError() throws {
        base = FileManager.default.temporaryDirectory
            .appendingPathComponent("LocalAudioStoreTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        store = LocalAudioStore(base: base)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: base)
    }

    /// An Ogg written somewhere temporary, handed over, and asked for back.
    func testPutTakesOwnershipAndUrlFindsItAgain() throws {
        let source = try write(bytes: 1_024, named: "incoming.ogg")

        XCTAssertFalse(store.has("rec-1"))
        try store.put("rec-1", from: source)

        XCTAssertTrue(store.has("rec-1"))
        XCTAssertEqual(try Data(contentsOf: store.url(for: "rec-1")).count, 1_024)
        // A move, not a copy: the caller's file is gone, so a phone never holds
        // two copies of an hour of audio.
        XCTAssertFalse(FileManager.default.fileExists(atPath: source.path))
        XCTAssertEqual(store.url(for: "rec-1").lastPathComponent, "rec-1.ogg")
    }

    /// The same recording uploaded twice — a retry, or a backfill that came back
    /// — replaces what is there rather than failing on the existing file.
    func testPutReplacesAnExistingRecording() throws {
        try store.put("rec-1", from: try write(bytes: 10, named: "first.ogg"))
        try store.put("rec-1", from: try write(bytes: 99, named: "second.ogg"))

        XCTAssertEqual(try Data(contentsOf: store.url(for: "rec-1")).count, 99)
    }

    func testRemoveTakesOneRecordingAndLeavesTheRest() throws {
        try store.put("keep", from: try write(bytes: 64, named: "a.ogg"))
        try store.put("drop", from: try write(bytes: 64, named: "b.ogg"))

        store.remove("drop")

        XCTAssertTrue(store.has("keep"))
        XCTAssertFalse(store.has("drop"))
    }

    /// Removing something that was never here is not an error — the library row
    /// offers "Remove download" from whatever state the UI last saw, and the
    /// store is the one that actually knows.
    func testRemoveIsSilentAboutAnAbsentRecording() {
        store.remove("never-here")
        XCTAssertFalse(store.has("never-here"))
    }

    func testTotalBytesAddsUpAndRemoveAllEmptiesTheStore() throws {
        XCTAssertEqual(store.totalBytes(), 0)

        try store.put("a", from: try write(bytes: 1_000, named: "a.ogg"))
        try store.put("b", from: try write(bytes: 2_500, named: "b.ogg"))
        XCTAssertEqual(store.totalBytes(), 3_500)

        store.removeAll()

        XCTAssertEqual(store.totalBytes(), 0)
        XCTAssertFalse(store.has("a"))
        XCTAssertFalse(store.has("b"))
        // …and the store still works afterwards: "Remove all" is not a way to
        // break the next recording.
        try store.put("c", from: try write(bytes: 7, named: "c.ogg"))
        XCTAssertTrue(store.has("c"))
        XCTAssertEqual(store.totalBytes(), 7)
    }

    /// The store answers for one directory and one only. An id is a server
    /// string, and `appendingPathComponent` would happily turn `../../x` into a
    /// write outside the container.
    func testAnIdCannotEscapeTheStoreDirectory() throws {
        let escaping = "../../escaped"
        try store.put(escaping, from: try write(bytes: 8, named: "x.ogg"))

        let file = store.url(for: escaping)
        XCTAssertEqual(file.deletingLastPathComponent().lastPathComponent, "Audio")
        XCTAssertFalse(file.path.contains(".."))
        XCTAssertTrue(store.has(escaping))
        XCTAssertEqual(store.totalBytes(), 8)
    }

    func testFileNameKeepsUuidsAsTheyAre() {
        let id = UUID().uuidString.lowercased()
        XCTAssertEqual(LocalAudioStore.fileName(for: id), id)
        XCTAssertEqual(LocalAudioStore.fileName(for: ""), "unnamed")
    }

    /// The setting the upload path reads. An unset key has to mean "keep",
    /// because the default is on and `bool(forKey:)` cannot say so.
    func testKeepAudioDefaultsToOnWhenNobodyHasTouchedTheSetting() {
        let defaults = UserDefaults.standard
        let original = defaults.object(forKey: LocalAudioStore.keepAudioKey)
        defer {
            if let original {
                defaults.set(original, forKey: LocalAudioStore.keepAudioKey)
            } else {
                defaults.removeObject(forKey: LocalAudioStore.keepAudioKey)
            }
        }

        defaults.removeObject(forKey: LocalAudioStore.keepAudioKey)
        XCTAssertTrue(LocalAudioStore.keepsAudioOnPhone)

        defaults.set(false, forKey: LocalAudioStore.keepAudioKey)
        XCTAssertFalse(LocalAudioStore.keepsAudioOnPhone)

        defaults.set(true, forKey: LocalAudioStore.keepAudioKey)
        XCTAssertTrue(LocalAudioStore.keepsAudioOnPhone)
    }

    /// Two stores over the same base are the same store: `shared` is a
    /// convenience, not the identity.
    func testASecondStoreOverTheSameBaseSeesTheSameFiles() throws {
        try store.put("rec-1", from: try write(bytes: 32, named: "a.ogg"))

        XCTAssertTrue(LocalAudioStore(base: base).has("rec-1"))
    }

    private func write(bytes: Int, named name: String) throws -> URL {
        let url = base.appendingPathComponent(name)
        try Data(repeating: 0x4F, count: bytes).write(to: url)
        return url
    }
}
