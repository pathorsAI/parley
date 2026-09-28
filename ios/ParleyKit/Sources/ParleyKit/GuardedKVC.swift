import Foundation

/// Key-value coding for a key the object may not answer, without the crash.
///
/// `value(forKey:)` on a key an object does not define raises
/// `NSUnknownKeyException` — an Objective-C exception, which Swift cannot
/// catch, so the process dies. In an app that is a crash; in a keyboard
/// extension it is the keyboard vanishing mid-sentence, and it happens on
/// whatever path asked, which for the keyboard's field check is every text
/// and selection change.
///
/// So the question is asked first: does the object have a getter by that
/// name? Anything that does not is `nil`, the same answer as a getter that
/// returned nothing — "unknown" rather than a guess, and never a trap.
///
/// Only a getter counts. KVC would also fall back to reading an ivar of that
/// name, but a caller that needs the fallback has to prove the ivar exists
/// against the runtime itself — see `HostBundleID`, the one caller that does.
public enum GuardedKVC {
    /// `object.value(forKey: key)`, or `nil` when `object` is not an Objective-C
    /// object or does not respond to a getter named `key`.
    public static func value(forKey key: String, of object: AnyObject?) -> Any? {
        guard let object = object as? NSObject,
            object.responds(to: NSSelectorFromString(key))
        else { return nil }
        return object.value(forKey: key)
    }
}
