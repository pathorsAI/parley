package com.pathors.parley.kit

import kotlinx.serialization.Serializable

/**
 * The four items of the library's getting-started checklist, in display order.
 *
 * The Android counterpart of iOS `GettingStartedStep`
 * (`ios/ParleyKit/Sources/ParleyKit/GettingStartedState.swift`) and the
 * desktop's `GettingStartedStep` (`src/lib/types.ts`). The desktop calls the last
 * item `handedOff` because an MCP client's first call ticks it too; on a phone the
 * hand-off is the share sheet or the clipboard, so it is named for that.
 */
enum class GettingStartedStep {
    RECORDED,
    FILED,
    REPLAYED,
    SHARED_TO_AI,
}

/**
 * What the checklist knows, as a value.
 *
 * Kept apart from the store that persists it so the rules — idempotent marks,
 * when the list is visible, who counts as an existing user — are plain JVM code
 * a unit test can drive without a device.
 *
 * Same philosophy as the desktop and iOS: each flag flips only from a real
 * product event (a recording saved, a recording filed, a seek in replay, a
 * transcript handed to an AI) and never from a tap on the checklist itself.
 */
@Serializable
data class GettingStartedState(
    val recorded: Boolean = false,
    val filed: Boolean = false,
    val replayed: Boolean = false,
    val sharedToAI: Boolean = false,
    /** Epoch ms when the user closed the list. Set, the list stays closed. */
    val dismissedAtMs: Long? = null,
) {

    operator fun get(step: GettingStartedStep): Boolean = when (step) {
        GettingStartedStep.RECORDED -> recorded
        GettingStartedStep.FILED -> filed
        GettingStartedStep.REPLAYED -> replayed
        GettingStartedStep.SHARED_TO_AI -> sharedToAI
    }

    /**
     * Tick an item. Idempotent: returns this same instance, unchanged, when the
     * item was already done — so the store can compare by identity and skip the
     * write.
     */
    fun marking(step: GettingStartedStep): GettingStartedState {
        if (this[step]) return this
        return when (step) {
            GettingStartedStep.RECORDED -> copy(recorded = true)
            GettingStartedStep.FILED -> copy(filed = true)
            GettingStartedStep.REPLAYED -> copy(replayed = true)
            GettingStartedStep.SHARED_TO_AI -> copy(sharedToAI = true)
        }
    }

    fun dismissed(atMs: Long): GettingStartedState = copy(dismissedAtMs = atMs)

    /** How many of the four are done. */
    val done: Int get() = GettingStartedStep.entries.count { this[it] }

    val isComplete: Boolean get() = done == TOTAL

    /** Shown until the user closes it or finishes all four. */
    val isVisible: Boolean get() = dismissedAtMs == null && !isComplete

    /**
     * Whether the library draws the list, given what it knows so far.
     *
     * - [libraryLoaded]: the personal library has come back from the cloud at
     *   least once since the screen was built.
     * - [existingUserChecked]: the once-per-install existing-user check
     *   ([shouldDismissForExistingLibrary]) has already run on this phone, or the
     *   user asked for the list back from the account sheet — either way nothing
     *   the load brings back can dismiss it any more.
     * - [libraryIsEmpty]: no recordings, the sample included.
     *
     * A visible list waits for the load only while that check is still pending,
     * so it cannot flash up and then vanish under an existing user. Once the
     * check is behind it the list is local state and is drawn at once, with the
     * recordings filling in underneath.
     *
     * One more rule, which does need the load: an empty library shows the list
     * even with all four done, because an empty library is exactly where someone
     * needs the way in. "Not now" still wins.
     */
    fun showsInLibrary(
        libraryLoaded: Boolean,
        existingUserChecked: Boolean,
        libraryIsEmpty: Boolean,
    ): Boolean {
        if (isVisible) return libraryLoaded || existingUserChecked
        return libraryLoaded && libraryIsEmpty && dismissedAtMs == null
    }

    /**
     * The second, later existing-user check: the first time the personal
     * library loads.
     *
     * Catches the case the stored session cannot — someone who has used Parley
     * on a Mac and signs in on a new phone. A library that already holds
     * recordings (the sample does not count) with nothing on the list done yet
     * means the recordings were made elsewhere, by an existing user. Anything
     * already ticked means the recordings are this user's first steps, and the
     * list stays.
     */
    fun shouldDismissForExistingLibrary(recordingCount: Int): Boolean =
        dismissedAtMs == null && done == 0 && recordingCount > 0

    companion object {
        val TOTAL: Int = GettingStartedStep.entries.size

        /**
         * The state a phone starts with the first time a build that has the
         * checklist runs.
         *
         * [hadStoredSession] is whether a session token was already stored
         * before anything in this launch could have written one — the user
         * signed in under an earlier build. They have used Parley and do not
         * need walking through it, so the list starts dismissed.
         */
        fun initial(hadStoredSession: Boolean, nowMs: Long): GettingStartedState =
            GettingStartedState(dismissedAtMs = if (hadStoredSession) nowMs else null)
    }
}
