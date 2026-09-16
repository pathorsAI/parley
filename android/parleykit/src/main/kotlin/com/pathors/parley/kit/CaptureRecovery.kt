package com.pathors.parley.kit

/**
 * When to try to take the microphone back, how long to keep trying, and when to
 * stop pretending — as a state machine rather than as retries scattered through
 * the capture.
 *
 * A line-for-line port of iOS
 * `ios/ParleyKit/Sources/ParleyKit/CaptureRecovery.swift`, kept in this module
 * for the same reason that one lives in ParleyKit: it is the only part of
 * microphone recovery that can be tested without a microphone. The sequence
 * that produces the bug takes a real phone, a real interruption and a minute of
 * waiting to reproduce once, and is three lines in a test.
 *
 * ## The failure this exists for
 *
 * `MicCapture` was a deliberate one-shot: open an `AudioRecord`, read until it
 * fails, end the flow. The comment on it said, in as many words, "there is no
 * restart — build a new MicCapture". Everything downstream honoured that, so a
 * phone call, Google Assistant, or another recorder starting up ended the
 * meeting. The first wave of durability work made that survivable — the file is
 * finished and uploaded instead of deleted — but survivable is not the same as
 * recovered: the recording still *stopped*, forty seconds into an interruption
 * that lasted four.
 *
 * Android gives us three separate ways to learn about it and none of them is
 * reliable on its own:
 *
 * 1. **`AudioRecord.read` returns a negative code.** `ERROR_DEAD_OBJECT` or
 *    `ERROR_INVALID_OPERATION`. Honest, immediate — and only some devices do
 *    it.
 * 2. **`AudioRecordingCallback.isClientSilenced`.** From Android 10 an app that
 *    loses the microphone to a higher-priority client is fed *silence* rather
 *    than an error, and this callback is the only announcement. It is also the
 *    only one of the three that can fire while `read()` keeps happily returning
 *    success.
 * 3. **Nothing at all.** `read()` stops returning, or returns zeroes with no
 *    callback. This is what the watchdog is for.
 *
 * So the same two wrong assumptions iOS had to unlearn apply here:
 *
 * - **That the end of an interruption is announced.** It frequently is not:
 *   `isClientSilenced` can go true and never come back, because the other
 *   client released the microphone without the framework re-running our
 *   callback. Waiting for an "ended" that never arrives parks the capture
 *   forever.
 * - **That trying a handful of times is trying.** A short ladder runs out
 *   inside a route change. An in-call recording, a system dictation or another
 *   app's recorder holds the microphone for as long as the *user* is busy with
 *   it, which is tens of seconds, not five.
 *
 * Hence: probe even while interrupted (the only way to notice a missing end),
 * climb a ladder long enough to outlast an interruption rather than a route
 * change, and treat *giving up as a state that is still armed* — [Phase.LOST]
 * answers [Event.AppBecameActive] and [Event.AudioServerDied] with one more
 * rebuild, because those are the two events that change the answer.
 *
 * Giving up is not silence either. [Action.GiveUp] is the cue to tell the user
 * the microphone is gone, which is the difference between a meeting that has
 * stopped listening and one that only looks like it is still listening. It is
 * emphatically *not* a cue to throw the recording away: see
 * `meeting/CaptureEnding.kt` for why exactly one ending in this app deletes
 * audio and why it is the one a person asked for.
 *
 * Synchronized throughout, like `ReconnectPolicy`: the `AudioRecord` read
 * thread, the device-routing callback, the silenced-client callback, the
 * watchdog thread and the activity-lifecycle callback all reach this from
 * whichever thread the platform handed them.
 *
 * @property probeAfterMillis how long to wait before probing an interruption
 *   that has not announced its end. Long enough not to snatch the microphone
 *   back from whatever is mid-sentence in it, short enough that an interruption
 *   the user cancelled after a second is not paid for in ten.
 * @property resumeAfterMillis how long to wait after the interruption ends. The
 *   route is still settling; `AudioRecord.Builder` can still fail for a beat
 *   after the other client has let go.
 * @property maxAttempts attempts before the user is told. Twelve at this ladder
 *   is roughly half a minute of trying — long enough to outlast a call being
 *   answered and declined, where six attempts (under twelve seconds) could only
 *   ever outlast a route change.
 */
class CaptureRecovery(
    val probeAfterMillis: Long = DEFAULT_PROBE_AFTER_MILLIS,
    val resumeAfterMillis: Long = DEFAULT_RESUME_AFTER_MILLIS,
    val firstBackoffMillis: Long = DEFAULT_FIRST_BACKOFF_MILLIS,
    val backoffCapMillis: Long = DEFAULT_BACKOFF_CAP_MILLIS,
    val maxAttempts: Int = DEFAULT_MAX_ATTEMPTS,
) {
    init {
        require(probeAfterMillis >= 0) { "probeAfterMillis must not be negative" }
        require(resumeAfterMillis >= 0) { "resumeAfterMillis must not be negative" }
        require(firstBackoffMillis > 0) {
            "firstBackoffMillis must be positive (got $firstBackoffMillis)"
        }
        require(backoffCapMillis >= firstBackoffMillis) {
            "backoffCapMillis ($backoffCapMillis) must not be shorter than " +
                "firstBackoffMillis ($firstBackoffMillis)"
        }
        require(maxAttempts >= 1) { "maxAttempts must be at least 1 (got $maxAttempts)" }
    }

    /** Everything that can change the answer. */
    sealed interface Event {
        /**
         * Something with a higher claim has our input: `isClientSilenced` went
         * true, or `AudioRecord.read` returned an error. The Android equivalent
         * of iOS's `AVAudioSession` interruption `.began`.
         */
        data object Interrupted : Event

        /**
         * The interruption is over — `isClientSilenced` went false again.
         *
         * There is deliberately no "should resume" advisory in this event, for
         * the same reason iOS does not consult `AVAudioSession`'s: a recording
         * the user never stopped always wants the microphone back.
         */
        data object InterruptionEnded : Event

        /** A rebuild attempt opened and started an `AudioRecord`. */
        data class RebuildSucceeded(val sampleRate: Int = 0) : Event

        /**
         * A rebuild attempt failed.
         *
         * [systemHoldsInput] separates "somebody else has the microphone" —
         * `AudioRecord.Builder` throwing, `state != STATE_INITIALIZED`, or
         * `recordingState != RECORDSTATE_RECORDING`, all of which are what a
         * busy microphone looks like — from "this device's audio is broken",
         * which is the difference between a loss worth offering a retry for and
         * one worth naming.
         */
        data class RebuildFailed(
            val systemHoldsInput: Boolean,
            val description: String? = null,
        ) : Event

        /**
         * The app came to the foreground. Not an audio event at all, and that
         * is exactly why it matters: the platform is markedly more willing to
         * hand a foreground app the microphone, and this is the one state
         * change that can turn a refusal into an acceptance. Delivered from
         * `Application.ActivityLifecycleCallbacks.onActivityResumed`.
         */
        data object AppBecameActive : Event

        /**
         * `AudioRecord.read` returned `ERROR_DEAD_OBJECT`: the audio server
         * restarted and every `AudioRecord` in the process is a corpse — as is
         * the one the other client was holding. The Android analogue of iOS's
         * `mediaServicesWereResetNotification`, and worth trying again after
         * for exactly the same reason: whatever was holding the microphone died
         * with it.
         */
        data object AudioServerDied : Event

        /**
         * Capture can no longer be trusted for a reason that is ours rather
         * than the system's — the input route moved to a device we are not
         * recording from, or the watchdog noticed chunks stopped arriving.
         * Nobody is holding the microphone, so there is nothing to wait for.
         */
        data object CaptureStopped : Event

        /**
         * A fresh start — the user tapped record. Everything this policy was
         * remembering belongs to the capture that is being replaced.
         */
        data object Restarted : Event
    }

    /** What the capture should do about it. */
    sealed interface Action {
        /**
         * Nothing, and in particular not a rebuild: either the `AudioRecord` is
         * fine or a chain is already climbing the ladder.
         */
        data object Wait : Action

        /** Rebuild the `AudioRecord` after this delay. Zero means now. */
        data class Rebuild(val afterMillis: Long) : Action

        /** The ladder ran out. Tell the user, and stay armed. */
        data class GiveUp(val loss: Loss) : Action
    }

    /** Why the microphone is gone, in the only terms a user can act on. */
    sealed interface Loss {
        /**
         * Something else has the microphone. Putting the phone down and coming
         * back to Parley, or ending the call, fixes it — which is what the
         * banner copy offers.
         */
        data object TakenBySystem : Loss

        /** The audio stack itself refused, with a reason worth repeating. */
        data class Broken(val description: String?) : Loss
    }

    enum class Phase {
        /** The microphone is ours. */
        RUNNING,

        /** An interruption began and has not ended. Probes run anyway. */
        INTERRUPTED,

        /** A rebuild chain is climbing the ladder. */
        RECOVERING,

        /**
         * The ladder ran out and the user has been told. Still armed: the app
         * coming forward, or the audio server restarting, starts a fresh chain.
         */
        LOST,
    }

    @get:Synchronized
    var phase: Phase = Phase.RUNNING
        private set

    /** Consecutive failed rebuilds in the current chain. */
    @get:Synchronized
    var attempts: Int = 0
        private set

    /**
     * The chain started with the system taking the microphone. Kept because the
     * *last* error need not be the one that explains the situation — a probe
     * attempted while another app holds the input can surface as an
     * unsupported-configuration failure — and what the user is told has to
     * describe what happened, not the last thing that went wrong.
     */
    private var beganWithInterruption = false

    /**
     * The microphone is not ours right now, whether or not anyone has been told
     * yet. This is what stops the rest of the app from believing a capture that
     * cannot hear.
     */
    @get:Synchronized
    val holdsMicrophone: Boolean get() = phase == Phase.RUNNING

    /** The user has been told. Still armed — see [Phase.LOST]. */
    @get:Synchronized
    val hasGivenUp: Boolean get() = phase == Phase.LOST

    /** A chain is mid-climb, which is what suppresses the watchdog and route changes. */
    @get:Synchronized
    val isRecovering: Boolean get() = phase == Phase.RECOVERING || phase == Phase.INTERRUPTED

    /**
     * `1×, 2×, 4×, …` the first backoff, capped. A shift rather than `pow`, for
     * the same reason `ReconnectPolicy` uses one: it is exact, and it cannot
     * drift past the cap through floating point.
     */
    fun backoffFor(attempt: Int): Long {
        if (attempt < 1) return firstBackoffMillis
        val steps = minOf(attempt - 1, MAX_BACKOFF_STEPS)
        return minOf(firstBackoffMillis shl steps, backoffCapMillis)
    }

    /**
     * Total time the ladder spends trying before the user is told, counting
     * from the first failure. Exists for the test that keeps this honest about
     * outlasting an interruption a person is busy with.
     */
    val ladderMillis: Long
        get() = if (maxAttempts <= 1) 0L else (1 until maxAttempts).sumOf { backoffFor(it) }

    /**
     * The event table, deliberately flat and in the same order as the Swift
     * `switch` it was ported from, so the two platforms can still be diffed by
     * eye. The three events whose answer depends on the phase we are already in
     * delegate to a named function below rather than nesting a decision inside
     * an arm.
     *
     * Those helpers write [phase] and [attempts] without taking the lock
     * themselves, and are private so that this stays true: they are only ever
     * reached through this method, which holds it.
     */
    @Synchronized
    fun apply(event: Event): Action = when (event) {
        Event.Restarted, is Event.RebuildSucceeded -> {
            phase = Phase.RUNNING
            attempts = 0
            beganWithInterruption = false
            Action.Wait
        }

        Event.Interrupted -> onInterrupted()

        Event.InterruptionEnded -> {
            // Reached from LOST too: the system announcing that it is done with
            // the microphone is the best reason there has ever been to try
            // again, whatever this policy had concluded before it.
            phase = Phase.RECOVERING
            attempts = 0
            Action.Rebuild(resumeAfterMillis)
        }

        Event.AppBecameActive -> onAppBecameActive()

        // The same answer as [Event.InterruptionEnded], and today the same
        // delay — but deliberately *not* folded into one arm with it, because
        // it is not the same fact. That one is the other client announcing it
        // has let go; this one is every `AudioRecord` in the process dying with
        // the audio server that was holding it, ours included. Two reasons to
        // keep them apart. This file's stated value is being a line-for-line
        // port of `CaptureRecovery.swift`, where they are separate cases and a
        // reader can check the two platforms agree by looking. And
        // [resumeAfterMillis] is documented as the settle after an
        // *interruption* — of the numbers here it is the likeliest to want a
        // different value once a restarted audio server has been measured,
        // which a shared arm would silently apply to both.
        Event.AudioServerDied -> { // NOSONAR — S1871: same answer, different reasons; see above
            phase = Phase.RECOVERING
            attempts = 0
            Action.Rebuild(resumeAfterMillis)
        }

        Event.CaptureStopped -> {
            phase = Phase.RECOVERING
            attempts = 0
            Action.Rebuild(0)
        }

        is Event.RebuildFailed -> onRebuildFailed(event)
    }

    /**
     * [Event.Interrupted]: probe, unless a chain is already climbing.
     *
     * [beganWithInterruption] is recorded either way. The interruption happened
     * whether or not this is the call that starts the chain, and it is what the
     * eventual [Action.GiveUp] describes the loss with.
     */
    private fun onInterrupted(): Action {
        beganWithInterruption = true
        // A second beginning for an interruption already being handled says
        // nothing new, and answering it with another probe would only put a
        // second chain on the same `AudioRecord`.
        if (phase != Phase.RUNNING) return Action.Wait
        phase = Phase.INTERRUPTED
        attempts = 0
        // A probe rather than a wait. This is the *only* thing that can notice
        // an interruption whose end is never announced — and being refused
        // while the other client still holds the microphone costs one failed
        // open, which is what the ladder is for.
        return Action.Rebuild(probeAfterMillis)
    }

    /**
     * [Event.AppBecameActive]: one immediate attempt from every phase except
     * [Phase.RUNNING], where the microphone is already ours and there is
     * nothing to take back.
     */
    private fun onAppBecameActive(): Action {
        if (phase == Phase.RUNNING) return Action.Wait
        // The refusal that burned the ladder was "a backgrounded app, competing
        // with something in the foreground". Being in the foreground is the
        // other half of that answer.
        phase = Phase.RECOVERING
        attempts = 0
        return Action.Rebuild(0)
    }

    /** [Event.RebuildFailed]: the next rung of the ladder, or the end of it. */
    private fun onRebuildFailed(event: Event.RebuildFailed): Action {
        // Already given up: a straggler from the chain that gave up is not a
        // reason to tell the user twice.
        if (phase == Phase.LOST) return Action.Wait
        attempts += 1
        if (event.systemHoldsInput) beganWithInterruption = true
        if (attempts < maxAttempts) {
            phase = Phase.RECOVERING
            return Action.Rebuild(backoffFor(attempts))
        }
        phase = Phase.LOST
        // What the user is told has to describe what happened rather than the
        // last thing that went wrong — see [beganWithInterruption].
        return Action.GiveUp(
            if (beganWithInterruption || event.systemHoldsInput) {
                Loss.TakenBySystem
            } else {
                Loss.Broken(event.description)
            },
        )
    }

    companion object {
        const val DEFAULT_PROBE_AFTER_MILLIS = 2_500L
        const val DEFAULT_RESUME_AFTER_MILLIS = 250L
        const val DEFAULT_FIRST_BACKOFF_MILLIS = 250L
        const val DEFAULT_BACKOFF_CAP_MILLIS = 4_000L
        const val DEFAULT_MAX_ATTEMPTS = 12

        /** Shift ceiling; well past where [DEFAULT_BACKOFF_CAP_MILLIS] clamps anyway. */
        private const val MAX_BACKOFF_STEPS = 30
    }
}
