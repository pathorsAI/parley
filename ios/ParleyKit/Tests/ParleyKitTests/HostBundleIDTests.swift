import XCTest

@testable import ParleyKit

/// Stands in for `_UIViewServiceViewControllerOperator`: an `NSObject` subclass
/// whose storage is an ivar named exactly what UIKit's is. A Swift stored
/// property on an `NSObject` subclass emits an ivar under the property's own
/// name, which `testTheStandInReallyDeclaresTheIvar` asserts rather than
/// assumes — if that ever stopped being true these tests would pass while
/// testing nothing.
private final class OperatorStandIn: NSObject {
    @objc var _hostBundleID: String?
}

/// Any other parent: a host whose view controller hierarchy is not the one we
/// expect. Reading an undefined key from this raises an Objective-C exception
/// Swift cannot catch, so the guard has to stop before KVC is reached.
private final class UnfamiliarParent: NSObject {}

final class HostBundleIDTests: XCTestCase {
    func testTheStandInReallyDeclaresTheIvar() {
        XCTAssertNotNil(
            class_getInstanceVariable(OperatorStandIn.self, "_hostBundleID"),
            "the stand-in must actually have the ivar, or every test below is vacuous")
    }

    func testReadsTheIvarOffTheParent() {
        let parent = OperatorStandIn()
        parent._hostBundleID = "com.apple.MobileSMS"
        XCTAssertEqual(HostBundleID.resolve(from: parent), "com.apple.MobileSMS")
    }

    /// The one that matters. The old implementation would have crashed here;
    /// this is the whole reason for the `class_getInstanceVariable` guard.
    func testAnUnfamiliarParentIsNilRatherThanACrash() {
        XCTAssertNil(HostBundleID.resolve(from: UnfamiliarParent()))
    }

    func testNoParentIsNil() {
        XCTAssertNil(HostBundleID.resolve(from: nil))
    }

    /// What iOS 26.4 does: the ivar is there, the value is gone.
    func testAnEmptyValueIsNil() {
        let parent = OperatorStandIn()
        parent._hostBundleID = ""
        XCTAssertNil(HostBundleID.resolve(from: parent))
    }

    func testUnsetIsNil() {
        XCTAssertNil(HostBundleID.resolve(from: OperatorStandIn()))
    }

    /// UIKit hands back the string "<null>" in some states, which is not a
    /// bundle id and would be launched as one.
    func testTheNullSentinelIsNotABundleID() {
        let parent = OperatorStandIn()
        parent._hostBundleID = "<null>"
        XCTAssertNil(HostBundleID.resolve(from: parent))
    }
}
