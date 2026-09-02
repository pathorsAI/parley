import XCTest

@testable import ParleyKit

/// Stands in for `LSApplicationWorkspace`: an `NSObject` whose only interesting
/// property is that it answers `frontmostApplication` with whatever we hand it.
private final class WorkspaceStandIn: NSObject {
    var proxy: NSObject?
    @objc func frontmostApplication() -> NSObject? { proxy }
}

/// A workspace that skips the proxy and names the app itself. Speculative on a
/// real device; here it is the only way to exercise the second probe.
private final class DirectWorkspaceStandIn: NSObject {
    var identifier: String?
    @objc func frontmostApplicationIdentifier() -> String? { identifier }
}

/// Both probes at once, so their order can be asserted rather than assumed.
private final class BothWaysWorkspaceStandIn: NSObject {
    var proxy: NSObject?
    var identifier: String?
    @objc func frontmostApplication() -> NSObject? { proxy }
    @objc func frontmostApplicationIdentifier() -> String? { identifier }
}

/// `LSApplicationProxy`'s canonical name for itself.
private final class ProxyStandIn: NSObject {
    var identifier: String?
    @objc func applicationIdentifier() -> String? { identifier }
}

/// The other declared getter, which is what `LSBundleProxy` contributes.
private final class BundleProxyStandIn: NSObject {
    var identifier: String?
    @objc func bundleIdentifier() -> String? { identifier }
}

/// No getters at all, only the ivar underneath them — the last resort, and the
/// only path in this file that reaches KVC.
private final class IvarOnlyProxyStandIn: NSObject {
    @objc var _bundleIdentifier: String?
}

/// Any other object: a workspace or a proxy whose class is not the one we
/// expect. Sending it an assembled selector must miss, and reading an undefined
/// key off it would raise an Objective-C exception Swift cannot catch — so the
/// guards have to stop before either happens.
private final class UnfamiliarObject: NSObject {}

/// The name we guessed, attached to a method that does not return an object.
/// `responds(to:)` says yes and `perform` would put the integer through
/// `takeUnretainedValue()`; only the return-type check stops it.
private final class ScalarWorkspaceStandIn: NSObject {
    @objc func frontmostApplicationIdentifier() -> Int { 42 }
}

/// The same trap one level down, on the proxy.
private final class ScalarProxyStandIn: NSObject {
    @objc func applicationIdentifier() -> Int { 42 }
}

private let ours: Set<String> = ["com.pathors.parley.ios"]

final class HostFrontmostTests: XCTestCase {
    func testTheStandInReallyDeclaresTheIvar() {
        XCTAssertNotNil(
            class_getInstanceVariable(IvarOnlyProxyStandIn.self, "_bundleIdentifier"),
            "the stand-in must actually have the ivar, or the KVC test below is vacuous")
    }

    // MARK: the happy path, which no device is known to take

    func testReadsTheIdentifierOffTheProxy() {
        let workspace = WorkspaceStandIn()
        let proxy = ProxyStandIn()
        proxy.identifier = "com.apple.MobileSMS"
        workspace.proxy = proxy
        XCTAssertEqual(
            HostFrontmost.resolve(from: workspace, excluding: ours), "com.apple.MobileSMS")
    }

    func testFallsBackToTheBundleIdentifierGetter() {
        let workspace = WorkspaceStandIn()
        let proxy = BundleProxyStandIn()
        proxy.identifier = "com.apple.mobilenotes"
        workspace.proxy = proxy
        XCTAssertEqual(
            HostFrontmost.resolve(from: workspace, excluding: ours), "com.apple.mobilenotes")
    }

    func testFallsBackToTheIvarWhenNeitherGetterExists() {
        let workspace = WorkspaceStandIn()
        let proxy = IvarOnlyProxyStandIn()
        proxy._bundleIdentifier = "com.apple.mobilesafari"
        workspace.proxy = proxy
        XCTAssertEqual(
            HostFrontmost.resolve(from: workspace, excluding: ours), "com.apple.mobilesafari")
    }

    func testAWorkspaceThatNamesTheAppDirectly() {
        let workspace = DirectWorkspaceStandIn()
        workspace.identifier = "com.apple.MobileSMS"
        XCTAssertEqual(
            HostFrontmost.resolve(from: workspace, excluding: ours), "com.apple.MobileSMS")
    }

    /// The proxy is asked first. Order is the only thing distinguishing the two
    /// probes, so it is asserted rather than left to reading the source.
    func testTheProxyIsPreferredToTheDirectIdentifier() {
        let workspace = BothWaysWorkspaceStandIn()
        let proxy = ProxyStandIn()
        proxy.identifier = "com.apple.MobileSMS"
        workspace.proxy = proxy
        workspace.identifier = "com.apple.mobilenotes"
        XCTAssertEqual(
            HostFrontmost.resolve(from: workspace, excluding: ours), "com.apple.MobileSMS")
    }

    /// The expected shape of a device where the call works but we asked too
    /// late: LaunchServices already considers Parley frontmost. The second
    /// probe is still worth running, which is why both are collected.
    func testASecondProbeIsUsedWhenTheFirstOnlyNamesUs() {
        let workspace = BothWaysWorkspaceStandIn()
        let proxy = ProxyStandIn()
        proxy.identifier = "com.pathors.parley.ios"
        workspace.proxy = proxy
        workspace.identifier = "com.apple.MobileSMS"
        XCTAssertEqual(
            HostFrontmost.resolve(from: workspace, excluding: ours), "com.apple.MobileSMS")
    }

    // MARK: the ones that matter — nothing may crash, nothing may guess

    /// The old `HostBundleID` bug in its other form. An unfamiliar workspace
    /// must miss on the selector rather than be sent one it does not implement.
    func testAnUnfamiliarWorkspaceIsNilRatherThanACrash() {
        XCTAssertNil(HostFrontmost.resolve(from: UnfamiliarObject(), excluding: ours))
    }

    /// The one the `class_getInstanceVariable` guard exists for: a proxy with
    /// no getters *and* no ivar. KVC on it would raise.
    func testAnUnfamiliarProxyIsNilRatherThanACrash() {
        let workspace = WorkspaceStandIn()
        workspace.proxy = UnfamiliarObject()
        XCTAssertNil(HostFrontmost.resolve(from: workspace, excluding: ours))
    }

    /// A guessed selector name that turns out to belong to a method returning a
    /// scalar. `responds(to:)` is `true` for it, so this is the case that gets
    /// past every guard except the return-type check.
    func testAScalarReturningWorkspaceSelectorIsNotSent() {
        XCTAssertNil(HostFrontmost.resolve(from: ScalarWorkspaceStandIn(), excluding: ours))
    }

    func testAScalarReturningProxySelectorIsNotSent() {
        let workspace = WorkspaceStandIn()
        workspace.proxy = ScalarProxyStandIn()
        XCTAssertNil(HostFrontmost.resolve(from: workspace, excluding: ours))
    }

    func testNoWorkspaceIsNil() {
        XCTAssertNil(HostFrontmost.resolve(from: nil, excluding: ours))
    }

    /// What we expect on iOS 26.4+: the selector is there, the answer is not.
    func testAWorkspaceWithNoFrontmostApplicationIsNil() {
        XCTAssertNil(HostFrontmost.resolve(from: WorkspaceStandIn(), excluding: ours))
    }

    func testAnEmptyIdentifierIsNil() {
        let workspace = WorkspaceStandIn()
        let proxy = ProxyStandIn()
        proxy.identifier = ""
        workspace.proxy = proxy
        XCTAssertNil(HostFrontmost.resolve(from: workspace, excluding: ours))
    }

    /// `"<null>"` is not a bundle id, and `HostReturn` would try to launch it.
    func testTheNullSentinelIsNotABundleID() {
        let workspace = WorkspaceStandIn()
        let proxy = ProxyStandIn()
        proxy.identifier = "<null>"
        workspace.proxy = proxy
        XCTAssertNil(HostFrontmost.resolve(from: workspace, excluding: ours))
    }

    func testAnEmptyIvarIsNil() {
        let workspace = WorkspaceStandIn()
        let proxy = IvarOnlyProxyStandIn()
        proxy._bundleIdentifier = ""
        workspace.proxy = proxy
        XCTAssertNil(HostFrontmost.resolve(from: workspace, excluding: ours))
    }

    // MARK: the exclusion set

    /// Answering with our own id would have `HostReturn` relaunch Parley from
    /// Parley.
    func testOurOwnBundleIDIsNotAHost() {
        let workspace = WorkspaceStandIn()
        let proxy = ProxyStandIn()
        proxy.identifier = "com.pathors.parley.ios"
        workspace.proxy = proxy
        XCTAssertNil(HostFrontmost.resolve(from: workspace, excluding: ours))
    }

    /// The keyboard is below the app, and is never told about separately.
    func testAnExtensionOfOursIsNotAHost() {
        let workspace = WorkspaceStandIn()
        let proxy = ProxyStandIn()
        proxy.identifier = "com.pathors.parley.ios.keyboard"
        workspace.proxy = proxy
        XCTAssertNil(HostFrontmost.resolve(from: workspace, excluding: ours))
    }

    /// "Child of" means the dot, not the characters. Someone else's app that
    /// happens to start the same way is a perfectly good host.
    func testAnUnrelatedIDThatMerelyStartsTheSameWayIsAHost() {
        let workspace = WorkspaceStandIn()
        let proxy = ProxyStandIn()
        proxy.identifier = "com.pathors.parley.iosclone"
        workspace.proxy = proxy
        XCTAssertEqual(
            HostFrontmost.resolve(from: workspace, excluding: ours), "com.pathors.parley.iosclone")
    }

    func testAnEmptyExclusionSetExcludesNothing() {
        let workspace = WorkspaceStandIn()
        let proxy = ProxyStandIn()
        proxy.identifier = "com.pathors.parley.ios"
        workspace.proxy = proxy
        XCTAssertEqual(
            HostFrontmost.resolve(from: workspace, excluding: []), "com.pathors.parley.ios")
    }

    // MARK: the real entry point

    /// These tests run on macOS, where `LSApplicationWorkspace` does not exist,
    /// so the class lookup misses and the whole thing degrades to `nil`. That is
    /// the behaviour worth pinning: the production entry point is reached from a
    /// platform it knows nothing about and does not raise.
    #if os(macOS)
        func testTheProductionEntryPointIsNilWhereLaunchServicesIsNot() {
            XCTAssertNil(HostFrontmost.resolve(excluding: ours))
        }
    #endif
}
