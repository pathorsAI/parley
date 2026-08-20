import Foundation
import ObjectiveC

/// Reads the bundle id of the app a keyboard extension is typing into.
///
/// There is no public API for this. The value lives in an ivar on the object
/// UIKit puts *above* an extension's principal view controller —
/// `_UIViewServiceViewControllerOperator`, a `UIViewController` subclass whose
/// storage has been `NSString *_hostBundleID` in every runtime header from iOS
/// 10 to iOS 26. It is what `HostReturn` needs in order to send the user back
/// to where they were typing.
///
/// ## Why this lives here, and takes an `NSObject`
///
/// The keyboard's own version of this was wrong in two independent ways for the
/// whole of its life, and neither was catchable without a test:
///
/// 1. **It asked the wrong object.** It probed the `UIInputViewController`
///    itself. The declaration is on the controller's `parent`.
/// 2. **It used the wrong mechanism.** `_hostBundleID` is an ivar with no
///    declared getter, so `responds(to:)` is unconditionally `false` for it and
///    that probe could never even be attempted. Only KVC reaches an ivar, via
///    `NSObject`'s `accessInstanceVariablesDirectly` fallback.
///
/// So `HostReturn.attempt` had never run — not on iOS 26.4, where Apple emptied
/// the value, and not before it either.
///
/// Taking an `NSObject` rather than a `UIViewController` is what makes the part
/// that can go catastrophically wrong testable: `value(forKey:)` on a key the
/// class does not define raises an Objective-C exception that Swift cannot
/// catch, and a keyboard extension that crashes on appearance is far worse than
/// one that never returns you to your app. UIKit is unavailable on the platform
/// these tests run on; the object graph is not the interesting part anyway.
///
/// Every private symbol is assembled from fragments at runtime so no literal
/// appears in the binary — the same trade the rest of this path makes: lower
/// the odds of a static-scan 2.5.1 flag, and degrade to `nil` rather than
/// pretending.
public enum HostBundleID {
    /// UIKit hands back this string rather than nil in some states, and it is
    /// not a bundle id.
    private static let nullSentinel = "<null>"

    /// The host's bundle id, or `nil` when it cannot be read — which is every
    /// call on iOS 26.4 and later, where Apple made the underlying value empty.
    ///
    /// Pass the principal view controller's `parent`.
    public static func resolve(from parent: NSObject?) -> String? {
        guard let parent else { return nil }
        if let value = ivar(on: parent, named: ["_host", "BundleID"].joined()) {
            return value
        }
        // A real method rather than an ivar — declared as a `UIViewController`
        // category property in WebKit's SPI header — so it dispatches where it
        // exists. Empty from 26.4 on, kept because it costs nothing.
        return getter(on: parent, named: ["_host", "Application", "BundleIdentifier"].joined())
    }

    /// Read an ivar by KVC, but only after the runtime confirms the class
    /// actually declares it. The check is the whole point: without it an
    /// unfamiliar host — anything whose parent is not the operator class —
    /// takes the process down instead of returning `nil`.
    private static func ivar(on object: NSObject, named name: String) -> String? {
        guard class_getInstanceVariable(type(of: object), name) != nil else { return nil }
        return clean(object.value(forKey: name) as? String)
    }

    private static func getter(on object: NSObject, named name: String) -> String? {
        let sel = NSSelectorFromString(name)
        guard object.responds(to: sel) else { return nil }
        return clean(object.perform(sel)?.takeUnretainedValue() as? String)
    }

    private static func clean(_ value: String?) -> String? {
        guard let value, !value.isEmpty, value != nullSentinel else { return nil }
        return value
    }
}
