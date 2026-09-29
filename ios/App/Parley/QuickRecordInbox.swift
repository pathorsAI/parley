import Combine
import Foundation
import ParleyKit

/// Holds a "start recording" request from the lock screen until the Record tab
/// is there to act on it.
///
/// `parley://record` arrives in `ParleyApp.onOpenURL`, which on a cold launch
/// runs before the account check has finished and before `LiveView` — which
/// owns the recorder — exists. So the URL only leaves a note here, and
/// `LiveView` takes it when it next appears or the moment the note changes.
/// Taking it clears it: one tap is one recording, never two.
///
/// See `QuickRecord` for why the app is brought forward at all, and why a note
/// older than `QuickRecord.freshness` is dropped instead of obeyed.
@MainActor
final class QuickRecordInbox: ObservableObject {
    static let shared = QuickRecordInbox()

    @Published private(set) var requestedAt: Date?

    func post(now: Date = Date()) {
        requestedAt = now
    }

    /// The pending request, if it is still worth acting on. Clears it either
    /// way, so a stale note cannot come back later.
    func take(now: Date = Date()) -> Bool {
        guard let requestedAt else { return false }
        self.requestedAt = nil
        return QuickRecord.isFresh(requestedAt: requestedAt, now: now)
    }
}
