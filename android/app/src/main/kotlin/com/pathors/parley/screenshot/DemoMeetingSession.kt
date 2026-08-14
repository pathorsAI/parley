package com.pathors.parley.screenshot

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import com.pathors.parley.kit.TranscriptSegment
import com.pathors.parley.meeting.LiveMeeting
import com.pathors.parley.meeting.MeetingState
import com.pathors.parley.meeting.TranscriptionIssue
import kotlin.random.Random
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * A live meeting that never touches the microphone, the relay, the encoder or
 * the upload queue: the scripted fixture segments from [DemoMode] played back on
 * a timer, plus a plausible level meter.
 *
 * The live screen is the frame the store listing most needs — a phone listening
 * to a room with the transcript already there — and it is also the one that
 * cannot be captured on an emulator, which has no audio input and would render
 * a flat meter over an empty transcript. So the screen swaps this in for a real
 * [com.pathors.parley.meeting.MeetingSession] while demo mode is on, and the
 * `microphone` foreground service is never started at all.
 *
 * Starts mid-conversation on purpose: two settled runs and an unfinished tail is
 * the state worth showing, not an empty transcript waiting for someone to speak.
 */
class DemoMeetingSession(
    private val script: List<TranscriptSegment> = DemoMode.liveScript(),
    private val tail: TranscriptSegment = DemoMode.liveTail(),
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main),
) : LiveMeeting {

    private val _state = MutableStateFlow<MeetingState>(MeetingState.Recording)
    override val state: StateFlow<MeetingState> = _state.asStateFlow()

    private val _segments = MutableStateFlow<List<TranscriptSegment>>(emptyList())
    override val segments: StateFlow<List<TranscriptSegment>> = _segments.asStateFlow()

    /** A demo meeting never has a transcription problem to report. */
    override val issue: StateFlow<TranscriptionIssue?> = MutableStateFlow(null).asStateFlow()

    private val _level = MutableStateFlow(0f)
    override val level: StateFlow<Float> = _level.asStateFlow()

    private val _elapsedMs = MutableStateFlow(START_AT_MS)
    override val elapsedMs: StateFlow<Long> = _elapsedMs.asStateFlow()

    private var transcriptJob: Job? = null
    private var meterJob: Job? = null

    /** Seed the opening frame and start both timers. Safe to call twice. */
    fun start() {
        if (transcriptJob != null) return
        _segments.value = script.take(SEEDED_LINES) + tail
        transcriptJob = scope.launch { runTranscript() }
        meterJob = scope.launch { runMeter() }
    }

    /**
     * Settle the tail into the next scripted run every few seconds, then hang a
     * fresh tail off the end — the same upsert-by-id rhythm the relay produces.
     * When the script runs out the last tail simply stays put, which leaves the
     * screen in a capturable mid-flight state rather than an "ended" one.
     */
    private suspend fun runTranscript() {
        var settled = SEEDED_LINES
        while (settled < script.size) {
            delay(SETTLE_INTERVAL_MS)
            settled += 1
            _segments.value = script.take(settled) + tail
        }
    }

    /**
     * A believable meter: speech-shaped jitter around a talking level rather
     * than a flat bar, seeded so successive captures look alike.
     */
    private suspend fun runMeter() {
        val random = Random(SEED)
        val startedAt = _elapsedMs.value
        var ticks = 0L
        while (true) {
            _level.value = (BASE_LEVEL + random.nextFloat() * LEVEL_SPREAD).coerceIn(0f, 1f)
            delay(METER_INTERVAL_MS)
            ticks += 1
            _elapsedMs.value = startedAt + ticks * METER_INTERVAL_MS
        }
    }

    /** Stop both timers. Nothing is saved, because nothing was ever captured. */
    fun dispose() {
        transcriptJob = null
        meterJob = null
        scope.coroutineContext[Job]?.cancel()
    }

    private companion object {
        /** Runs already on screen before the first tick — the opening frame. */
        const val SEEDED_LINES = 2

        /** A clock that reads like a meeting under way, not one just started. */
        const val START_AT_MS = 108_000L

        const val SETTLE_INTERVAL_MS = 4_000L
        const val METER_INTERVAL_MS = 140L
        const val BASE_LEVEL = 0.12f
        const val LEVEL_SPREAD = 0.55f
        const val SEED = 7
    }
}

/** A demo meeting bound to the composition that shows it. */
@Composable
fun rememberDemoMeeting(): DemoMeetingSession {
    val session = remember { DemoMeetingSession().also { it.start() } }
    DisposableEffect(session) {
        onDispose { session.dispose() }
    }
    return session
}
