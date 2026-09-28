package com.pathors.parley.kit

/**
 * The guided lap's bar on the recording page: which step it shows, and the
 * short ✓ it holds between two steps. A port of iOS `ParleyKit/GuidedLap.swift`.
 *
 * Onboarding v1 ticked a checklist on the library and said nothing on the
 * recording itself, so a new user who opened the sample was left to guess what
 * to do there. The lap puts the next step on the page where it is done — file
 * it, replay it, hand it to an AI — and derives that step from the same
 * checklist state ([GettingStartedState]), so a step still ticks only from the
 * real event (principle 3 of `docs/design/onboarding.md`), wherever it happens.
 *
 * When a step is done while the bar is up, the bar does not jump straight to
 * the next one: it says what just happened for [HOLD_MS] first. That moment is
 * the lesson ("renamed and filed — every recording will do this"), and a bar
 * that swapped instantly would teach nothing. The hold is the only
 * time-dependent rule, so it lives here, takes the time as an argument, and is
 * tested rather than eyeballed.
 *
 * A value: every change returns a new lap, so a screen can hold it in a
 * `StateFlow` and redraw on each one.
 */
data class GuidedLap(
    /** The step the bar is on, as last observed. */
    val step: Step,
    /** Whether this bar has seen the lap unfinished — the condition for showing its finish. */
    val startedIncomplete: Boolean,
    /** The step whose ✓ is being held, or null. */
    private val confirming: Step? = null,
    /** Until when (epoch ms) [confirming] is held. */
    private val confirmingUntilMs: Long = 0L,
    /** "Close" on the done step. Local to this bar: the lap is over anyway. */
    val closed: Boolean = false,
) {

    enum class Step(
        /** The checklist item that finishes this step. Null for [DONE]. */
        val item: GettingStartedStep?,
    ) {
        FILE(GettingStartedStep.FILED),
        REPLAY(GettingStartedStep.REPLAYED),
        SHARE(GettingStartedStep.SHARED_TO_AI),
        DONE(null),
    }

    /** What the bar draws. */
    sealed interface Display {
        /** A step to do, or the finished lap. */
        data class Current(val step: Step) : Display

        /** [step] was just done; its ✓ is being held. */
        data class Confirmed(val step: Step) : Display
    }

    /**
     * Take in a new checklist state. A step that moved forward starts a ✓ for
     * the step that was up — the one the user just did. The same step again
     * changes nothing (a hold already running keeps its end); a step that
     * moved back is a reset from the account sheet, and confirms nothing.
     */
    fun observed(state: GettingStartedState, nowMs: Long): GuidedLap {
        val next = stepFor(state)
        val incomplete = startedIncomplete || !state.isComplete
        return when {
            next == step -> copy(startedIncomplete = incomplete)
            next > step -> copy(
                step = next,
                startedIncomplete = incomplete,
                confirming = step,
                confirmingUntilMs = nowMs + HOLD_MS,
            )
            else -> copy(step = next, startedIncomplete = incomplete, confirming = null, confirmingUntilMs = 0L)
        }
    }

    /** What to draw at [nowMs]. */
    fun display(nowMs: Long): Display {
        val held = confirming
        return if (held != null && nowMs < confirmingUntilMs) Display.Confirmed(held) else Display.Current(step)
    }

    /**
     * When [display] next changes by itself, so a screen can schedule one
     * redraw instead of polling. Null when nothing is being held.
     */
    fun holdEndsAtMs(nowMs: Long): Long? =
        confirmingUntilMs.takeIf { confirming != null && nowMs < it }

    /**
     * Whether the bar is drawn at all.
     *
     * - [isLapRecording]: the recording on screen is the sample, or the user's
     *   only recording — the lap is about *a* recording, and on the fortieth
     *   one it would be noise.
     * - The checklist must still be up (not dismissed, not finished) — except
     *   for the finish itself: a lap completed on this screen shows its done
     *   step, which is exactly the moment the checklist stops being visible.
     */
    fun isVisible(state: GettingStartedState, isLapRecording: Boolean): Boolean {
        if (!isLapRecording || state.dismissedAtMs != null || closed) return false
        return state.isVisible || (state.isComplete && startedIncomplete)
    }

    fun closing(): GuidedLap = copy(closed = true)

    companion object {
        /** How long a ✓ stays up before the next step replaces it. iOS `GuidedLap.hold`. */
        const val HOLD_MS: Long = 1_500L

        /** A bar that has just come up on [state]: nothing to confirm yet. */
        fun start(state: GettingStartedState): GuidedLap =
            GuidedLap(step = stepFor(state), startedIncomplete = !state.isComplete)

        /**
         * The first of filed → replayed → shared-to-AI not yet done, else
         * [Step.DONE]. `recorded` is not a step of the lap: the bar is only
         * ever on a recording. The order is fixed — a replay done early does
         * not skip the filing step.
         */
        fun stepFor(state: GettingStartedState): Step =
            Step.entries.firstOrNull { step -> step.item?.let { !state[it] } ?: false } ?: Step.DONE
    }
}
