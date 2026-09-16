package com.pathors.parley.audio

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Log
import com.pathors.parley.kit.CaptureRecovery
import java.util.concurrent.ConcurrentLinkedQueue
import kotlinx.coroutines.channels.ProducerScope
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.channels.trySendBlocking
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlin.math.max

/**
 * Failure modes of [MicCapture]. The [Flow] returned by [MicCapture.start] fails
 * with one of these; nothing else is thrown out of the flow.
 */
sealed class MicCaptureException(message: String, cause: Throwable? = null) :
    Exception(message, cause) {

    /** `RECORD_AUDIO` was not granted when capture started. */
    class PermissionDenied :
        MicCaptureException("RECORD_AUDIO permission is not granted")

    /** No usable AudioRecord configuration — every candidate sample rate failed. */
    class UnsupportedConfiguration(message: String) : MicCaptureException(message)

    /** The microphone exists but could not be opened or started (busy, in a call…). */
    class DeviceUnavailable(message: String, cause: Throwable? = null) :
        MicCaptureException(message, cause)

    /**
     * `AudioRecord.read` returned an error mid-stream: the device died
     * ([AudioRecord.ERROR_DEAD_OBJECT]) or the record object was invalidated
     * ([AudioRecord.ERROR_INVALID_OPERATION]) — which is what a mid-stream
     * permission revocation looks like on the devices that do not simply kill
     * the process.
     */
    class ReadFailed(val errorCode: Int) :
        MicCaptureException("AudioRecord.read failed with $errorCode")

    /**
     * Whether this failure means "somebody else has the microphone" rather than
     * "this device's audio is broken" — the distinction
     * [CaptureRecovery.Event.RebuildFailed] carries, and the one that decides
     * whether the user is offered a retry or given a reason.
     *
     * [UnsupportedConfiguration] counts as *held*, which looks wrong until you
     * remember when it is asked: this is a **rebuild**, so the very same
     * candidate list opened successfully a moment ago. Every rate being refused
     * now therefore says far more about who is holding the input than about
     * what the hardware can do. iOS reasons identically about a probe that
     * surfaces as a 0 Hz input node
     * (`ParleyKit/Sources/ParleyKit/CaptureRecovery.swift`, the note on
     * `beganWithInterruption`).
     */
    val systemHoldsInput: Boolean
        get() = when (this) {
            is PermissionDenied -> false
            is UnsupportedConfiguration -> true
            is DeviceUnavailable -> true
            is ReadFailed -> true
        }
}

/**
 * Where microphone recovery currently stands — `Holding` almost always, and the
 * other two while something has taken the input away.
 *
 * Surfaced all the way to [com.pathors.parley.meeting.LiveMeeting] because the
 * difference between "recording" and "trying to get the microphone back" is
 * exactly the thing a user cannot see and most needs to know.
 */
sealed interface MicRecoveryState {
    /** The microphone is ours and chunks are flowing. */
    data object Holding : MicRecoveryState

    /** Something took it; a rebuild chain is climbing the ladder. */
    data object Recovering : MicRecoveryState

    /**
     * The ladder ran out. **The capture is still alive**: the file is still
     * open, the flow has not completed, and the next time the app comes forward
     * or the audio server restarts, one more chain runs. See
     * [CaptureRecovery.Phase.LOST].
     */
    data class Lost(val loss: CaptureRecovery.Loss) : MicRecoveryState
}

/**
 * Microphone capture → a [Flow] of **16 kHz mono s16le PCM** chunks, the
 * pipeline's universal format. The Android counterpart of iOS `AudioCapture` and
 * desktop `audio/microphone.rs`.
 *
 * ```kotlin
 * val mic = MicCapture(context)
 * scope.launch {
 *     mic.start()
 *         .catch { e -> ui.showError(e as MicCaptureException) }
 *         .collect { chunk -> relay.send(chunk); encoder.append(chunk) }
 * }
 * // later, from anywhere:
 * mic.stop()
 * ```
 *
 * ## Semantics
 *
 * * **Cold flow.** Recording starts when collection starts and ends when
 *   collection ends. Collect it once at a time; a second concurrent collection
 *   opens a second `AudioRecord` and will most likely fail with
 *   [MicCaptureException.DeviceUnavailable].
 * * **Chunk size.** Exactly [Pcm.CHUNK_BYTES] (100 ms) per emission, except for
 *   a possible short final chunk. A stable size keeps the relay's byte metering
 *   honest — and the chunk buffer deliberately **survives a rebuild**, so a
 *   microphone taken away mid-chunk does not leave a ragged 43-byte emission in
 *   the middle of the recording.
 * * **Threading.** `AudioRecord.read` runs on a dedicated thread at
 *   `THREAD_PRIORITY_URGENT_AUDIO`; chunks reach the collector through the
 *   `callbackFlow` channel (64-chunk buffer ≈ 6.4 s of slack). When the
 *   collector cannot keep up the reader thread blocks on send, which is the
 *   right back-pressure: the `AudioRecord` ring buffer absorbs the difference
 *   and, if the stall outlasts it, the kernel drops the oldest audio rather than
 *   the app growing without bound.
 * * **Stopping.** [stop] completes the flow *normally* (the collector sees a
 *   clean end of stream). Cancelling the collecting coroutine also works and is
 *   equally safe. Either way the `AudioRecord` is stopped and released before
 *   the flow finishes.
 * * **One-shot per instance.** A stopped instance stays stopped, and [stop]
 *   counts even when it arrives *before* [start]: the flow then completes
 *   immediately without ever opening the microphone. There is no way to restart
 *   a stopped instance — build a new [MicCapture]. This is what makes "stop
 *   while still connecting" safe. Clearing the flag when collection begins
 *   would let that race resurrect a read loop whose owner has already finished
 *   its encoder, and the next chunk would take the process down with it.
 * * **Audio source.** [MediaRecorder.AudioSource.VOICE_RECOGNITION] — the
 *   speech-to-text source, which on most devices bypasses the AGC/noise
 *   suppression tuned for phone calls. Falls back to
 *   [MediaRecorder.AudioSource.MIC] when the device will not open it.
 * * **Sample rate.** 16 kHz capture is mandated by the CDD and is what we ask
 *   for. On a device that refuses it we capture at 48 kHz or 44.1 kHz and run
 *   [Resampler] in the read loop (≈ 0.3 % of one core) so callers always see
 *   16 kHz.
 *
 * ## Recovery: one flow, many `AudioRecord`s
 *
 * "One-shot" above describes the *instance*, not the `AudioRecord`. A single
 * collection of [start] will open, release and reopen the hardware as many times
 * as it has to, and **the flow does not complete when the microphone is lost.**
 * That is the whole point: the collector is
 * [com.pathors.parley.meeting.CapturePipeline], feeding one [OggOpusEncoder] and
 * one Ogg file. If the flow ended, the recording would end — which is precisely
 * what used to happen every time a call came in, Google Assistant woke up, or
 * another app opened the microphone.
 *
 * Four independent sources feed [CaptureRecovery], because no one of them is
 * reliable on its own:
 *
 * | Source | What it catches |
 * |---|---|
 * | `AudioRecord.read` returning a negative code | The honest failures: a dead object, an invalidated record |
 * | [notePlatformSilenced], from `AudioRecordingCallback` | Android 10+ feeding us **silence** instead of an error — the only announcement there is |
 * | [AudioDeviceCallback] | A headset arriving or leaving, i.e. the input we should be recording from moving |
 * | The watchdog thread | Everything the platform announces in no way at all: reads that simply stop coming |
 *
 * [noteAppForegrounded] is the fifth, and it is not a failure signal but a
 * recovery one: the platform is markedly more willing to hand a foreground app
 * the microphone, so a capture that had run out of attempts gets another chain
 * from there. See [CaptureRecovery] for the ladder and for why giving up leaves
 * the capture armed rather than dead.
 *
 * **The first open is different.** A microphone that cannot be opened at all
 * when the user taps record is reported, not retried: the flow fails with a
 * [MicCaptureException] as it always did, and the session turns that into an
 * error the user can act on. Recovery is for input lost *mid-recording*, where
 * there is a file on disk worth continuing.
 *
 * ## Two Android callbacks this deliberately does **not** use
 *
 * * **`AudioManager.OnAudioFocusChangeListener`.** Android has no passive
 *   observer for focus; the only way to be told about it is to *request* focus,
 *   and requesting it as a recorder would duck or pause whatever else is
 *   playing. Parley is frequently used to record a video call playing out of
 *   the same phone, so requesting focus would silence the very thing being
 *   recorded. The signals above cover the same ground without that cost.
 * * **`ACTION_AUDIO_BECOMING_NOISY`.** That broadcast is about *output* —
 *   "headphones were unplugged, stop blasting music into the room". The input
 *   half of the same event arrives through [AudioDeviceCallback], which is what
 *   is registered here.
 *
 * ## Error policy
 *
 * Every failure is surfaced as a [MicCaptureException] through the flow
 * (`catch { }`), never thrown from [start] itself and never swallowed:
 *
 * | Situation | Result |
 * |---|---|
 * | `RECORD_AUDIO` missing at start | [MicCaptureException.PermissionDenied] |
 * | Mic busy / in a call / opened by a higher-priority app **at start** | [MicCaptureException.DeviceUnavailable] |
 * | No sample rate works **at start** | [MicCaptureException.UnsupportedConfiguration] |
 * | `RECORD_AUDIO` revoked mid-stream | [MicCaptureException.PermissionDenied] |
 * | Anything else mid-stream | Recovered from; [micRecovery] reports progress |
 *
 * @param recovery injectable so the recovery ladder can be shortened in a test
 *   or on a device known to be slow to release its microphone.
 * @param watchdog injectable for the same reason.
 */
class MicCapture @JvmOverloads constructor(
    private val context: Context,
    private val chunkBytes: Int = Pcm.CHUNK_BYTES,
    private val recovery: CaptureRecovery = CaptureRecovery(),
    private val watchdog: CaptureWatchdog = CaptureWatchdog(),
) {
    private val _level = MutableStateFlow(0f)

    /** RMS of the most recent chunk, in [0, 1] — for a level meter. */
    val level: StateFlow<Float> = _level.asStateFlow()

    private val _micRecovery = MutableStateFlow<MicRecoveryState>(MicRecoveryState.Holding)

    /** Where microphone recovery stands. See [MicRecoveryState]. */
    val micRecovery: StateFlow<MicRecoveryState> = _micRecovery.asStateFlow()

    /** Set by [stop] and never cleared — see "One-shot per instance" in the class docs. */
    @Volatile
    private var stopRequested: Boolean = false

    /** Sample rate actually opened on the device (16 000 unless it refused). */
    @Volatile
    var captureSampleRate: Int = Pcm.SAMPLE_RATE
        private set

    /** The `MediaRecorder.AudioSource` actually opened, or -1 before [start]. */
    @Volatile
    var captureSource: Int = -1
        private set

    /** The input device the live `AudioRecord` was pointed at, for route comparison. */
    @Volatile
    private var activeInput: InputDevice? = null

    /**
     * The `AudioRecord` currently being read, so the watchdog can stop it and
     * thereby make a wedged `read()` return. `@Volatile` because the watchdog
     * thread, the reader thread and `awaitClose` all touch it.
     */
    @Volatile
    private var liveRecord: AudioRecord? = null

    /** `elapsedRealtime` of the last chunk handed to the collector — the watchdog's input. */
    @Volatile
    private var lastChunkAtMs: Long = 0L

    /**
     * Events raised off the reader thread: the silenced-client callback, the
     * device-routing callback, the activity lifecycle, the watchdog. Drained at
     * every decision point by whichever loop is running.
     */
    private val posted = ConcurrentLinkedQueue<CaptureRecovery.Event>()

    /**
     * What a posted event or [stop] notifies, and what a backoff sleep or a
     * give-up park waits on. A monitor rather than a coroutine primitive
     * because everything on this side of the class runs on plain threads.
     */
    private val wake = Object()

    init {
        require(chunkBytes > 0 && chunkBytes % Pcm.BYTES_PER_SAMPLE == 0) {
            "chunkBytes must be a positive even number (got $chunkBytes)"
        }
    }

    /**
     * Start capturing. Each emission is [chunkBytes] of 16 kHz mono s16le PCM.
     * See the class docs for the error policy and for what happens when the
     * microphone is taken away mid-stream.
     */
    fun start(): Flow<ByteArray> = callbackFlow {
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            throw MicCaptureException.PermissionDenied()
        }

        val sender = ChunkSender(this@callbackFlow)
        val reader = Thread({ supervise(sender) }, "parley-mic")
        reader.isDaemon = true

        val routing = installRoutingCallback()
        reader.start()

        awaitClose {
            stopRequested = true
            signal()
            removeRoutingCallback(routing)
            runCatching { reader.join(THREAD_JOIN_MILLIS) }
            runCatching { liveRecord?.stop() }
            runCatching { liveRecord?.release() }
            liveRecord = null
            _level.value = 0f
        }
    }

    /**
     * Stop capturing and let the flow complete normally. Idempotent, safe from
     * any thread, and a no-op when nothing is running — including before
     * [start], which is never undone: see "One-shot per instance" in the class
     * docs.
     */
    fun stop() {
        stopRequested = true
        signal()
    }

    // ------------------------------------------------------- external events

    /**
     * The platform is (or has stopped) feeding us silence because something
     * else took the microphone — `AudioRecordingCallback.isClientSilenced`.
     *
     * On Android 10 and up this is the **only** announcement of a takeover:
     * `AudioRecord.read` keeps returning success and keeps returning zeroes.
     * Without it, a meeting can record forty minutes of nothing and report no
     * problem at all.
     */
    fun notePlatformSilenced(silenced: Boolean) {
        post(
            if (silenced) CaptureRecovery.Event.Interrupted
            else CaptureRecovery.Event.InterruptionEnded,
        )
    }

    /**
     * Parley came to the foreground. Not an audio event, and that is exactly
     * why it matters — see [CaptureRecovery.Event.AppBecameActive]. Harmless
     * while the microphone is ours: the policy answers it with
     * [CaptureRecovery.Action.Wait].
     */
    fun noteAppForegrounded() {
        post(CaptureRecovery.Event.AppBecameActive)
    }

    private fun post(event: CaptureRecovery.Event) {
        posted.add(event)
        signal()
    }

    private fun signal() = synchronized(wake) { wake.notifyAll() }

    // ---------------------------------------------------------------- internals

    private class OpenedRecord(
        val record: AudioRecord,
        val sampleRate: Int,
        val source: Int,
        val input: InputDevice?,
    )

    /** Why a read loop stopped, and what to do about it. */
    private sealed interface ReadExit {
        /** [stop], a cancelled collector, or a gone collector. Wind down normally. */
        data object Finished : ReadExit

        /** Something took the microphone. [action] is what the policy decided. */
        data class Recover(val action: CaptureRecovery.Action) : ReadExit
    }

    /**
     * Set by [recover] when it hits something no ladder can fix — in practice
     * only `RECORD_AUDIO` being revoked mid-recording. The flow fails with it,
     * which is what makes the session close the container and save the audio
     * recorded up to that point rather than losing it.
     */
    @Volatile
    private var fatal: MicCaptureException? = null

    /**
     * The reader thread's whole life: open the microphone, read it until
     * something takes it away, get it back, repeat — all inside one collection
     * of [start], so the encoder downstream never sees the recording end.
     */
    private fun supervise(sender: ChunkSender) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        val scope = sender.scope

        // stop() arriving before collection began. Documented as "completes
        // immediately without ever opening the microphone", and now true.
        if (stopRequested) {
            scope.close()
            return
        }

        var opened = try {
            openAndStart()
        } catch (e: MicCaptureException) {
            // The first open is reported, not retried — see the class docs.
            scope.close(e)
            return
        }
        publish(opened)

        val watchdogThread = Thread(::runWatchdog, "parley-mic-watchdog").apply {
            isDaemon = true
            start()
        }

        try {
            var current: OpenedRecord? = opened
            while (current != null) {
                val exit = readLoop(current, sender)
                release(current)
                current = null
                if (exit is ReadExit.Recover) {
                    current = recover(exit.action, sender)
                    if (current != null) publish(current)
                }
            }
            fatal?.let {
                scope.close(it)
                return
            }
            if (sender.open) sender.flushPartial()
            scope.close()
        } catch (t: Throwable) {
            scope.close(t)
        } finally {
            stopRequested = true
            signal()
            runCatching { watchdogThread.join(THREAD_JOIN_MILLIS) }
            _level.value = 0f
        }
    }

    /** Publish the properties callers read off a live capture. */
    private fun publish(opened: OpenedRecord) {
        captureSampleRate = opened.sampleRate
        captureSource = opened.source
        activeInput = opened.input
        liveRecord = opened.record
        lastChunkAtMs = SystemClock.elapsedRealtime()
        _micRecovery.value = MicRecoveryState.Holding
    }

    private fun release(opened: OpenedRecord) {
        liveRecord = null
        runCatching { opened.record.stop() }
        runCatching { opened.record.release() }
    }

    /**
     * Climb the recovery ladder until the microphone is ours again, [stop]
     * arrives, or the collector goes away.
     *
     * A [CaptureRecovery.Action.GiveUp] does **not** end this: it publishes the
     * loss and then parks, waiting for one of the events that changes the
     * answer. That is what "giving up stays armed" means in practice, and it is
     * why this returns null only when the capture is genuinely over.
     *
     * @return the reopened microphone, or null when there is nothing left to do.
     */
    private fun recover(first: CaptureRecovery.Action, sender: ChunkSender): OpenedRecord? {
        var action = first
        _level.value = 0f
        while (!stopRequested && sender.open) {
            when (val current = action) {
                // The policy had nothing to say about whatever got us here —
                // in practice a second interruption for one already being
                // handled. **Not** a reason to sit still: by the time this
                // loop runs the `AudioRecord` has already been released, so
                // parking would be a recording that quietly stops. Anything
                // the policy declines to act on is answered with an attempt.
                is CaptureRecovery.Action.Wait -> {
                    action = CaptureRecovery.Action.Rebuild(0)
                }

                is CaptureRecovery.Action.Rebuild ->
                    when (val outcome = attemptRebuild(current, sender)) {
                        is RebuildOutcome.Reopened -> return outcome.opened
                        RebuildOutcome.Over -> return null
                        is RebuildOutcome.Next -> action = outcome.action
                    }

                is CaptureRecovery.Action.GiveUp -> {
                    Log.w(TAG, "microphone recovery gave up: ${current.loss}")
                    _micRecovery.value = MicRecoveryState.Lost(current.loss)
                    // Still armed. The recording stays open and the file keeps
                    // whatever it already has; the next foreground trip or
                    // audio-server restart runs one more chain.
                    action = awaitEvent() ?: return null
                }
            }
        }
        return null
    }

    /** What one rung of the recovery ladder produced. */
    private sealed interface RebuildOutcome {
        /** The microphone is ours again. */
        data class Reopened(val opened: OpenedRecord) : RebuildOutcome

        /**
         * Nothing left to climb for: [stop], a gone collector, or a loss no
         * ladder can fix, in which case [fatal] is already set.
         */
        data object Over : RebuildOutcome

        /** Keep climbing — [action] is what the policy decided next. */
        data class Next(val action: CaptureRecovery.Action) : RebuildOutcome
    }

    /**
     * One rung: wait out the backoff, then try to open the microphone again.
     *
     * The wait is interruptible on purpose. An event arriving during the
     * backoff supersedes the attempt it was waiting out, so an interruption
     * that ends while we are sleeping for four seconds does not cost the
     * remaining four.
     */
    private fun attemptRebuild(
        rebuild: CaptureRecovery.Action.Rebuild,
        sender: ChunkSender,
    ): RebuildOutcome {
        _micRecovery.value = MicRecoveryState.Recovering
        val interrupting = sleep(rebuild.afterMillis)
        if (interrupting != null) return RebuildOutcome.Next(interrupting)
        if (stopRequested || !sender.open) return RebuildOutcome.Over
        return try {
            val reopened = openAndStart()
            recovery.apply(CaptureRecovery.Event.RebuildSucceeded(reopened.sampleRate))
            Log.i(TAG, "microphone recovered at ${reopened.sampleRate} Hz")
            RebuildOutcome.Reopened(reopened)
        } catch (e: MicCaptureException.PermissionDenied) {
            // Not a takeover: the user revoked RECORD_AUDIO. No ladder can fix
            // that, and the session needs to hear it so the recording so far is
            // closed and saved.
            Log.w(TAG, "RECORD_AUDIO revoked mid-recording")
            fatal = e
            RebuildOutcome.Over
        } catch (e: MicCaptureException) {
            Log.w(TAG, "microphone rebuild failed: ${e.message}")
            RebuildOutcome.Next(
                recovery.apply(
                    CaptureRecovery.Event.RebuildFailed(
                        systemHoldsInput = e.systemHoldsInput,
                        description = e.message,
                    ),
                ),
            )
        }
    }

    /**
     * Wait until a posted event produces an action, or [stop] arrives.
     *
     * @return the action, or null when the capture is over.
     */
    private fun awaitEvent(): CaptureRecovery.Action? {
        while (!stopRequested) {
            drainPosted()?.let { return it }
            synchronized(wake) {
                if (!stopRequested && posted.isEmpty()) wake.wait(PARK_POLL_MILLIS)
            }
        }
        return null
    }

    /**
     * Sleep for a backoff step, waking early for a posted event.
     *
     * @return the action a posted event produced, or null when the sleep ran to
     *   its end (or was cut short by [stop], which the caller re-checks).
     */
    private fun sleep(millis: Long): CaptureRecovery.Action? {
        val deadline = SystemClock.elapsedRealtime() + millis
        while (!stopRequested) {
            drainPosted()?.let { return it }
            val remaining = deadline - SystemClock.elapsedRealtime()
            if (remaining <= 0) return null
            synchronized(wake) {
                if (!stopRequested && posted.isEmpty()) wake.wait(remaining)
            }
        }
        return null
    }

    /**
     * Feed every queued event to the policy and return the first action worth
     * acting on. [CaptureRecovery.Action.Wait] is the policy saying "this
     * changes nothing", so it is consumed silently — which is what lets
     * [noteAppForegrounded] be called freely while the microphone is ours.
     */
    private fun drainPosted(): CaptureRecovery.Action? {
        while (true) {
            val event = posted.poll() ?: return null
            val action = recovery.apply(event)
            if (action !is CaptureRecovery.Action.Wait) return action
        }
    }

    /**
     * Open an `AudioRecord`, preferring VOICE_RECOGNITION at 16 kHz and walking
     * down the fallbacks, then start it. Buffer is at least 2× the reported
     * minimum and at least 4 chunks, so a scheduling hiccup cannot cost us
     * audio.
     */
    private fun openAndStart(): OpenedRecord {
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            throw MicCaptureException.PermissionDenied()
        }
        val opened = openRecord()
        val record = opened.record
        try {
            record.startRecording()
        } catch (e: IllegalStateException) {
            record.release()
            throw MicCaptureException.DeviceUnavailable("could not start recording", e)
        }
        if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
            runCatching { record.stop() }
            record.release()
            throw MicCaptureException.DeviceUnavailable(
                "microphone is busy (recordingState=${record.recordingState})",
            )
        }
        return opened
    }

    /**
     * Walk the compatibility ladder: [CANDIDATE_RATES] outermost, and within each
     * rate every source in [CANDIDATE_SOURCES].
     *
     * Every rung that fails appends its reason to one `failures` string, and the
     * exception thrown when the ladder runs out carries the whole thing. That
     * string is the only evidence we get from a phone that "cannot record" —
     * losing it turns a diagnosable device quirk into an unreproducible report.
     */
    private fun openRecord(): OpenedRecord {
        val preferred = AudioRouteChoice.preferred(inputDevices())
        val failures = StringBuilder()
        for (rate in CANDIDATE_RATES) {
            openAtRate(rate, preferred, failures)?.let { return it }
        }
        throw MicCaptureException.UnsupportedConfiguration(
            "no usable AudioRecord configuration ($failures)",
        )
    }

    /**
     * One rung of the rate ladder: try every source at [rate], or return null
     * having said why in [failures].
     *
     * Buffer is at least 2× the reported minimum and at least 4 chunks, so a
     * scheduling hiccup cannot cost us audio.
     */
    private fun openAtRate(
        rate: Int,
        preferred: InputDevice?,
        failures: StringBuilder,
    ): OpenedRecord? {
        val minBuffer = AudioRecord.getMinBufferSize(
            rate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minBuffer <= 0) {
            failures.append("${rate}Hz: getMinBufferSize=$minBuffer; ")
            return null
        }
        val chunkAtRate = rate * Pcm.CHUNK_MILLIS / 1000 * Pcm.BYTES_PER_SAMPLE
        val bufferSize = max(minBuffer * 2, chunkAtRate * 4)
        for (source in CANDIDATE_SOURCES) {
            val record = buildRecord(rate, source, bufferSize, failures) ?: continue
            if (record.state == AudioRecord.STATE_INITIALIZED) {
                return claimRecord(record, rate, source, preferred)
            }
            failures.append("${rate}Hz src=$source: state=${record.state}; ")
            record.release()
        }
        return null
    }

    /**
     * Build one `AudioRecord` for a rate/source pair, or return null having
     * recorded the refusal in [failures].
     *
     * A built record is not necessarily a working one — the caller still has to
     * check `state`, which is the other half of how the platform says no.
     */
    @SuppressLint("MissingPermission") // checked by openAndStart before we get here
    private fun buildRecord(
        rate: Int,
        source: Int,
        bufferSize: Int,
        failures: StringBuilder,
    ): AudioRecord? =
        try {
            AudioRecord.Builder()
                .setAudioSource(source)
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(rate)
                        .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                        .build(),
                )
                .setBufferSizeInBytes(bufferSize)
                .build()
        } catch (e: Exception) {
            // UnsupportedOperationException / IllegalArgumentException /
            // SecurityException all mean "not this combination".
            failures.append("${rate}Hz src=$source: ${e.javaClass.simpleName}; ")
            null
        }

    /**
     * Take ownership of an initialised record: pin its input, log what we got,
     * and wrap it up.
     *
     * Pin the record to the input the user would expect. Without this the
     * platform's pick is final for the life of the record: a headset put on
     * mid-meeting is ignored and the phone keeps recording its own microphone,
     * which is the "silently much worse audio" failure AudioRouteChoice exists
     * for. Best effort — a refusal leaves the platform's choice in place, which
     * is still a working recording.
     */
    private fun claimRecord(
        record: AudioRecord,
        rate: Int,
        source: Int,
        preferred: InputDevice?,
    ): OpenedRecord {
        val pinned = preferred?.let { wanted ->
            platformDevice(wanted.id)?.let { record.setPreferredDevice(it) } ?: false
        } ?: false
        Log.i(
            TAG,
            "capturing at $rate Hz mono, source=$source, " +
                "input=${preferred?.type ?: "none offered"}" +
                (if (pinned) "" else " (not pinned; platform's choice stands)") +
                " → ${Pcm.SAMPLE_RATE} Hz",
        )
        return OpenedRecord(
            record = record,
            sampleRate = rate,
            source = source,
            // What we *wanted*, not what we managed to pin. This is the
            // comparison AudioRouteChoice.needsRebuild is built for: it asks
            // whether the best available input has changed, so storing the
            // intent keeps a device change that does not move the answer —
            // plugging in a charger — from punching a hole in the audio.
            // Storing null on a refused pin would instead make the *next*
            // unrelated device change look like a route change.
            input = preferred,
        )
    }

    /**
     * Drain one `AudioRecord` until [stop], a posted event that matters, the
     * collector going away, or a read error.
     *
     * Runs off the coroutine machinery entirely: it only touches the producer
     * scope to hand chunks over.
     */
    private fun readLoop(opened: OpenedRecord, sender: ChunkSender): ReadExit {
        val sourceRate = opened.sampleRate
        val resampler =
            if (sourceRate == Pcm.SAMPLE_RATE) null else Resampler(sourceRate, Pcm.SAMPLE_RATE)
        // One read ≈ one chunk of source audio.
        val readBytes = sourceRate * Pcm.CHUNK_MILLIS / 1000 * Pcm.BYTES_PER_SAMPLE
        val readBuf = ByteArray(readBytes)
        val floats = FloatArray(readBytes / Pcm.BYTES_PER_SAMPLE)

        while (!stopRequested && sender.open) {
            // Checked every read rather than only on failure: a route change or
            // a silenced client has to be acted on while reads are still
            // succeeding, which is the whole point of those two signals.
            drainPosted()?.let { return exitWith(resampler, sender, ReadExit.Recover(it)) }

            val read = opened.record.read(readBuf, 0, readBytes)
            when {
                read > 0 -> {
                    lastChunkAtMs = SystemClock.elapsedRealtime()
                    if (!deliverRead(sender, resampler, readBuf, read, floats)) {
                        return exitWith(resampler, sender, ReadExit.Finished)
                    }
                }

                read == 0 -> continue // no data yet; poll the flags again

                else -> {
                    Log.w(TAG, "AudioRecord.read failed with $read")
                    val event = when (read) {
                        // The audio server restarted. Every AudioRecord in the
                        // process is a corpse — including whichever one the
                        // other client was holding, which is why this is worth
                        // retrying even from a give-up.
                        AudioRecord.ERROR_DEAD_OBJECT -> CaptureRecovery.Event.AudioServerDied
                        // Anything else mid-stream means the record we were
                        // reading is no longer ours.
                        else -> CaptureRecovery.Event.Interrupted
                    }
                    return exitWith(
                        resampler,
                        sender,
                        ReadExit.Recover(recovery.apply(event)),
                    )
                }
            }
        }
        return exitWith(resampler, sender, ReadExit.Finished)
    }

    /**
     * Flush whatever the resampler still holds before the `AudioRecord` behind
     * it goes away. Done on *every* exit, not only the last one: a rebuild
     * builds a fresh resampler (the new record may have a different rate), so
     * anything left in the old one is audio that would otherwise be dropped at
     * the seam.
     *
     * The partial *chunk* is deliberately not flushed here — [ChunkSender] is
     * shared across rebuilds precisely so the seam does not produce a short
     * emission.
     */
    private fun exitWith(
        resampler: Resampler?,
        sender: ChunkSender,
        exit: ReadExit,
    ): ReadExit {
        if (resampler != null && sender.open) {
            val tail = resampler.flush()
            if (tail.isNotEmpty()) sender.deliver(Pcm.floatToS16le(tail, tail.size), tail.size * 2)
        }
        return exit
    }

    /**
     * Resample one `AudioRecord.read` result when the device forced us off
     * 16 kHz, then hand it to [sender].
     *
     * @return false when the collector is gone and the read loop should stop.
     */
    private fun deliverRead(
        sender: ChunkSender,
        resampler: Resampler?,
        readBuf: ByteArray,
        read: Int,
        floats: FloatArray,
    ): Boolean {
        val payload: ByteArray
        val payloadLen: Int
        if (resampler == null) {
            payload = readBuf
            payloadLen = read
        } else {
            val n = Pcm.s16leToFloat(readBuf, 0, read, floats)
            val resampled = resampler.process(floats, n)
            payload = Pcm.floatToS16le(resampled, resampled.size)
            payloadLen = payload.size
        }
        return payloadLen <= 0 || sender.deliver(payload, payloadLen)
    }

    // --------------------------------------------------------------- watchdog

    /**
     * The backstop for everything the platform announces in no way at all.
     *
     * iOS runs the same two-second check for the same reason
     * (`App/Parley/AudioCapture.swift:619-640`). On Android the case it catches
     * is an `AudioRecord` whose `read()` simply stops returning — no error
     * code, no silenced-client callback, no device change. Left alone that is an
     * hour of a meeting that never reaches the file.
     *
     * Stopping the record is what makes the notice actionable: a wedged `read()`
     * returns once the record it is reading is stopped, and the read loop then
     * finds the posted event waiting for it. [CaptureWatchdog.shouldProbe] is
     * what keeps this from firing during a recovery, where "no chunks are
     * arriving" is true by definition and a reset ladder would never end.
     */
    private fun runWatchdog() {
        while (!stopRequested) {
            synchronized(wake) {
                if (!stopRequested) wake.wait(watchdog.checkIntervalMillis)
            }
            if (stopRequested) return
            val stale = watchdog.shouldProbe(
                nowMillis = SystemClock.elapsedRealtime(),
                lastChunkAtMillis = lastChunkAtMs,
                recovering = recovery.isRecovering,
                givenUp = recovery.hasGivenUp,
            )
            if (!stale) continue
            Log.w(TAG, "no microphone chunks for ${watchdog.stalledAfterMillis} ms; rebuilding")
            post(CaptureRecovery.Event.CaptureStopped)
            // Unwedge the reader: a stopped record makes read() return.
            runCatching { liveRecord?.stop() }
        }
    }

    // ---------------------------------------------------------------- routing

    private fun audioManager(): AudioManager? = context.getSystemService(AudioManager::class.java)

    private fun platformDevices(): Array<AudioDeviceInfo> =
        audioManager()?.getDevices(AudioManager.GET_DEVICES_INPUTS) ?: emptyArray()

    private fun platformDevice(id: Int): AudioDeviceInfo? =
        platformDevices().firstOrNull { it.id == id }

    private fun inputDevices(): List<InputDevice> = platformDevices().map { device ->
        InputDevice(
            id = device.id,
            type = device.type,
            sampleRates = device.sampleRates.toList(),
            channelCounts = device.channelCounts.toList(),
        )
    }

    /**
     * Notice a headset arriving or leaving.
     *
     * Deliberately quiet unless the *choice* changed:
     * [AudioRouteChoice.needsRebuild] compares the preferred input rather than
     * reacting to the notification, because plugging in a charger is a device
     * change too and rebuilding for it would punch a hole in the audio for
     * nothing. iOS makes the same distinction in `needsRebuild()`
     * (`App/Parley/AudioCapture.swift:467-478`).
     */
    private fun installRoutingCallback(): AudioDeviceCallback? {
        val manager = audioManager() ?: return null
        val callback = object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>?) = evaluateRoute()
            override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>?) =
                evaluateRoute()
        }
        // A Handler is required: start() runs on Dispatchers.IO, which has no Looper.
        manager.registerAudioDeviceCallback(callback, Handler(Looper.getMainLooper()))
        return callback
    }

    private fun removeRoutingCallback(callback: AudioDeviceCallback?) {
        if (callback == null) return
        runCatching { audioManager()?.unregisterAudioDeviceCallback(callback) }
    }

    private fun evaluateRoute() {
        if (stopRequested) return
        // A chain already owns the microphone; a route change arriving mid-climb
        // must neither start a second chain nor reset the first one's attempts.
        if (recovery.isRecovering || recovery.hasGivenUp) return
        if (!AudioRouteChoice.needsRebuild(activeInput, inputDevices())) return
        Log.i(TAG, "input route moved; rebuilding onto the preferred device")
        post(CaptureRecovery.Event.CaptureStopped)
        runCatching { liveRecord?.stop() }
    }

    // ------------------------------------------------------------ chunk sender

    /**
     * Cuts the reader thread's variable-sized reads into exactly [chunkBytes]
     * emissions, meters each one, and hands them to the collector.
     *
     * One instance per *collection*, not per `AudioRecord`: a partial chunk
     * held when the microphone was taken away is completed by the audio that
     * arrives after the rebuild, so the recording has no ragged seam.
     */
    private inner class ChunkSender(val scope: ProducerScope<ByteArray>) {
        private val chunk = ByteArray(chunkBytes)
        private var chunkLen = 0

        /** False once the collector has gone away and nothing more can be sent. */
        var open = true
            private set

        /** @return false when the collector is gone and we should stop. */
        fun deliver(bytes: ByteArray, length: Int): Boolean {
            var consumed = 0
            while (consumed < length) {
                val n = minOf(chunkBytes - chunkLen, length - consumed)
                System.arraycopy(bytes, consumed, chunk, chunkLen, n)
                chunkLen += n
                consumed += n
                if (chunkLen == chunkBytes) {
                    val out = chunk.copyOf()
                    _level.value = Pcm.rmsFromS16le(out)
                    chunkLen = 0
                    if (scope.trySendBlocking(out).isFailure) {
                        open = false
                        return false
                    }
                }
            }
            return true
        }

        /** Emit whatever is left of a partial chunk. */
        fun flushPartial() {
            if (chunkLen > 0) {
                scope.trySendBlocking(chunk.copyOf(chunkLen))
                chunkLen = 0
            }
        }
    }

    companion object {
        private const val TAG = "MicCapture"
        private const val THREAD_JOIN_MILLIS = 2_000L

        /**
         * How long a parked give-up sleeps between checks. It is woken by
         * [signal] the instant anything happens, so this only bounds how long
         * a *missed* notification can cost — belt and braces around a monitor.
         */
        private const val PARK_POLL_MILLIS = 5_000L

        /** 16 kHz is CDD-mandated; the rest are insurance. */
        private val CANDIDATE_RATES = intArrayOf(Pcm.SAMPLE_RATE, 48_000, 44_100)

        private val CANDIDATE_SOURCES = intArrayOf(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            MediaRecorder.AudioSource.MIC,
        )
    }
}
