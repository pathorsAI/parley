package com.pathors.parley.ime

import java.util.concurrent.atomic.AtomicLong

/** Done, Failed or Cancelled: the session will never publish another state. */
fun DictationState.isTerminal(): Boolean =
    this is DictationState.Done || this is DictationState.Failed || this is DictationState.Cancelled

/**
 * Which field a dictation belongs to.
 *
 * [DictationService.activeSession] is process-scoped and outlives any one field,
 * which is what lets a dictation survive the input view being rebuilt — and also
 * what let it follow the user into the *next* field: its text is a `StateFlow`,
 * so re-collecting it in field B replayed field A's whole transcript into B, and
 * the polished commit landed there too. A password field was no exception.
 *
 * So every dictation is stamped with the token of the field it was started in,
 * and the keyboard writes a session's words only while that token is still the
 * current one. A new input target gets a new token; a restart of the *same*
 * editor (same package, same field id, `restarting`) keeps it, because that is
 * the app re-describing the field, not the user leaving it.
 *
 * Tokens come from one process-wide counter, so a keyboard instance that is
 * destroyed and recreated can never mistake its predecessor's session for its
 * own.
 */
class DictationFieldGate(private val nextToken: () -> Long = ::mintToken) {

    /** The token a dictation started now would carry. */
    var currentToken: Long = nextToken()
        private set

    private var attached = false
    private var packageName: String? = null
    private var fieldId: Int = 0

    /**
     * A field has been attached. Returns true when it is a different input
     * target from the last one, i.e. when any dictation in flight is no longer
     * this field's.
     */
    fun onStartInput(packageName: String?, fieldId: Int, restarting: Boolean): Boolean {
        val sameEditor = attached && restarting &&
            packageName == this.packageName && fieldId == this.fieldId
        attached = true
        this.packageName = packageName
        this.fieldId = fieldId
        if (sameEditor) return false
        currentToken = nextToken()
        return true
    }

    /** Whether a session stamped with [ownerToken] may write into the current field. */
    fun owns(ownerToken: Long): Boolean = ownerToken != NO_OWNER && ownerToken == currentToken

    companion object {
        /** Never minted: a session carrying it is nobody's. */
        const val NO_OWNER = 0L

        private val tokens = AtomicLong(NO_OWNER)

        fun mintToken(): Long = tokens.incrementAndGet()
    }
}

/**
 * What [DictationService] does with a start request when a session is already in
 * [DictationService.activeSession].
 */
object DictationAdoption {

    enum class Action {
        /** Nothing there: open the microphone. */
        START,

        /** The same field asked twice. Watch the running session; no second microphone. */
        ADOPT,

        /**
         * A finished session nobody committed (its keyboard died with it), or a
         * live one belonging to another field. Neither may be handed to the
         * caller — the first would type stale words into an unrelated field —
         * so it is disposed and a fresh one started.
         */
        REPLACE,
    }

    fun decide(existing: DictationState?, existingOwner: Long, requestedOwner: Long): Action = when {
        existing == null -> Action.START
        existing.isTerminal() -> Action.REPLACE
        existingOwner == requestedOwner -> Action.ADOPT
        else -> Action.REPLACE
    }
}

/**
 * Whether the composing region the keyboard wrote is still in the field.
 *
 * The app can take the composing text away under us — a chat app's Send button
 * commits it and clears the field. Committing the polished text after that would
 * type it a second time into an empty box. The editor tells us through
 * `onUpdateSelection`: candidates of -1/-1 mean there is no composing region.
 *
 * "Gone" needs a region to have been *seen* first, because selection updates
 * are asynchronous: one reporting the state from before our first
 * `setComposingText` can arrive after it, and must not read as a loss. An editor
 * that never reports candidates at all therefore keeps the old behaviour.
 */
class ComposingSpanTracker {

    private var seen = false

    /** True once a region we saw has disappeared and not come back. */
    var isGone: Boolean = false
        private set

    fun onSelectionUpdate(candidatesStart: Int, candidatesEnd: Int) {
        if (candidatesStart >= 0 && candidatesEnd >= 0) {
            seen = true
            isGone = false
        } else if (seen) {
            isGone = true
        }
    }

    fun reset() {
        seen = false
        isGone = false
    }
}

/**
 * Whether the keyboard may swap the final text in for the composing region.
 *
 * `commitText` replaces the composing region when there is one and *inserts at
 * the cursor* when there is not. So once the app has taken the region away — sent
 * the message, cleared the box — committing the polished text would type the
 * dictation a second time. The keyboard therefore commits only while the region
 * is demonstrably still the text it wrote, and otherwise leaves the field as it is.
 */
object FinalCommit {

    enum class Action {
        /** Replace the composing region with the final text. */
        COMMIT,

        /**
         * Settle whatever is there (`finishComposingText`) and write nothing:
         * the region is gone, or no longer holds what the keyboard composed.
         */
        LEAVE,
    }

    /**
     * @param regionGone what [ComposingSpanTracker.isGone] says.
     * @param textBeforeCursor the editor's text before the cursor, at least as
     *   long as [composed]; null when the editor will not say.
     * @param composed the text the keyboard last passed to `setComposingText`.
     */
    fun decide(regionGone: Boolean, textBeforeCursor: CharSequence?, composed: String): Action = when {
        regionGone -> Action.LEAVE
        composed.isEmpty() -> Action.COMMIT
        textBeforeCursor == null -> Action.COMMIT
        textBeforeCursor.endsWith(composed) -> Action.COMMIT
        else -> Action.LEAVE
    }
}
