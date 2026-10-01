import XCTest

@testable import ParleyKit

/// The repository's `announcements/` folder, as every app will read it.
///
/// Read from the working tree through `#filePath` rather than copied into the
/// test bundle, for the same reason `RecordingSummaryTests` reads
/// `public/sample`: the file under test is the one that ships, and a copy
/// would be a second file to keep in step.
final class AnnouncementCatalogTests: XCTestCase {

    private var folder: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("announcements")
    }

    private func files() throws -> [URL] {
        let all = try FileManager.default.contentsOfDirectory(
            at: folder, includingPropertiesForKeys: nil)
        return all.filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    func testTheFolderIsThereAndNotEmpty() throws {
        XCTAssertFalse(try files().isEmpty, "no announcements found at \(folder.path)")
    }

    /// Decoded one by one, so a broken file is named — `AnnouncementCatalog`
    /// skips what it cannot read, which is right on a phone and wrong here.
    func testEveryFileDecodesAndCarriesBothLanguagesInFull() throws {
        var ids: Set<String> = []
        for url in try files() {
            let name = url.lastPathComponent
            let item = try AnnouncementCatalog.decode(Data(contentsOf: url))

            XCTAssertFalse(item.id.isEmpty, "\(name): empty id")
            XCTAssertTrue(ids.insert(item.id).inserted, "\(name): duplicate id \(item.id)")
            XCTAssertEqual(
                name, "\(item.id).json", "\(name): the file should be named after its id")

            for platform in [item.ships.ios, item.ships.android, item.ships.desktop] {
                if let version = platform {
                    XCTAssertNotNil(AppVersion(version), "\(name): unreadable version \(version)")
                }
            }
            if let audience = item.audience {
                XCTAssertNotEqual(
                    audience, .unknown(audience.rawValue),
                    "\(name): audience \(audience.rawValue) is not one the apps know")
            }

            for locale in [Announcement.traditionalChinese, Announcement.english] {
                guard let copy = item.copy[locale] else {
                    XCTFail("\(name): no \(locale) copy")
                    continue
                }
                for field in copy.fields {
                    XCTAssertFalse(
                        field.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                        "\(name): an empty \(locale) field")
                }
            }
        }
        XCTAssertEqual(
            AnnouncementCatalog.load(directory: folder).count, try files().count,
            "the loader skipped a file the checks above accepted")
    }

    /// App Store Connect's What's New field rejects Bopomofo with a 409, and
    /// this copy is kept in step with the release notes — so a 注音 character
    /// here is a release-day failure waiting to happen.
    func testNoCopyContainsBopomofo() throws {
        let bopomofo: [ClosedRange<UInt32>] = [0x3100...0x312F, 0x31A0...0x31BF]
        for url in try files() {
            let item = try AnnouncementCatalog.decode(Data(contentsOf: url))
            for (locale, copy) in item.copy {
                for field in copy.fields {
                    let offending = field.unicodeScalars.filter { scalar in
                        bopomofo.contains { $0.contains(scalar.value) }
                    }
                    XCTAssertTrue(
                        offending.isEmpty,
                        "\(url.lastPathComponent) [\(locale)]: Bopomofo \(String(String.UnicodeScalarView(offending))) in \"\(field)\""
                    )
                }
            }
        }
    }

    /// The check above is only worth something if it can fail.
    func testTheBopomofoRangesCatchZhuyin() {
        let sample = "ㄅㄆㄇ ㆠ"
        let ranges: [ClosedRange<UInt32>] = [0x3100...0x312F, 0x31A0...0x31BF]
        let caught = sample.unicodeScalars.filter { s in ranges.contains { $0.contains(s.value) } }
        XCTAssertEqual(caught.count, 4)
    }
}
