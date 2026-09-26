import XCTest

@testable import ParleyKit

final class FolderSearchTests: XCTestCase {

    private func folder(_ name: String) -> CloudFolder {
        CloudFolder(id: name, name: name, orgId: nil, createdAt: nil, updatedAt: nil)
    }

    private lazy var folders = ["Acme Corp", "Café Luna", "北風工業", "Northwind", "晴光實驗室"]
        .map(folder)

    func testAnEmptyQueryIsTheWholeList() {
        XCTAssertEqual(FolderSearch.filter(folders, query: "").count, folders.count)
        XCTAssertEqual(FolderSearch.filter(folders, query: "   ").count, folders.count)
    }

    func testMatchesASubstringAnywhereInTheName() {
        XCTAssertEqual(FolderSearch.filter(folders, query: "corp").map(\.name), ["Acme Corp"])
        XCTAssertEqual(FolderSearch.filter(folders, query: "wind").map(\.name), ["Northwind"])
    }

    func testIgnoresCase() {
        XCTAssertEqual(FolderSearch.filter(folders, query: "ACME").map(\.name), ["Acme Corp"])
    }

    func testIgnoresDiacritics() {
        XCTAssertEqual(FolderSearch.filter(folders, query: "cafe").map(\.name), ["Café Luna"])
    }

    func testIgnoresFullWidthLatin() {
        XCTAssertEqual(FolderSearch.filter(folders, query: "ＡＣＭＥ").map(\.name), ["Acme Corp"])
    }

    func testMatchesChineseWithoutSpaces() {
        XCTAssertEqual(FolderSearch.filter(folders, query: "北風").map(\.name), ["北風工業"])
        XCTAssertEqual(FolderSearch.filter(folders, query: "實驗").map(\.name), ["晴光實驗室"])
    }

    func testTrimsTheQuery() {
        XCTAssertEqual(FolderSearch.filter(folders, query: "  luna ").map(\.name), ["Café Luna"])
    }

    func testNoMatchIsEmpty() {
        XCTAssertTrue(FolderSearch.filter(folders, query: "Halcyon").isEmpty)
    }

    func testKeepsTheServersOrder() {
        let names = FolderSearch.filter(folders, query: "a").map(\.name)
        XCTAssertEqual(names, ["Acme Corp", "Café Luna"])
    }

    func testAnExactMatchIsLooseToo() {
        XCTAssertTrue(FolderSearch.hasExactMatch(folders, query: "acme corp"))
        XCTAssertTrue(FolderSearch.hasExactMatch(folders, query: " cafe luna "))
        XCTAssertFalse(FolderSearch.hasExactMatch(folders, query: "acme"))
        XCTAssertFalse(FolderSearch.hasExactMatch(folders, query: ""))
    }

    func testTheExactMatchIsTheFolderItself() {
        XCTAssertEqual(FolderSearch.exactMatch(folders, query: "NORTHWIND")?.id, "Northwind")
        XCTAssertNil(FolderSearch.exactMatch(folders, query: "North"))
    }
}
