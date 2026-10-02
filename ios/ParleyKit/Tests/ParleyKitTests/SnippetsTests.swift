import Foundation
import XCTest

@testable import ParleyKit

/// 常用資訊: masking, the fields each kind is suggested in, recognising copied
/// text worth saving, the light validation, the file, and the revert chip's
/// test of whether the cursor is still where the dictation left it.
final class SnippetsTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SnippetsTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    // MARK: masking

    func testSensitiveKindsAreTheTwoIdentifiers() {
        XCTAssertEqual(
            Set(SnippetKind.allCases.filter(\.isSensitive)), [.nationalID, .taxID])
    }

    func testMaskingKeepsTwoAtEachEnd() {
        XCTAssertEqual(Snippet.masked("A123456789"), "A1••••••89")
        XCTAssertEqual(Snippet.masked("12345678"), "12••••78")
        XCTAssertEqual(Snippet.masked("12345"), "12•45")
        // Four or fewer: showing two at each end would show all of it.
        XCTAssertEqual(Snippet.masked("1234"), "••••")
        XCTAssertEqual(Snippet.masked(""), "")
    }

    func testOnlySensitiveSnippetsDisplayMasked() {
        let id = Snippet(kind: .nationalID, label: "身分證字號", value: "A123456789")
        let tax = Snippet(kind: .taxID, label: "統一編號", value: "12345678")
        let phone = Snippet(kind: .mobile, label: "手機", value: "0912345678")
        XCTAssertEqual(id.displayValue, "A1••••••89")
        XCTAssertEqual(tax.displayValue, "12••••78")
        XCTAssertEqual(phone.displayValue, "0912345678")
        // The value itself is untouched: a tap inserts all of it.
        XCTAssertEqual(id.value, "A123456789")
    }

    // MARK: fields

    func testFieldsSuggestTheirKindsInOrder() {
        let snippets = [
            Snippet(kind: .workAddress, label: "公司地址", value: "台北市信義區市府路1號"),
            Snippet(kind: .phone, label: "市話", value: "02-2345-6789"),
            Snippet(kind: .homeAddress, label: "住家地址", value: "新北市板橋區文化路一段100號"),
            Snippet(kind: .mobile, label: "手機", value: "0912345678"),
            Snippet(kind: .email, label: "Email", value: "jack@pathors.com"),
            Snippet(kind: .name, label: "姓名", value: "王小明"),
            Snippet(kind: .nationalID, label: "身分證字號", value: "A123456789"),
            Snippet(kind: .mobile, label: "手機", value: "  "),
        ]
        XCTAssertEqual(
            SnippetField.address.suggestions(from: snippets).map(\.kind),
            [.homeAddress, .workAddress])
        // Mobile before landline, and an empty value is no suggestion.
        XCTAssertEqual(
            SnippetField.phone.suggestions(from: snippets).map(\.value),
            ["0912345678", "02-2345-6789"])
        XCTAssertEqual(SnippetField.email.suggestions(from: snippets).map(\.kind), [.email])
        XCTAssertEqual(SnippetField.name.suggestions(from: snippets).map(\.kind), [.name])
        // No field ever suggests an identifier on its own.
        for field in SnippetField.allCases {
            XCTAssertFalse(field.kinds.contains { $0.isSensitive }, "\(field)")
        }
    }

    // MARK: detecting copied text

    func testDetectsEmailPhoneAndAddress() {
        XCTAssertEqual(SnippetDetector.field(for: "jack@pathors.com"), .email)
        XCTAssertEqual(SnippetDetector.field(for: "0912-345-678"), .phone)
        XCTAssertEqual(SnippetDetector.field(for: "+886 912 345 678"), .phone)
        XCTAssertEqual(SnippetDetector.field(for: "(02) 2345-6789 轉 123"), .phone)
        XCTAssertEqual(SnippetDetector.field(for: "台北市信義區市府路45號"), .address)
        XCTAssertEqual(SnippetDetector.field(for: "1 Infinite Loop, Cupertino"), .address)
        XCTAssertEqual(SnippetDetector.field(for: "221B Baker Street, London"), .address)
    }

    func testDoesNotDetectOrdinaryText() {
        XCTAssertNil(SnippetDetector.field(for: "see you at 3"))
        XCTAssertNil(SnippetDetector.field(for: "1234"))
        XCTAssertNil(SnippetDetector.field(for: "jack@pathors"))
        XCTAssertNil(SnippetDetector.field(for: "明天見"))
        XCTAssertNil(SnippetDetector.field(for: "3 apples and 2 pears"))
        XCTAssertNil(SnippetDetector.field(for: ""))
    }

    // MARK: validation

    func testTaiwanIDChecksum() {
        XCTAssertTrue(SnippetValidation.isTaiwanID("A123456789"))
        XCTAssertFalse(SnippetValidation.isTaiwanID("A123456788"))
        XCTAssertFalse(SnippetValidation.isTaiwanID("A323456789"))
        XCTAssertFalse(SnippetValidation.isTaiwanID("1123456789"))
        XCTAssertNil(SnippetValidation.hint(for: .nationalID, value: "a123456789"))
        XCTAssertEqual(SnippetValidation.hint(for: .nationalID, value: "A12345"), .nationalIDFormat)
    }

    func testOtherHints() {
        XCTAssertNil(SnippetValidation.hint(for: .taxID, value: "12345678"))
        XCTAssertEqual(SnippetValidation.hint(for: .taxID, value: "1234567"), .taxIDFormat)
        XCTAssertNil(SnippetValidation.hint(for: .email, value: "a@b.co"))
        XCTAssertEqual(SnippetValidation.hint(for: .email, value: "a@b"), .emailFormat)
        XCTAssertNil(SnippetValidation.hint(for: .mobile, value: "0912-345-678"))
        XCTAssertNil(SnippetValidation.hint(for: .mobile, value: "+1 415 555 0100"))
        XCTAssertEqual(SnippetValidation.hint(for: .mobile, value: "02-2345-6789"), .mobileFormat)
        XCTAssertNil(SnippetValidation.hint(for: .phone, value: "02-2345-6789"))
        XCTAssertEqual(SnippetValidation.hint(for: .phone, value: "call me"), .phoneFormat)
        // Free-form kinds, and an empty value, have nothing to hint.
        XCTAssertNil(SnippetValidation.hint(for: .homeAddress, value: "anything"))
        XCTAssertNil(SnippetValidation.hint(for: .custom, value: "anything"))
        XCTAssertNil(SnippetValidation.hint(for: .nationalID, value: " "))
    }

    // MARK: the store

    func testStoreKeepsOrderAndDeduplicatesAdds() {
        let store = SnippetStore(directory: directory)
        XCTAssertTrue(store.load().isEmpty)
        let a = Snippet(kind: .mobile, label: "手機", value: "0912345678")
        let b = Snippet(kind: .email, label: "Email", value: "jack@pathors.com")
        store.save([b, a])
        XCTAssertEqual(store.load().map(\.id), [b.id, a.id])

        // The same kind with the same value, written differently, is not added twice.
        let again = store.add(Snippet(kind: .mobile, label: "手機", value: "0912 345 678"))
        XCTAssertEqual(again.count, 2)
        // A different kind with the same value is a different snippet.
        XCTAssertEqual(store.add(Snippet(kind: .phone, label: "市話", value: "0912345678")).count, 3)
    }

    func testAnUnknownKindReadsAsCustom() throws {
        let store = SnippetStore(directory: directory)
        let json = """
            [{"id":"\(UUID().uuidString)","kind":"passport","label":"護照","value":"300000000"}]
            """
        try Data(json.utf8).write(to: store.fileURL)
        let loaded = store.load()
        XCTAssertEqual(loaded.first?.kind, .custom)
        XCTAssertEqual(loaded.first?.label, "護照")
    }

    // MARK: the revert chip

    func testRevertNeedsADifferentRawText() {
        XCTAssertNil(RevertOffer(inserted: "same", raw: "same"))
        XCTAssertNil(RevertOffer(inserted: "", raw: "x"))
        XCTAssertNil(RevertOffer(inserted: "x", raw: ""))
        XCTAssertEqual(RevertOffer(inserted: "Hello, world.", raw: "hello world")?.deleteCount, 13)
    }

    func testRevertOnlyWhileTheCursorIsRightAfterTheInsertion() throws {
        let offer = try XCTUnwrap(RevertOffer(inserted: "我們明天見。", raw: "我們明天見"))
        XCTAssertTrue(offer.cursorIsAfterInsertion(context: "好的，我們明天見。"))
        XCTAssertTrue(offer.cursorIsAfterInsertion(context: "我們明天見。"))
        // Typed after it, moved the cursor, or nothing to go on.
        XCTAssertFalse(offer.cursorIsAfterInsertion(context: "好的，我們明天見。嗯"))
        XCTAssertFalse(offer.cursorIsAfterInsertion(context: "好的，"))
        XCTAssertFalse(offer.cursorIsAfterInsertion(context: ""))
        XCTAssertFalse(offer.cursorIsAfterInsertion(context: nil))
        // A clipped context that is a short tail is not enough to tell.
        XCTAssertFalse(offer.cursorIsAfterInsertion(context: "見。"))
    }

    func testRevertBelievesALongClippedTail() throws {
        let long = String(repeating: "這是一段很長的聽寫內容，", count: 20)
        let offer = try XCTUnwrap(RevertOffer(inserted: long, raw: "raw"))
        XCTAssertTrue(offer.cursorIsAfterInsertion(context: String(long.suffix(100))))
        XCTAssertFalse(offer.cursorIsAfterInsertion(context: String(long.suffix(100)) + "x"))
    }
}
