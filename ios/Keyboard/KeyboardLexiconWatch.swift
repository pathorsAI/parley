import ParleyKit
import UIKit
import os

/// Watches for the user fixing a word right after dictating it, and teaches the
/// personal dictionary what they fixed.
///
/// The desktop does this with the Accessibility API: it reads the whole field it
/// pasted into and watches the value settle (`src-tauri/src/ax_observe.rs`). A
/// keyboard extension has none of that. What it has is the proxy's two clipped
/// runs of text either side of the cursor — `documentContextBeforeInput` and
/// `documentContextAfterInput` — with no notification when anything changes and
/// no way to read past the clip. So the shape here is different: snapshot the
/// field once, when the dictated text has just landed, and compare it against
/// the field again at the two moments the editing is over. `LexiconCapture` (in
/// ParleyKit) owns the comparison and its refusals, and carries the tests for
/// them.
///
/// ## Once per insertion
///
/// The snapshot is taken by the insertion itself (`noteInserted`, called from
/// the branch of `drainDownlink` that types the transcript), not by the `done`
/// state. `done` is republished on every drain, and the keyboard drains on
/// every appearance; snapshotting there meant a keyboard that came back after
/// the user had already fixed the word took the *fixed* field as its new
/// baseline, and the correction vanished from the comparison.
///
/// ## What this can and cannot see — the scope, stated plainly
///
/// **Only edits the user makes while this keyboard is still up in that same
/// field.** If they dismiss the keyboard, switch to another app, or move to
/// another field before fixing the word, the correction is never seen. There is
/// no API that would let a keyboard extension see it either: the field belongs
/// to the host app, and the only view of it is the proxy, which exists only
/// while we are the active input. The same goes for a fix made with another
/// keyboard, or after the message was sent — which is what "Fix this word" in
/// the app's dictation history is for.
///
/// Two more limits worth knowing:
///
/// - **The window clips.** iOS gives no guarantee about how much text the proxy
///   returns either side of the cursor, and this keeps at most
///   `LexiconCapture.windowLimit` characters of each. In a long field the two
///   snapshots describe overlapping-but-offset stretches; the capture refuses a
///   change that runs into a clipped edge, and anything not pinned by shared
///   text on both sides. Capturing nothing beats capturing garbage, because
///   garbage here becomes a rule that rewrites the user's words from then on.
/// - **`viewWillDisappear` is not a promise.** iOS kills keyboard extensions
///   without ceremony. A correction lost to that is simply not learned, and the
///   next one will be.
///
/// Kept in its own file, wired to the controller through one-line hooks: the
/// dictation's insertion and the revert chip's raw insertion (`noteInserted`,
/// which replaces the picture), and the keyboard leaving, the next session
/// starting, and text arriving from the strip or the 📋 panel (`harvest`, which
/// ends the watch — pasted text, possibly an ID number, is never a correction).
final class KeyboardLexiconWatch {
    /// Outcomes only. The words themselves are `.private` — redacted unless a
    /// device is attached to a debugger — because what someone typed into
    /// another app is not log material; the reasons and counts are what tell a
    /// capture that works from one that never fires.
    private static let log = Logger(
        subsystem: "com.pathors.parley.ios.keyboard", category: "lexicon")

    /// The field as it was when the dictated text had just landed. `nil`
    /// whenever there is nothing to compare against — before a session, and
    /// after a harvest.
    private var snapshot: LexiconCapture.Window?

    /// The dictated text has just been inserted; remember the field.
    ///
    /// Called once per insertion, right after the transcript is typed, so this
    /// is a picture of a finished dictation rather than of a sentence still
    /// arriving — and never of a field the user has already corrected.
    func noteInserted(_ proxy: UITextDocumentProxy) {
        snapshot = Self.window(proxy)
    }

    /// The editing is over: compare, diff, and record whatever the user taught
    /// us.
    ///
    /// Called from `viewWillDisappear` and from the start of the next session —
    /// the two moments at which the user has stopped fixing this piece of text.
    /// Clears the snapshot either way: harvesting the same edit twice would
    /// count one correction as two, and counting to two across two separate
    /// dictations is precisely what `Lexicon.autoApplyThreshold` is asking for.
    func harvest(_ proxy: UITextDocumentProxy) {
        guard let before = snapshot else { return }
        snapshot = nil
        let outcome = LexiconCapture.harvest(before: before, after: Self.window(proxy))
        for span in outcome.learned {
            Self.log.info(
                "learned \(span.original, privacy: .private) → \(span.replacement, privacy: .private)"
            )
        }
        for reason in outcome.refusals {
            Self.log.info("refused: \(reason.rawValue, privacy: .public)")
        }
        Self.log.info(
            "harvest: \(outcome.learned.count, privacy: .public) learned, \(outcome.refusals.count, privacy: .public) refused"
        )
        LexiconStore.record(outcome.learned)
    }

    private static func window(_ proxy: UITextDocumentProxy) -> LexiconCapture.Window {
        LexiconCapture.Window(
            before: proxy.documentContextBeforeInput, after: proxy.documentContextAfterInput)
    }
}
