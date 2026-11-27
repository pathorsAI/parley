import XCTest

@testable import ParleyKit

/// The desktop's `toggleAgendaItem` cases (`src/lib/meeting/agenda.test.ts`).
final class MeetingAgendaTests: XCTestCase {
    func testTickingIsTheUsers() {
        let item = AgendaItem(id: "a", text: "Price").toggled()
        XCTAssertTrue(item.done)
        XCTAssertEqual(item.doneBy, "user")
        XCTAssertNil(item.doneAtMs)
    }

    func testUntickingAUserTickClearsWhoTicked() {
        let item = AgendaItem(id: "a", text: "Price", done: true, doneBy: "user").toggled()
        XCTAssertFalse(item.done)
        XCTAssertNil(item.doneBy)
        XCTAssertNil(item.aiDismissed)
    }

    func testUntickingAnAITickDismissesIt() {
        let item = AgendaItem(id: "a", text: "Price", done: true, doneBy: "ai", doneAtMs: 12_000).toggled()
        XCTAssertFalse(item.done)
        XCTAssertNil(item.doneBy)
        XCTAssertNil(item.doneAtMs)
        XCTAssertEqual(item.aiDismissed, true)
    }

    func testADraftTodoKeepsItsTick() {
        XCTAssertEqual(AgendaItem(CloudDraftTodo(id: "t", text: "x", done: true)).doneBy, "user")
        XCTAssertNil(AgendaItem(CloudDraftTodo(id: "t", text: "x")).doneBy)
    }

    func testTheMetaHasOnlyWhatIsSet() {
        let meta = AgendaItem(id: "a", text: "Price").metaValue
        XCTAssertEqual(Set(meta.keys), ["id", "text", "done"])
    }

    func testAPendingAgendaRoundTrips() throws {
        let items = [AgendaItem(id: "a", text: "Price", done: true, doneBy: "user")]
        let back = try JSONDecoder().decode([AgendaItem].self, from: JSONEncoder().encode(items))
        XCTAssertEqual(back, items)
    }
}
