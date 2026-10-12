package com.pathors.parley.ime

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.pathors.parley.R
import com.pathors.parley.ui.theme.ParleyTextStyles
import com.pathors.parley.ui.theme.ParleyTheme

/** Which part of a dictation the keyboard is drawing. */
enum class DictationPhase { IDLE, CONNECTING, LISTENING, FINISHING }

/**
 * Why the microphone key is dark. Non-null means tapping it cannot start a
 * dictation, and the keyboard says which of these it is instead of just
 * greying out and leaving the user to guess.
 */
enum class DictationBlock {
    /**
     * A password field. The hard refusal — see [InputFieldGuard]. This is the one
     * block the user cannot clear by granting something; it clears when they
     * leave the field.
     */
    PASSWORD_FIELD,

    /** No editor behind the keyboard, or one that accepts no text. */
    NO_FIELD,

    /**
     * `RECORD_AUDIO` is not granted. Tapping the key opens
     * [VoiceTypingSettingsActivity], because an input method has no `Activity`
     * and cannot ask for a runtime permission itself.
     */
    MIC_PERMISSION,
}

/**
 * Something about how the last dictation ended that is worth saying after the
 * words have landed, but is not a failure: drawn in the status slot, in ink
 * rather than the error red. iOS `DictationEnding`.
 */
enum class DictationNotice {
    /** The ten-minute cap stopped the microphone. The words were still committed. */
    LIMIT_REACHED,
}

/** Everything [VoiceKeyboard] draws, assembled by `ParleyInputMethodService`. */
data class VoiceKeyboardState(
    val phase: DictationPhase = DictationPhase.IDLE,
    val level: Float = 0f,
    val elapsedMs: Long = 0L,
    val block: DictationBlock? = null,
    /** The last dictation that ended badly, shown until the next tap. */
    val failure: DictationFailure? = null,
    /** How the last dictation ended, when that is worth a line. Until the next tap. */
    val notice: DictationNotice? = null,
)

/**
 * The whole keyboard: one microphone key, and the words go into whatever app has
 * focus.
 *
 * ## Why there is only one key
 *
 * Android has good keyboards and Parley is not trying to be one. There is no
 * Zhuyin layout (Gboard has one), no QWERTY and no symbol panel — the iOS
 * keyboard carries those only because App Review 4.4.1 requires an iOS keyboard
 * to be usable without Full Access, and Android has no equivalent rule. So this
 * is a dictation pane, the switch key hands typing back to the user's real
 * keyboard, and nothing here pretends otherwise.
 *
 * ## Why the transcript is not echoed here
 *
 * iOS shows the words on the keyboard because it has to: `insertText` cannot be
 * taken back, so nothing at all is inserted until dictation ends, and the
 * keyboard's own text slot is the only place the words exist while they are
 * being spoken (`docs/design/ios-voice-keyboard.md`, "The live transcript").
 *
 * Android has no such problem. `setComposingText` puts the words in the user's
 * actual field, underlined, as they are spoken, and replaces them when the relay
 * revises them. They are already on screen, in the app they are destined for,
 * with a cursor in them. Repeating them here would add a second copy with no
 * authority over the first and invite the question of which one is real. So the
 * pane shows *status* — is it listening, how long, how loud, and what went wrong
 * — and the text lives where it is going.
 */
@Composable
fun VoiceKeyboard(
    state: VoiceKeyboardState,
    onMicClick: () -> Unit,
    onCancelClick: () -> Unit,
    onSwitchKeyboard: () -> Unit,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // Surface, not a bare Box: it paints the scheme's background behind the whole
    // pane so the host app's colours never show through Compose's default
    // transparency.
    Surface(modifier = modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.surface) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .height(KEYBOARD_HEIGHT)
                .padding(horizontal = 16.dp, vertical = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            TopRow(
                state = state,
                onSwitchKeyboard = onSwitchKeyboard,
                onOpenSettings = onOpenSettings,
            )

            Spacer(Modifier.height(4.dp))
            StatusLine(state)
            Spacer(Modifier.weight(1f))

            Row(verticalAlignment = Alignment.CenterVertically) {
                // A fixed-width slot on each side of the key, so the key itself
                // stays dead centre whether or not the discard button is there.
                Box(Modifier.width(CANCEL_SLOT), contentAlignment = Alignment.Center) {}
                MicKey(state = state, onClick = onMicClick)
                Box(Modifier.width(CANCEL_SLOT), contentAlignment = Alignment.Center) {
                    if (state.phase == DictationPhase.LISTENING) {
                        DiscardKey(onCancelClick)
                    }
                }
            }

            Spacer(Modifier.weight(1f))
            HintLine(state)
        }
    }
}

@Composable
private fun TopRow(
    state: VoiceKeyboardState,
    onSwitchKeyboard: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onSwitchKeyboard) {
            Icon(
                painter = painterResource(R.drawable.ic_keyboard_switch),
                contentDescription = stringResource(R.string.ime_switch_keyboard),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.weight(1f))
        // The wordmark, in Alexandria — the one place the brand face is allowed.
        Text(
            text = stringResource(R.string.app_name),
            style = ParleyTextStyles.wordmark,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Spacer(Modifier.weight(1f))
        IconButton(onClick = onOpenSettings) {
            Icon(
                imageVector = Icons.Default.Settings,
                contentDescription = stringResource(R.string.ime_settings_title),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
    // The clock replaces nothing and moves nothing: it is drawn in the same row
    // height whether or not it is there. Elapsed time, quietly, for most of a
    // dictation; in the last 30 seconds before the cap, the countdown in the
    // recording red, because that is the moment the clock becomes news.
    Box(Modifier.fillMaxWidth().height(20.dp), contentAlignment = Alignment.Center) {
        if (state.phase == DictationPhase.LISTENING) {
            val secondsLeft = DictationCountdown.secondsLeft(state.elapsedMs)
            Text(
                text = if (secondsLeft != null) {
                    stringResource(R.string.ime_countdown, secondsLeft)
                } else {
                    elapsedLabel(state.elapsedMs)
                },
                style = MaterialTheme.typography.labelMedium,
                color = if (secondsLeft != null) {
                    ParleyTheme.colors.recording
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
            )
        }
    }
}

@Composable
private fun StatusLine(state: VoiceKeyboardState) {
    val (text, color) = when {
        state.block != null ->
            stringResource(blockMessage(state.block)) to MaterialTheme.colorScheme.onSurfaceVariant

        state.failure != null ->
            stringResource(failureMessage(state.failure)) to MaterialTheme.colorScheme.error

        state.notice == DictationNotice.LIMIT_REACHED && state.phase == DictationPhase.IDLE ->
            stringResource(R.string.ime_notice_limit_reached, DictationCountdown.limitMinutes()) to
                MaterialTheme.colorScheme.onSurfaceVariant

        state.phase == DictationPhase.CONNECTING ->
            stringResource(R.string.ime_status_connecting) to
                MaterialTheme.colorScheme.onSurfaceVariant

        state.phase == DictationPhase.LISTENING ->
            stringResource(R.string.ime_status_listening) to ParleyTheme.colors.recording

        state.phase == DictationPhase.FINISHING ->
            stringResource(R.string.ime_status_finishing) to
                MaterialTheme.colorScheme.onSurfaceVariant

        else -> stringResource(R.string.ime_status_ready) to MaterialTheme.colorScheme.onSurface
    }
    Text(
        text = text,
        style = MaterialTheme.typography.bodyMedium,
        color = color,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
    )
}

/**
 * The one line that has to be on screen when a keyboard nobody recognises
 * appears: the words land in the app you were already typing in, and this key
 * never touches a password.
 */
@Composable
private fun HintLine(state: VoiceKeyboardState) {
    val hint = when (state.block) {
        DictationBlock.PASSWORD_FIELD -> R.string.ime_hint_password
        DictationBlock.MIC_PERMISSION -> R.string.ime_hint_permission
        DictationBlock.NO_FIELD -> R.string.ime_hint_no_field
        null -> R.string.ime_hint_default
    }
    Text(
        text = stringResource(hint),
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.outline,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth(),
    )
}

/**
 * The microphone key: brand blue at rest, recording red while listening, and a
 * halo that breathes with the input level so a user can see the microphone is
 * actually hearing them.
 *
 * The halo is the level meter. A recording that is picking up nothing looks
 * identical to one that is working right up until the transcript fails to
 * appear, and from Android 10 the platform hands a backgrounded app *silence*
 * rather than an error when another app takes the microphone — so on the one
 * failure Android gives no signal for, this is the signal.
 */
@Composable
private fun MicKey(state: VoiceKeyboardState, onClick: () -> Unit) {
    val enabled = state.block == null &&
        state.phase != DictationPhase.CONNECTING &&
        state.phase != DictationPhase.FINISHING
    val listening = state.phase == DictationPhase.LISTENING

    val keyColor = when {
        state.block != null -> MaterialTheme.colorScheme.surfaceVariant
        listening -> ParleyTheme.colors.recording
        else -> MaterialTheme.colorScheme.primary
    }
    val iconColor = when {
        state.block != null -> MaterialTheme.colorScheme.onSurfaceVariant
        else -> MaterialTheme.colorScheme.onPrimary
    }

    // Level is RMS in [0,1] and rarely exceeds ~0.3 for speech, so it is scaled
    // up before it moves anything. Animated, because the raw 100 ms chunks step
    // visibly.
    val halo by animateFloatAsState(
        targetValue = if (listening) (state.level * HALO_GAIN).coerceIn(0f, 1f) else 0f,
        label = "mic-halo",
    )

    Box(contentAlignment = Alignment.Center) {
        if (listening) {
            Box(
                Modifier
                    .size(KEY_DIAMETER)
                    .scale(1f + halo * HALO_TRAVEL)
                    .clip(CircleShape)
                    .background(ParleyTheme.colors.recording.copy(alpha = HALO_ALPHA)),
            )
        }
        IconButton(
            onClick = onClick,
            // Deliberately still clickable while blocked: the tap is how the
            // user gets to the microphone permission, and a dead key that does
            // not say why is worse than one that explains itself. The *dictation*
            // is what is refused, in ParleyInputMethodService.onMicClick, which
            // is the only place that can refuse it safely.
            enabled = enabled || state.block == DictationBlock.MIC_PERMISSION,
            modifier = Modifier
                .size(KEY_DIAMETER)
                .clip(CircleShape)
                .background(keyColor),
        ) {
            Icon(
                painter = painterResource(R.drawable.ic_mic),
                contentDescription = stringResource(
                    if (listening) R.string.ime_mic_stop else R.string.ime_mic_start,
                ),
                tint = iconColor,
                modifier = Modifier.size(ICON_SIZE),
            )
        }
    }
}

/** Throw the utterance away. Only on screen while there is one to throw away. */
@Composable
private fun DiscardKey(onClick: () -> Unit) {
    IconButton(
        onClick = onClick,
        modifier = Modifier
            .size(DISCARD_DIAMETER)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Icon(
            imageVector = Icons.Default.Close,
            contentDescription = stringResource(R.string.ime_discard),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** "1:42" — how long this dictation has been listening. */
@Composable
private fun elapsedLabel(elapsedMs: Long): String {
    val seconds = (elapsedMs.coerceAtLeast(0L) / 1000L).toInt()
    return stringResource(R.string.ime_time_elapsed, seconds / 60, seconds % 60)
}

private fun blockMessage(block: DictationBlock): Int = when (block) {
    DictationBlock.PASSWORD_FIELD -> R.string.ime_blocked_password
    DictationBlock.NO_FIELD -> R.string.ime_blocked_no_field
    DictationBlock.MIC_PERMISSION -> R.string.ime_blocked_permission
}

private fun failureMessage(failure: DictationFailure): Int = when (failure) {
    DictationFailure.NOT_SIGNED_IN -> R.string.ime_failure_signed_out
    DictationFailure.MIC_PERMISSION -> R.string.ime_blocked_permission
    DictationFailure.MIC_UNAVAILABLE -> R.string.ime_failure_mic_unavailable
    DictationFailure.QUOTA_EXCEEDED -> R.string.ime_failure_quota
    DictationFailure.RELAY_ERROR -> R.string.ime_failure_relay
    DictationFailure.UNKNOWN -> R.string.ime_failure_unknown
}

/**
 * The pane's height, which on Android simply *is* the measured height of the
 * input view — there is none of the iOS hack of forcing a height constraint on a
 * container the system owns. 260dp sits a little above a stock keyboard's ~250
 * so the key has room to be a target rather than a button.
 */
private val KEYBOARD_HEIGHT = 260.dp

private val KEY_DIAMETER = 96.dp
private val ICON_SIZE = 40.dp
private val DISCARD_DIAMETER = 48.dp
private val CANCEL_SLOT = 72.dp

/** Speech RMS rarely passes 0.3, so the halo needs the gain to be visible. */
private const val HALO_GAIN = 3.5f

/** How far the halo travels past the key, as a fraction of its diameter. */
private const val HALO_TRAVEL = 0.35f

private const val HALO_ALPHA = 0.25f
