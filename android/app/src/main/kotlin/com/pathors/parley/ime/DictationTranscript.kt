package com.pathors.parley.ime

import com.pathors.parley.kit.TranscriptSegment

/**
 * Assembles the relay's segments into the one string the input connection shows.
 *
 * The relay emits committed runs under a stable `"{prefix}-{index}"` id that it
 * **re-sends as the run grows**, plus a single tentative tail under
 * `"{source}-tail"` (see `SegmentBuilder`). So this is an upsert keyed by id, in
 * arrival order, never an append — the same rule `MeetingSession.byId` follows.
 *
 * ## Why dictation needs so much less than iOS
 *
 * iOS could not use the live text at all. `UITextDocumentProxy.insertText` cannot
 * be taken back, and "settled" is not "final" — the relay revises runs it has
 * already emitted — so a keyboard that inserted each delta collected the churn
 * in the user's document, and every bad ending left a half sentence behind
 * (`docs/design/ios-voice-keyboard.md`, "Why one insertion rather than a
 * stream"). It therefore held everything back and inserted once at the end,
 * which cost it a high-water mark of inserted characters, a three-state
 * done/cancelled downlink, and a 150-second adoption window.
 *
 * Android's composing text **is** retractable: `setComposingText` replaces the
 * whole composing region every time, and `commitText` settles it. A revised run
 * is just the next `setComposingText`. None of that iOS machinery has an
 * Android counterpart, which is why this class is a map and two accessors.
 *
 * Not thread-safe: the session drives it from one coroutine.
 */
class DictationTranscript {

    /** Committed runs by segment id. Insertion order is transcript order. */
    private val runs = LinkedHashMap<String, String>()

    /** The tentative tail — replaced wholesale, and cleared by an empty one. */
    var partial: String = ""
        private set

    /** How many tails have been folded, so each fold gets its own run id. */
    private var foldCount = 0

    /** Settled text only. What survives if the tail never arrives. */
    val committed: String
        get() = runs.values.joinToString(separator = "")

    /** What the input connection should be showing right now. */
    val live: String
        get() = committed + partial

    /** True when nothing has been heard yet — there is no text to keep or commit. */
    val isEmpty: Boolean
        get() = live.isBlank()

    /**
     * Take one segment from the relay. The tail replaces [partial]; anything else
     * upserts a run.
     */
    fun accept(segment: TranscriptSegment) {
        if (segment.id.endsWith(TAIL_SUFFIX)) {
            partial = segment.text
        } else {
            runs[segment.id] = segment.text
        }
    }

    /**
     * Turn the tail into a settled run, so the last few words spoken before the
     * user stopped are not lost when the tail is cleared.
     *
     * It has to become a *run* rather than be appended to some committed string:
     * [committed] is derived from [runs] on every read, so an append would be
     * overwritten by the next segment that arrives. iOS folds it the same way and
     * for the same reason (`DictationCoordinator.foldPartial`), under an id that
     * cannot collide with a relay-issued one.
     */
    fun foldPartial() {
        if (partial.isEmpty()) return
        runs["$FOLDED_ID_PREFIX${foldCount++}"] = partial
        partial = ""
    }

    /** Forget everything. A spent transcript is not reused; this is for tests. */
    fun reset() {
        runs.clear()
        partial = ""
        foldCount = 0
    }

    private companion object {
        /**
         * The suffix `SegmentBuilder.emitTail` stamps on the one tentative
         * segment. Every `-tail` check in the app and the cloud depends on this
         * exact shape.
         */
        const val TAIL_SUFFIX = "-tail"

        /**
         * A relay id is always `{prefix}-{index}`, where the prefix is `mix` or
         * `mix@{leg}`, so nothing it issues can begin with `folded` and a fold
         * cannot overwrite a run. Same id shape iOS uses for the same reason.
         */
        const val FOLDED_ID_PREFIX = "folded@"
    }
}
