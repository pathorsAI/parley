import Foundation
import ObjectiveC

/// Asks LaunchServices which app is frontmost, from the *container app* rather
/// than from the keyboard extension.
///
/// This is a probe, not a fix. Nothing in it has been observed to work on a
/// device; it exists because the path it replaces is observably dead and the
/// only way to find out whether this one is any better is to ship it behind the
/// same switches. Read `HostReturnPolicy` before reading this — the kill
/// switch, the per-OS override and the ledger are what make an unproven private
/// call an acceptable thing to attempt at all.
///
/// ## Why there is a second source of the host at all
///
/// `HostBundleID` reads the host's bundle id inside the keyboard, out of
/// `_UIViewServiceViewControllerOperator`. On iOS 26.4 and later Apple emptied
/// both of the values it reads, so `DictationCoordinator.begin()` now fails its
/// `guard let host` and the jump back is never even attempted — the user is
/// left in Parley with no way home but a swipe.
///
/// The premise was that Apple's DTS had said
/// `LSApplicationWorkspace.frontmostApplication` is unavailable *from an
/// extension*, and that the container app is not an extension. Both halves of
/// that read stronger than they are, and the honest place to write down why is
/// next to the code they produced.
///
/// ## What is actually known, which is worse than the premise
///
/// DTS was asked the two questions separately — can a keyboard identify its
/// host, and can the container app identify which app hosted the extension that
/// opened it — and answered "No" to each (developer forums thread 826851, June
/// 2026, tested against 26.4.2). FB22247647 is open and unscheduled. The
/// engineer who answered called host identity "an obvious privacy concern" and
/// sketched a replacement that returns the user without naming the app, which
/// is the strongest available signal that no future API will hand over a bundle
/// id at all.
///
/// And `frontmostApplication` does not appear in any published
/// `LSApplicationWorkspace` header. It is `NSWorkspace`'s property, on macOS.
/// The likeliest outcome of everything below is therefore not that the call is
/// refused, but that `responds(to:)` is false and no message is ever sent.
///
/// That leaves this as a probe with a low prior rather than a fix, and the
/// reason to keep it is that it is cheap and that the alternative is inferring
/// what this fleet's devices do from someone else's forum post. What it costs
/// if it is never going to work is one class lookup and two `responds(to:)`
/// per dictation that begins with an empty uplink.
///
/// ## The race, and why the exclusion set is the interesting parameter
///
/// Even granting the call, the value we want is the app that was frontmost *a
/// moment ago*. By the time this code runs, Parley has been launched by the URL
/// and Parley is very likely what LaunchServices now considers frontmost — so a
/// working device's answer is "Parley", which is worthless. There are three
/// outcomes and they are worth telling apart on hardware: nothing responds (the
/// selector is not there), `nil` (it is there and refuses), or our own id (it
/// works and we asked too late).
///
/// That is why `excluding` is not hygiene. Returning Parley's own id would make
/// `HostReturn` relaunch Parley from Parley, which on a good day does nothing
/// and on a bad day is a loop. Extensions count as ours too — the keyboard is
/// `…parley.ios.keyboard` — so the match is "equal to, or a child of, an id we
/// were given".
///
/// ## The rules, which are `HostBundleID`'s rules
///
/// Every private symbol is assembled from fragments at runtime so no literal
/// appears in the binary. `NSClassFromString` and `responds(to:)` are checked
/// before any `perform`. `class_getInstanceVariable` is checked before any KVC,
/// because `value(forKey:)` on a key the class does not declare raises an
/// Objective-C exception that Swift cannot catch, and a crash on the way back
/// from a dictation would be far worse than never getting back. Every failure
/// path returns `nil` and none of them guesses.
///
/// One rule is new, and it is here because some of the selector names below are
/// guesses at names rather than reads of a header: the runtime is also asked
/// what a method *returns* before it is sent. `responds(to:)` cannot answer
/// that, and `perform` treats every result as an object pointer — so a
/// same-named method that happens to return an integer would put a scalar
/// through `takeUnretainedValue()` and crash exactly the probe that was written
/// not to.
///
/// The workspace is injected for the same reason `HostBundleID.resolve` takes
/// an `NSObject`: the dangerous half — sending assembled selectors to an object
/// of an unknown class, and reading ivars off it — is then exercisable on a
/// machine that has no LaunchServices at all.
///
/// ## What is deliberately not here
///
/// SpringBoardServices (`SBSCopyFrontmostApplicationDisplayIdentifier`) is the
/// other classic answer to this question and is not attempted. Two reasons, and
/// the first is enough on its own: reaching it means a `dlopen` of a private
/// framework by path, which is the single most legible thing a static scan can
/// find. The second is that the function's prototype genuinely differs between
/// eras of the SDK — some headers return the string, others return an error and
/// write the string through an out-parameter — and calling a C function through
/// the wrong prototype is how a probe designed to degrade to `nil` becomes a
/// crash instead.
public enum HostFrontmost {
    /// Handed back rather than `nil` in some states, and it is not a bundle id.
    private static let nullSentinel = "<null>"

    /// The frontmost app's bundle id, excluding our own app and its extensions,
    /// or `nil` — which is what we expect, and what every failure returns.
    ///
    /// Pass every bundle id that is ours: the app's, and anything below it.
    public static func resolve(excluding ours: Set<String>) -> String? {
        resolve(from: defaultWorkspace(), excluding: ours)
    }

    /// The half worth testing: everything after LaunchServices has handed us an
    /// object of a class we cannot name at compile time.
    public static func resolve(from workspace: NSObject?, excluding ours: Set<String>) -> String? {
        guard let workspace else { return nil }
        return candidates(from: workspace).first { !isOurs($0, ours) }
    }

    /// `+[LSApplicationWorkspace defaultWorkspace]`, or `nil` off iOS and on any
    /// iOS that has stopped vending it. Same two-step as `HostReturn.attempt`,
    /// duplicated rather than shared because that file lives in the app target
    /// and this one has to be reachable from the tests.
    private static func defaultWorkspace() -> NSObject? {
        let className = ["LSApplication", "Workspace"].joined()
        guard let cls = NSClassFromString(className) as? NSObject.Type else { return nil }
        let sel = NSSelectorFromString(["default", "Workspace"].joined())
        guard cls.responds(to: sel),
            returnsAnObject(class_getClassMethod(cls, sel))
        else { return nil }
        return cls.perform(sel)?.takeUnretainedValue() as? NSObject
    }

    /// Every bundle id the workspace will admit to, best first. Both probes are
    /// run even when the first answers, because the first answering with *our
    /// own* id is a likely outcome and the second may still be describing
    /// something else.
    private static func candidates(from workspace: NSObject) -> [String] {
        var found: [String] = []
        // -[LSApplicationWorkspace frontmostApplication] → an LSApplicationProxy,
        // if it exists at all. No published header for the class declares it —
        // the name belongs to `NSWorkspace` on macOS — so the expected result
        // here is that `responds(to:)` is false and nothing is sent.
        if let proxy = object(on: workspace, named: ["frontmost", "Application"].joined()),
            let id = bundleID(ofProxy: proxy)
        {
            found.append(id)
        }
        // The same question asked in one hop instead of two. Also undeclared
        // anywhere, and a guess at a name rather than a read of a header, which
        // is what the return-type check below exists for. A workspace that
        // answers this while refusing the proxy is the sort of asymmetry a probe
        // is for, and costs a `responds(to:)` to rule out.
        if let id = string(on: workspace, named: ["frontmost", "ApplicationIdentifier"].joined()) {
            found.append(id)
        }
        return found
    }

    /// An `LSApplicationProxy` names itself two ways and stores it a third. The
    /// selectors are tried first because a declared getter is the only one of
    /// the three that is contractually a `String`; the ivar is the last resort
    /// and is reached only after the runtime confirms the class declares it.
    private static func bundleID(ofProxy proxy: NSObject) -> String? {
        if let id = string(on: proxy, named: ["application", "Identifier"].joined()) { return id }
        if let id = string(on: proxy, named: ["bundle", "Identifier"].joined()) { return id }
        return ivar(on: proxy, named: ["_bundle", "Identifier"].joined())
    }

    private static func object(on target: NSObject, named name: String) -> NSObject? {
        guard let sel = objectReturning(on: target, named: name) else { return nil }
        return target.perform(sel)?.takeUnretainedValue() as? NSObject
    }

    private static func string(on target: NSObject, named name: String) -> String? {
        guard let sel = objectReturning(on: target, named: name) else { return nil }
        return clean(target.perform(sel)?.takeUnretainedValue() as? String)
    }

    /// `responds(to:)`, and then the question `responds(to:)` does not answer.
    ///
    /// `perform` treats every result as an object pointer, so a selector that
    /// turns out to name an integer- or `BOOL`-returning method would hand a
    /// scalar to `takeUnretainedValue()` and take the process down. That is a
    /// real risk here and not a theoretical one, because some of these
    /// selectors are guesses at names rather than reads of a header — so the
    /// runtime is asked what the method returns before the message is sent,
    /// exactly as it is asked whether the ivar exists before KVC.
    private static func objectReturning(on target: NSObject, named name: String) -> Selector? {
        let sel = NSSelectorFromString(name)
        guard target.responds(to: sel),
            returnsAnObject(class_getInstanceMethod(type(of: target), sel))
        else { return nil }
        return sel
    }

    /// `@` — an object — as opposed to `i`, `q`, `B`, `v` and the rest.
    private static func returnsAnObject(_ method: Method?) -> Bool {
        guard let method else { return false }
        let encoding = method_copyReturnType(method)
        defer { free(encoding) }
        return encoding.pointee == Int8(UInt8(ascii: "@"))
    }

    /// KVC, but only once the runtime has confirmed the class actually declares
    /// the ivar. The check is the whole point — without it an unfamiliar proxy
    /// takes the process down instead of returning `nil`.
    private static func ivar(on target: NSObject, named name: String) -> String? {
        guard class_getInstanceVariable(type(of: target), name) != nil else { return nil }
        return clean(target.value(forKey: name) as? String)
    }

    /// Ours, or one of ours: `com.pathors.parley.ios` excludes
    /// `com.pathors.parley.ios.keyboard` without being told about it, and
    /// without excluding an unrelated app whose id merely starts the same way.
    private static func isOurs(_ id: String, _ ours: Set<String>) -> Bool {
        ours.contains(id) || ours.contains { id.hasPrefix($0 + ".") }
    }

    private static func clean(_ value: String?) -> String? {
        guard let value, !value.isEmpty, value != nullSentinel else { return nil }
        return value
    }
}
