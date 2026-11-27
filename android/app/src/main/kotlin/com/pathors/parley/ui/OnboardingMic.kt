package com.pathors.parley.ui

import android.Manifest
import android.content.Context
import android.icu.text.Transliterator
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.pathors.parley.AppContainer
import com.pathors.parley.R
import com.pathors.parley.audio.MicCapture
import com.pathors.parley.audio.MicCaptureException
import com.pathors.parley.feedback.Log
import com.pathors.parley.kit.CloudChat
import com.pathors.parley.kit.MicIntro
import com.pathors.parley.kit.SttRelayClient
import com.pathors.parley.kit.SttRelayEvent
import com.pathors.parley.kit.TranscriptSegment
import com.pathors.parley.screenshot.DemoMode
import com.pathors.parley.ui.theme.ParleyTheme
import kotlin.math.floor
import kotlin.random.Random
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val TAG = "OnboardingMic"

// ── 5 · microphone check ─────────────────────────────────────────────────────

/**
 * Read a sentence about yourself aloud: the microphone is checked, and what was
 * said becomes the first lines of the speaker background — the desktop's
 * `MicStep`, iOS `OnboardingMicStep`. Leaving the step mid-sentence is the same
 * as Stop: what was said is still saved, so Next never throws an introduction
 * away.
 */
@Composable
internal fun OnboardingMicStep(check: MicCheckModel) {
    val palette = onboardingPalette()
    DisposableEffect(check) {
        check.refreshInput()
        onDispose { check.stop() }
    }
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
        Text(
            stringResource(R.string.onboarding_mic_intro),
            style = MaterialTheme.typography.bodySmall,
            color = palette.secondary,
        )
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(stringResource(R.string.onboarding_mic_input), style = MaterialTheme.typography.bodySmall, color = palette.ink)
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(40.dp)
                    .border(1.dp, palette.hairline, RoundedCornerShape(8.dp))
                    .padding(horizontal = 12.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                Text(
                    check.inputName ?: stringResource(R.string.onboarding_mic_input_default),
                    style = MaterialTheme.typography.bodySmall,
                    color = palette.ink,
                )
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(stringResource(R.string.onboarding_mic_prompt), style = MaterialTheme.typography.bodySmall, color = palette.ink)
            TestCard(check)
        }
    }
}

@Composable
private fun TestCard(check: MicCheckModel) {
    val palette = onboardingPalette()
    val shape = RoundedCornerShape(8.dp)
    val listening = check.phase == MicCheckModel.Phase.Listening
    Box(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(MaterialTheme.colorScheme.background)
            .border(1.dp, palette.hairline, shape),
    ) {
        Box(Modifier.matchParentSize()) {
            SoloLines((-8).dp, (-5).dp, alpha = if (listening) 0.7f else 1f)
        }
        Column(
            Modifier
                .fillMaxWidth()
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            ScriptLine(
                Modifier
                    .fillMaxWidth()
                    .background(palette.bubble, RoundedCornerShape(10.dp))
                    .padding(horizontal = 12.dp, vertical = 10.dp),
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                // Its own width, always: the track takes what is left.
                TestButton(check)
                MicTrack(
                    levels = check.levels,
                    running = listening,
                    modifier = Modifier
                        .weight(1f)
                        .height(36.dp),
                )
            }
            if (check.text.isNotEmpty()) {
                Text(check.text, style = MaterialTheme.typography.bodyLarge, color = palette.ink)
            }
            Status(check.phase)
        }
    }
}

/**
 * Start (asking for the microphone first if it has not been granted), Stop
 * while listening, Try again after a run. Disabled while a run is saved.
 */
@Composable
private fun TestButton(check: MicCheckModel) {
    val context = LocalContext.current
    val palette = onboardingPalette()
    val phase = check.phase
    val listening = phase == MicCheckModel.Phase.Listening
    val busy = phase == MicCheckModel.Phase.Stopping
    val idle = phase == MicCheckModel.Phase.Idle
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) check.start() else check.permissionRefused()
    }
    val tint = if (listening) ParleyTheme.colors.recording else MaterialTheme.colorScheme.primary
    val icon: ImageVector = when {
        listening -> OnboardingIcons.Stop
        idle -> OnboardingIcons.Mic
        else -> Icons.Filled.Refresh
    }
    val shape = RoundedCornerShape(8.dp)
    Row(
        Modifier
            .clip(shape)
            .background(MaterialTheme.colorScheme.background)
            .border(1.dp, palette.hairline, shape)
            .clickable(enabled = !busy) {
                when {
                    listening -> check.stop()
                    DemoMode.isActive || context.isGranted(Manifest.permission.RECORD_AUDIO) -> check.start()
                    else -> permission.launch(Manifest.permission.RECORD_AUDIO)
                }
            }
            .heightIn(min = 36.dp)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(14.dp))
        Text(
            stringResource(
                when {
                    listening -> R.string.onboarding_mic_stop
                    idle -> R.string.onboarding_mic_start
                    else -> R.string.onboarding_mic_again
                },
            ),
            style = MaterialTheme.typography.titleSmall,
            color = tint,
            maxLines = 1,
        )
    }
}

/** The sentence to read, its blanks in grey inside their braces — the desktop's `ScriptLine`. */
@Composable
private fun ScriptLine(modifier: Modifier) {
    val palette = onboardingPalette()
    val template = stringResource(R.string.onboarding_mic_script)
    val blanks = mapOf(
        "company" to stringResource(R.string.onboarding_mic_blank_company),
        "role" to stringResource(R.string.onboarding_mic_blank_role),
        "purpose" to stringResource(R.string.onboarding_mic_blank_purpose),
    )
    val text = buildAnnotatedString {
        var rest = template
        while (true) {
            val open = rest.indexOf('{')
            val close = if (open >= 0) rest.indexOf('}', open) else -1
            if (open < 0 || close < 0) break
            val key = rest.substring(open + 1, close)
            append(rest.substring(0, open))
            append("{")
            withStyle(SpanStyle(color = palette.secondary)) { append(blanks[key] ?: blanks.getValue("purpose")) }
            append("}")
            rest = rest.substring(close + 1)
        }
        append(rest)
    }
    Text(text, style = MaterialTheme.typography.labelMedium, color = palette.ink, modifier = modifier)
}

@Composable
private fun Status(phase: MicCheckModel.Phase) {
    val palette = onboardingPalette()
    when (phase) {
        MicCheckModel.Phase.Idle -> Unit
        MicCheckModel.Phase.Listening ->
            StatusLine(stringResource(R.string.onboarding_mic_listening), null, palette.secondary)
        MicCheckModel.Phase.Stopping ->
            StatusLine(stringResource(R.string.onboarding_mic_saving), null, palette.secondary)
        MicCheckModel.Phase.Saved ->
            StatusLine(stringResource(R.string.onboarding_mic_saved), Icons.Filled.Check, palette.greenInk)
        MicCheckModel.Phase.Empty ->
            StatusLine(stringResource(R.string.onboarding_mic_empty), OnboardingIcons.Alert, palette.secondary)
        is MicCheckModel.Phase.Failed -> StatusLine(
            when (phase.reason) {
                MicCheckModel.Failure.PERMISSION -> stringResource(R.string.onboarding_mic_permission)
                MicCheckModel.Failure.SIGNED_OUT -> stringResource(R.string.onboarding_mic_sign_in)
                MicCheckModel.Failure.TRANSCRIPTION ->
                    stringResource(R.string.onboarding_mic_failed, phase.detail.orEmpty())
            },
            OnboardingIcons.Alert,
            MaterialTheme.colorScheme.error,
        )
    }
}

@Composable
private fun StatusLine(text: String, icon: ImageVector?, color: Color) {
    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (icon != null) Icon(icon, null, tint = color, modifier = Modifier.padding(top = 2.dp).size(13.dp))
        Text(text, style = MaterialTheme.typography.labelSmall, color = color)
    }
}

/**
 * The check's level as a recording track, the desktop's `WaveformTrack`: thin
 * bars for what has been said, a dashed line for the rest, and a playhead where
 * the recording is now. The playhead walks right as the bars come in until it
 * reaches the end of the track; then it stays and the bars scroll past it.
 */
@Composable
private fun MicTrack(levels: List<Float>, running: Boolean, modifier: Modifier) {
    val primary = MaterialTheme.colorScheme.primary
    val hairline = onboardingPalette().hairline
    Canvas(modifier.clearAndSetSemantics {}) {
        val bar = 2.dp.toPx()
        val step = 4.dp.toPx()
        val midY = size.height / 2
        drawLine(
            color = hairline,
            start = Offset(0f, midY),
            end = Offset(size.width, midY),
            strokeWidth = 1.dp.toPx(),
            pathEffect = PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 3.dp.toPx())),
        )
        val playheadX = minOf(levels.size * step, floor(size.width - bar))
        val fits = maxOf(0, (playheadX / step).toInt())
        val shown = levels.takeLast(fits)
        val start = playheadX - (shown.size * step - (step - bar))
        val tint = if (running) primary else primary.copy(alpha = 0.4f)
        shown.forEachIndexed { i, level ->
            val h = maxOf(bar, level * 34.dp.toPx())
            val x = start + i * step + bar / 2
            drawLine(
                color = tint,
                start = Offset(x, midY - h / 2 + bar / 2),
                end = Offset(x, midY + h / 2 - bar / 2),
                strokeWidth = bar,
                cap = StrokeCap.Round,
            )
        }
        val playhead = size.height * 0.75f
        drawRoundRect(
            color = primary,
            topLeft = Offset(playheadX, midY - playhead / 2),
            size = Size(bar, playhead),
            cornerRadius = CornerRadius(bar / 2),
        )
    }
}

/**
 * One microphone check: capture → the hosted relay → the words said → the
 * speaker background and the dictionary, the desktop's `MicStep` end to end
 * (see [MicIntro]): the sentence is normalized, tidied by the hosted model into
 * background lines and terms, appended to the background without touching what
 * is there, and its company and name become terms. Testing again takes the
 * previous run's lines and new terms back out first. iOS `MicCheckModel`.
 *
 * Owned by the wizard, not the step, and running on its own scope rather than
 * a composition's: a run stopped by leaving the step, or the wizard, still
 * finishes saving.
 *
 * The cloud and kit calls it makes — [MicIntro], `CloudClient.chatCompletion`,
 * `LexiconStore.apply` — are all in [normalized] and [finish].
 */
class MicCheckModel(private val context: Context, private val container: AppContainer) {

    sealed interface Phase {
        data object Idle : Phase
        data object Listening : Phase
        data object Stopping : Phase
        data object Saved : Phase
        data object Empty : Phase
        data class Failed(val reason: Failure, val detail: String? = null) : Phase
    }

    /** Why a check did not run; the screen maps it to copy. */
    enum class Failure { PERMISSION, SIGNED_OUT, TRANSCRIPTION }

    var phase by mutableStateOf<Phase>(Phase.Idle)
        private set
    var text by mutableStateOf("")
        private set
    var levels by mutableStateOf<List<Float>>(emptyList())
        private set

    /** A headset's or external microphone's name; null is the phone's own. */
    var inputName by mutableStateOf<String?>(null)
        private set

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var mic: MicCapture? = null
    private var relay: SttRelayClient? = null
    private var jobs: List<Job> = emptyList()
    private var timeoutJob: Job? = null
    private var demoJob: Job? = null
    private var transcript = MicIntro.Transcript()

    /** What the previous check put into the setup, so a new one replaces it. */
    private var lastRun: MicIntro.Run? = null

    /** Bumped by every start, so a late close or timer from an earlier run cannot finish the current one. */
    private var generation = 0

    /** Set while a run is being saved, so the relay's close and the backstop cannot both save it. */
    private var finishing = false

    private val toHant: Transliterator? by lazy {
        runCatching { Transliterator.getInstance("Hans-Hant") }.getOrNull()
    }

    /** An attached headset or external microphone, if there is one — what a recording would use. */
    fun refreshInput() {
        val manager = context.getSystemService(AudioManager::class.java) ?: return
        val external = manager.getDevices(AudioManager.GET_DEVICES_INPUTS).firstOrNull { it.type in EXTERNAL_INPUTS }
        inputName = external?.productName?.toString()?.takeIf { it.isNotBlank() }
    }

    fun start() {
        if (phase == Phase.Listening || phase == Phase.Stopping) return
        generation += 1
        val run = generation
        undoLastRun()
        text = ""
        transcript = MicIntro.Transcript()
        levels = emptyList()
        if (DemoMode.isActive) {
            runDemo()
            return
        }
        if (!context.isGranted(Manifest.permission.RECORD_AUDIO)) {
            phase = Phase.Failed(Failure.PERMISSION)
            return
        }
        phase = Phase.Listening
        scope.launch { open(run) }
    }

    /** The system said no to the microphone. */
    fun permissionRefused() {
        if (phase == Phase.Listening || phase == Phase.Stopping) return
        phase = Phase.Failed(Failure.PERMISSION)
    }

    private suspend fun open(run: Int) {
        val token = container.auth.currentToken()
        if (run != generation || phase != Phase.Listening) return
        if (token == null) {
            phase = Phase.Failed(Failure.SIGNED_OUT)
            return
        }
        // The product's name first among the recognition terms: the check has
        // the user say it (the desktop's `withProductName`).
        val vocabulary = listOf(MicIntro.PRODUCT_NAME) +
            container.lexicon.recognitionTerms().filter { it != MicIntro.PRODUCT_NAME }
        val client = SttRelayClient(
            SttRelayClient.Options(
                bearerToken = token,
                feature = SttRelayClient.Feature.VOICE_TYPING,
                languageHints = listOf("zh", "en"),
                diarization = false,
                hintTerms = vocabulary,
            ),
        )
        val capture = MicCapture(context)
        relay = client
        mic = capture
        val events = scope.launch { client.events.collect { handle(it, run) } }
        try {
            client.open()
        } catch (e: IllegalArgumentException) {
            cancel()
            phase = Phase.Failed(Failure.TRANSCRIPTION, e.message)
            return
        }
        val meter = scope.launch { capture.level.collect { push(it) } }
        val feed = scope.launch(Dispatchers.Default) {
            try {
                capture.start().collect { client.enqueuePcm(it) }
            } catch (e: MicCaptureException) {
                withContext(Dispatchers.Main.immediate) {
                    if (run == generation && phase == Phase.Listening) {
                        cancel()
                        phase = Phase.Failed(
                            if (e is MicCaptureException.PermissionDenied) Failure.PERMISSION else Failure.TRANSCRIPTION,
                            e.message,
                        )
                    }
                }
            }
        }
        jobs = listOf(events, meter, feed)
        refreshInput()
        // A self-introduction takes seconds; the check ends here so the
        // microphone and the paid stream are not left open.
        timeoutJob = scope.launch {
            delay(MAX_DURATION_MS)
            if (generation == run) stop()
        }
    }

    /**
     * Stop listening and save what was said. Also what leaving the step (or the
     * wizard) does; a check that is not listening is left as it is.
     */
    fun stop() {
        if (phase != Phase.Listening) return
        phase = Phase.Stopping
        val run = generation
        timeoutJob?.cancel()
        if (DemoMode.isActive) {
            demoJob?.cancel()
            scope.launch {
                delay(DEMO_STOP_MS)
                finish(run)
            }
            return
        }
        mic?.stop()
        mic = null
        val client = relay
        scope.launch {
            runCatching { client?.finish() }
            // The relay's close normally finishes the run; this is the backstop
            // for a close that never comes.
            delay(CLOSE_WAIT_MS)
            if (generation == run && phase == Phase.Stopping) finish(run)
        }
    }

    /** Drop the check without saving: only for a failed start. */
    private fun cancel() {
        demoJob?.cancel()
        demoJob = null
        timeoutJob?.cancel()
        mic?.stop()
        mic = null
        relay?.cancel()
        relay = null
        jobs.forEach { it.cancel() }
        jobs = emptyList()
        if (phase == Phase.Listening || phase == Phase.Stopping) phase = Phase.Idle
    }

    private fun handle(event: SttRelayEvent, run: Int) {
        if (run != generation) return
        when (event) {
            is SttRelayEvent.Segment -> {
                transcript.accept(event.segment)
                text = normalized(transcript.text)
            }
            is SttRelayEvent.Closed -> if (phase == Phase.Stopping || phase == Phase.Listening) {
                mic?.stop()
                mic = null
                phase = Phase.Stopping
                scope.launch { finish(run) }
            }
            is SttRelayEvent.Error -> failed(event.message, run)
            is SttRelayEvent.QuotaExceeded -> failed(event.message, run)
        }
    }

    private fun failed(message: String, run: Int) {
        when (phase) {
            Phase.Listening -> {
                cancel()
                phase = Phase.Failed(Failure.TRANSCRIPTION, message)
            }
            // The words are in; a failed close does not lose them.
            Phase.Stopping -> scope.launch { finish(run) }
            else -> Unit
        }
    }

    private fun push(level: Float) {
        if (phase != Phase.Listening) return
        levels = (levels + minOf(1f, level * LEVEL_GAIN)).takeLast(MAX_LEVELS)
    }

    /** The desktop's `normalizeTranscriptText` + `fixProductName`, with the user's own replacements. */
    private fun normalized(raw: String): String = MicIntro.normalize(
        raw,
        toTraditional = { input -> toHant?.transliterate(input) ?: input },
        replace = { input -> container.lexicon.apply(input) },
    )

    /** The desktop's `finish`: the sentence into the background and the dictionary. Once per check. */
    private suspend fun finish(run: Int) {
        if (run != generation || phase != Phase.Stopping || finishing) return
        finishing = true
        try {
            jobs.forEach { it.cancel() }
            jobs = emptyList()
            relay?.cancel()
            relay = null
            val said = normalized(transcript.text).trim()
            text = said
            if (said.isEmpty()) {
                phase = Phase.Empty
                return
            }
            val summary = if (DemoMode.isActive) MicIntro.Summary.plain(said) else summarize(said)
            // The company and name always become terms, model or not.
            val intro = MicIntro.complete(summary, said)
            val flags = container.onboarding
            val appended = MicIntro.append(intro.background, flags.background.value)
            flags.setBackground(appended.text)
            val created = withContext(Dispatchers.IO) { addTerms(intro.terms) }
            lastRun = MicIntro.Run(lines = appended.lines, createdTerms = created)
            if (run == generation) phase = Phase.Saved
        } finally {
            finishing = false
        }
    }

    /** The hosted model's tidy-up; the sentence itself when there is no answer. */
    private suspend fun summarize(said: String): MicIntro.Summary = try {
        val response = container.cloud.chatCompletion(MicIntro.requestJson(said, chinese()), CloudChat.Feature.MEETING)
        MicIntro.parse(CloudChat.content(response) ?: "", said) ?: MicIntro.Summary.plain(said)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        Log.w(TAG, "onboarding: summarizing the self-introduction failed", e)
        MicIntro.Summary.plain(said)
    }

    /** Adds [terms] to the dictionary; returns the ones that were not there before. */
    private fun addTerms(terms: List<String>): List<String> {
        val lexicon = container.lexicon
        val had = lexicon.load().terms.map { it.text }.toSet()
        val created = mutableListOf<String>()
        for (term in terms) {
            val phrase = term.trim()
            if (phrase.isEmpty() || phrase.length > MicIntro.MAX_TERM_CHARS) continue
            if (phrase !in had && phrase !in created) created += phrase
            lexicon.addTerm(phrase)
        }
        return created
    }

    /** Testing again replaces the previous result: its background lines out, the terms it created gone. */
    private fun undoLastRun() {
        val last = lastRun ?: return
        lastRun = null
        val flags = container.onboarding
        flags.setBackground(MicIntro.remove(last.lines, flags.background.value))
        last.createdTerms.forEach { container.lexicon.removeTerm(it) }
    }

    private fun chinese(): Boolean = context.resources.configuration.locales[0].language == "zh"

    /** No microphone and no network in the demo: a sentence types itself over made-up levels until Stop. */
    private fun runDemo() {
        phase = Phase.Listening
        val sentence = if (chinese()) DEMO_SENTENCE_ZH else DEMO_SENTENCE_EN
        demoJob = scope.launch {
            var shown = 0
            while (isActive) {
                delay(DEMO_TICK_MS)
                if (phase != Phase.Listening) return@launch
                push(Random.nextFloat() * 0.1f + 0.02f)
                if (shown < sentence.length) {
                    shown += 1
                    transcript.accept(
                        TranscriptSegment(
                            id = "mix-0",
                            source = "mix",
                            speaker = 0,
                            text = sentence.take(shown),
                            isFinal = true,
                            startMs = 0,
                            endMs = 0,
                        ),
                    )
                    text = normalized(transcript.text)
                }
            }
        }
    }

    private companion object {
        const val MAX_LEVELS = 200
        const val LEVEL_GAIN = 8f
        const val MAX_DURATION_MS = 30_000L
        const val CLOSE_WAIT_MS = 4_000L
        const val DEMO_STOP_MS = 700L
        const val DEMO_TICK_MS = 80L
        const val DEMO_SENTENCE_ZH = "我是派斯科技的設計師王小明，我主要用 Parley 來整理客戶會議。"
        const val DEMO_SENTENCE_EN =
            "I'm Ming, a designer at Pathors, and I use Parley to keep track of customer meetings."

        val EXTERNAL_INPUTS: Set<Int> = buildSet {
            add(AudioDeviceInfo.TYPE_WIRED_HEADSET)
            add(AudioDeviceInfo.TYPE_USB_HEADSET)
            add(AudioDeviceInfo.TYPE_USB_DEVICE)
            add(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) add(AudioDeviceInfo.TYPE_BLE_HEADSET)
        }
    }
}
