package com.pathors.parley.voicetyping

/**
 * The three editor operations dictation needs, abstracted away from
 * `InputConnection` so the commit rule below can be unit-tested on the JVM.
 *
 * The names and the semantics are `InputConnection`'s:
 * * [commitText] replaces the composing region (if any) with [text] and ends
 *   composition — this is how a settled word displaces the tentative guess that
 *   preceded it without ever showing both.
 * * [setComposingText] replaces the composing region with [text], marking it as
 *   provisional (the host editor underlines it).
 * * [finishComposing] leaves the composing text in place as ordinary text.
 */
interface DictationEditor {
    fun commitText(text: String)

    fun setComposingText(text: String)

    fun finishComposing()
}

/**
 * Turns the relay's (settled, tail) transcript into editor operations, so
 * dictated words never appear twice.
 *
 * ## The rule
 *
 * [SegmentBuilder][com.pathors.parley.kit.SegmentBuilder] emits two kinds of
 * segment, and the difference is the whole problem:
 *
 * * **Committed runs** (`mix-0`, `mix-1`, …) — settled text. A run keeps growing
 *   under the *same* id until an endpoint or a speaker change closes it, so the
 *   concatenation of all runs only ever grows **by appending at the end**.
 * * **The tail** (`mix-tail`) — the provider's tentative guess at what is being
 *   said right now. It is rewritten wholesale on nearly every frame, and its
 *   words re-appear a moment later inside a committed run.
 *
 * So the tail must never be *committed*: it goes in as **composing text**, which
 * the next operation replaces. Settled growth is committed as a delta measured
 * against a high-water mark ([committed]). Because `commitText` implicitly
 * replaces the composing region, committing the delta also erases the stale
 * tail in the same call — which is exactly why the user never sees
 * "hello hello".
 *
 * This mirrors the desktop (`src-tauri/src/voice_typing.rs` + the overlay, which
 * renders committed runs solid and the tail faint, then pastes the settled
 * result) and iOS (`DictationCoordinator`, which keeps `committed`/`partial`
 * apart and only ever inserts the committed delta).
 *
 * ## End of session
 *
 * [finish] mirrors `DictationCoordinator.finishUp`: whatever is still composing
 * is the last thing the user said, so it is kept as real text rather than
 * discarded. The session normally folds the tail into the settled text itself,
 * in which case there is nothing composing left and [finish] is a no-op — both
 * orders are safe.
 *
 * Not thread-safe: drive it from the main thread (which is where an
 * `InputConnection` must be touched anyway).
 */
class TranscriptCommitter(private val editor: DictationEditor) {

    /** Everything already committed to the editor by this session. */
    private var committed = ""

    /** What the editor's composing region currently holds. */
    private var composing = ""

    /**
     * Apply one transcript update.
     *
     * @param settled all committed runs, concatenated — expected to extend what
     *   was passed last time.
     * @param tail the tentative tail; empty clears the composing region.
     */
    fun update(settled: String, tail: String) {
        if (settled.startsWith(committed)) {
            val delta = settled.substring(committed.length)
            if (delta.isNotEmpty()) {
                // Replaces the composing region *and* ends composition, so the
                // stale tail cannot survive into the document.
                editor.commitText(delta)
                committed = settled
                composing = ""
            }
        } else {
            // Defensive, and unreachable through `SegmentBuilder`: settled runs
            // only ever grow at the end, so settled text is append-only. If a
            // provider ever did rewrite it, there is nothing honest to do —
            // already-typed characters cannot be retracted through this
            // interface — so resync the high-water mark and keep the *later*
            // growth correct rather than typing a garbled splice.
            committed = settled
        }
        if (tail != composing) {
            editor.setComposingText(tail)
            composing = tail
        }
    }

    /**
     * The session ended: keep the tentative tail as real text. Idempotent.
     */
    fun finish() {
        if (composing.isNotEmpty()) {
            editor.finishComposing()
            committed += composing
            composing = ""
        }
    }

    /**
     * Forget this session's high-water mark and drop any composing text still on
     * screen — called when a *new* dictation starts, so the delta is measured
     * against the new session rather than the old one.
     *
     * Dropping rather than keeping is deliberate: an abandoned tail was never
     * settled, and the cursor may have moved (or be in a different field
     * entirely) since it was shown.
     */
    fun reset() {
        if (composing.isNotEmpty()) {
            editor.setComposingText("")
        }
        committed = ""
        composing = ""
    }

    /** Whether a composing region is currently on screen. */
    val hasComposingText: Boolean
        get() = composing.isNotEmpty()
}
