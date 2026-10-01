import XCTest

@testable import ParleyKit

/// Stands in for the text document proxy: an object that has the getter.
private final class ProxyStandIn: NSObject {
    @objc var documentIdentifier: UUID?
}

/// A proxy that does not: reading the key by plain KVC raises
/// `NSUnknownKeyException`, which Swift cannot catch.
private final class BareProxy: NSObject {}

final class GuardedKVCTests: XCTestCase {
    func testReadsAGetterThatExists() {
        let proxy = ProxyStandIn()
        let id = UUID()
        proxy.documentIdentifier = id
        XCTAssertEqual(
            GuardedKVC.value(forKey: "documentIdentifier", of: proxy) as? UUID, id)
    }

    /// Between fields the proxy answers with nothing, and that is nil rather
    /// than the trap the Swift property would be.
    func testAGetterThatReturnsNothingIsNil() {
        XCTAssertNil(GuardedKVC.value(forKey: "documentIdentifier", of: ProxyStandIn()))
    }

    /// The one that matters: unguarded, this is the process dying.
    func testAKeyTheObjectDoesNotAnswerIsNilRatherThanACrash() {
        XCTAssertNil(GuardedKVC.value(forKey: "documentIdentifier", of: BareProxy()))
    }

    func testNoObjectIsNil() {
        XCTAssertNil(GuardedKVC.value(forKey: "documentIdentifier", of: nil))
    }

    /// A Swift class that is not an `NSObject` has no KVC to ask.
    func testANonObjectiveCObjectIsNil() {
        final class Plain {}
        XCTAssertNil(GuardedKVC.value(forKey: "documentIdentifier", of: Plain()))
    }
}
