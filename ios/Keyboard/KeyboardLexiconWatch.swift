import ParleyKit
import UIKit

/// Watches for the user fixing a word right after dictating it, and teaches the
/// personal dictionary what they fixed.
///
/// The desktop does this with the Accessibility API: it reads the whole field it
/// pasted into and watches the value settle (`src-tauri/src/ax_observe.rs`). A
/// keyboard extension has none of that. What it has is
/// `textDocumentProxy.documentContextBeforeInput` — a clipped run of text ending
/// at the cursor, with no notification when anything changes and no way to read
/// past the clip. So the shape here is different: snapshot the window once, when
/// the dictated text has just landed, and compare it against the window again at
/// the two moments the editing is over. `LexiconCapture` (in ParleyKit) owns the
/// comparison and its refusals, and carries the tests for them.
///
/// ## What this can and cannot see — the v1 scope, stated plainly
///
/// **Only edits the user makes while this keyboard is still up in that same
/// field.** If they dismiss the keyboard, switch to another app, or move to
/// another field before fixing the word, the correction is never seen. There is
/// no API that would let a keyboard extension see it either: the field belongs
/// to the host app, and the only view of it is the proxy, which exists only
/// while we are the active input.
///
/// Two more limits worth knowing:
///
/// - **The window clips.** iOS gives no guarantee about how much text the proxy
///   returns, and it ends at the cursor rather than at the end of what we
///   inserted. In a field longer than the window, an edit that changes the
///   text's length slides the window's own start, and the two snapshots then
///   describe overlapping-but-offset stretches. The capture refuses whenever it
///   cannot see enough shared text to believe they are the same field: capturing
///   nothing beats capturing garbage, because garbage here becomes a rule that
///   rewrites the user's words from then on.
/// - **`viewWillDisappear` is not a promise.** iOS kills keyboard extensions
///   without ceremony. A correction lost to that is simply not learned, and the
///   next one will be.
///
/// Kept in its own file, wired to the controller through two one-line hooks, so
/// the concurrent change to one-shot-at-`done` insertion (#309) has nothing to
/// merge here.
final class KeyboardLexiconWatch {
    /// The field as it was when the dictated text had just landed. `nil`
    /// whenever there is nothing to compare against — before a session, and
    /// after a harvest.
    private var snapshot: String?

    /// The dictated text has been inserted; remember the field.
    ///
    /// Called with `state == .done`, which is after the last delta went in, so
    /// this is a picture of a finished dictation rather than of a sentence still
    /// arriving.
    func noteInserted(context: String?) {
        snapshot = LexiconCapture.window(context)
    }

    /// The editing is over: compare, diff, and record whatever the user taught
    /// us.
    ///
    /// Called from `viewWillDisappear` and from the start of the next session —
    /// the two moments at which the user has stopped fixing this piece of text.
    /// Clears the snapshot either way: harvesting the same edit twice would
    /// count one correction as two, and counting to two across two separate
    /// dictations is precisely what `Lexicon.autoApplyThreshold` is asking for.
    func harvest(context: String?) {
        guard let before = snapshot else { return }
        snapshot = nil
        LexiconStore.record(
            LexiconCapture.spans(before: before, after: LexiconCapture.window(context)))
    }
}
