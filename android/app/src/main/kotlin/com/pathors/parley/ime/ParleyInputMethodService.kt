package com.pathors.parley.ime

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.inputmethodservice.InputMethodService
import android.os.Build
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.ComposeView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.lifecycle.setViewTreeViewModelStoreOwner
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner
import com.pathors.parley.ui.theme.ParleyTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * Parley's keyboard: a microphone key that types what you say into whichever app
 * has focus.
 *
 * ## What this is, and what it deliberately is not
 *
 * It is a **voice-only** input method. There is no Zhuyin layout, no QWERTY and
 * no symbol panel. The iOS keyboard has all three because App Review 4.4.1
 * requires an iOS keyboard extension to be usable with Full Access switched off;
 * Android has no such rule, Gboard is already installed, and a second mediocre
 * Zhuyin layout helps nobody. `switchToNextInputMethod(false)` hands typing
 * straight back, which on iOS is a side-slide track the keyboard has to draw for
 * itself.
 *
 * ## How much smaller this is than iOS, and why
 *
 * The iOS keyboard needs six App Group mailboxes, Darwin notifications, a
 * heartbeat, an insertion high-water mark, a 150-second adoption window and a
 * private-API hop back to the host app — roughly 2,500 lines whose only job is
 * to get around the extension sandbox. None of it has an Android counterpart:
 *
 * | iOS problem | Android |
 * | --- | --- |
 * | An extension may not open the microphone | The IME runs in the app's own process and opens it directly ([DictationService]) |
 * | `insertText` cannot be retracted | `setComposingText` replaces, `commitText` settles |
 * | The extension is suspended when the host takes focus | The IME never leaves the host app |
 * | The keyboard must force its own height | The measured height of the input view *is* the height |
 * | Switching keyboards is a hand-drawn track | One call |
 *
 * ## The lifecycle plumbing
 *
 * Compose will not compose into a view with no `ViewTreeLifecycleOwner` and no
 * `ViewTreeSavedStateRegistryOwner`, and an `InputMethodService` is a `Service`
 * and supplies neither. So the service is all three owners itself, driving a
 * [LifecycleRegistry] off the input-method callbacks: `onCreate` → CREATED,
 * `onWindowShown` → RESUMED, `onWindowHidden` → CREATED, `onDestroy` →
 * DESTROYED. Without the STARTED/RESUMED transitions the pane composes once and
 * then never animates, because `animateFloatAsState` and friends are driven by
 * the frame clock the lifecycle gates.
 */
class ParleyInputMethodService :
    InputMethodService(),
    LifecycleOwner,
    ViewModelStoreOwner,
    SavedStateRegistryOwner {

    private val lifecycleRegistry = LifecycleRegistry(this)
    override val lifecycle: Lifecycle get() = lifecycleRegistry

    private val store = ViewModelStore()
    override val viewModelStore: ViewModelStore get() = store

    private val savedStateController = SavedStateRegistryController.create(this)
    override val savedStateRegistry: SavedStateRegistry get() = savedStateController.savedStateRegistry

    /**
     * Its own scope rather than the lifecycle's: it watches
     * [DictationService.activeSession], which deliberately outlives any one input
     * view, and the watch must survive the user moving between fields.
     */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var sessionJob: Job? = null

    /** What the pane draws. Compose state, so writing it recomposes. */
    private var uiState by mutableStateOf(VoiceKeyboardState())

    /**
     * The `inputType` of the field currently attached, or null when none is.
     * Kept rather than re-read because `onStartInputView` is the only callback
     * that is handed it.
     */
    private var currentInputType: Int? = null

    // ── lifecycle ────────────────────────────────────────────────────────────

    override fun onCreate() {
        // performRestore requires the lifecycle to still be INITIALIZED, so it
        // goes before the ON_CREATE below, and performAttach before it.
        savedStateController.performAttach()
        savedStateController.performRestore(null)
        super.onCreate()
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_CREATE)

        // The owners have to be on the *window's* decor view, not only on the
        // ComposeView, and this is the subtle part of hosting Compose in an
        // input method.
        //
        // `AbstractComposeView.onAttachedToWindow` resolves the recomposer for
        // the whole window, and `createLifecycleAwareWindowRecomposer` looks the
        // lifecycle owner up from the window's own content child — not from the
        // view that asked. In an IME that content child is the platform's
        // `android:id/parentPanel`, which sits *above* our view, so tags set on
        // the ComposeView are invisible to it and the lookup fails with
        // "ViewTreeLifecycleOwner not found from ... parentPanel" — a hard crash
        // of the keyboard process the first time the pane is shown, which on
        // Android leaves the user with no way to type at all.
        //
        // `super.onCreate()` is what builds the window (and calls
        // `onCreateInputView`), and nothing is attached until the pane is first
        // shown, so here is both the earliest and the last safe moment.
        attachOwnersTo(window?.window?.decorView)
    }

    /**
     * Make this service the `ViewTree*Owner` for [view]. Compose needs all three
     * and throws rather than degrading when one is missing.
     */
    private fun attachOwnersTo(view: View?) {
        view ?: return
        view.setViewTreeLifecycleOwner(this)
        view.setViewTreeViewModelStoreOwner(this)
        view.setViewTreeSavedStateRegistryOwner(this)
    }

    override fun onCreateInputView(): View {
        val view = ComposeView(this)
        // Also on the pane itself, so the composition locals resolve from the
        // nearest owner rather than walking the whole window.
        attachOwnersTo(view)
        view.setContent {
            // The app's own appearance setting, not the host app's and not the
            // system's: a keyboard that flips to light because the app behind it
            // is light would be the only part of Parley that does.
            ParleyTheme {
                VoiceKeyboard(
                    state = uiState,
                    onMicClick = ::onMicClick,
                    onCancelClick = ::onCancelClick,
                    onSwitchKeyboard = ::onSwitchKeyboard,
                    onOpenSettings = ::onOpenSettings,
                )
            }
        }
        return view
    }

    override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
        super.onStartInputView(info, restarting)
        currentInputType = info?.inputType

        // A dictation in flight when focus moves to a field that refuses one is
        // cancelled, not committed: the words were meant for the previous field,
        // and the new one may be a password. Cancelling drops the composing text,
        // which is the only ending that leaves nothing behind.
        if (!InputFieldGuard.allowsDictation(currentInputType) && isDictating()) {
            DictationService.requestCancel(this)
        }
        refreshBlock()
        observeSession()
    }

    override fun onWindowShown() {
        super.onWindowShown()
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_START)
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
        refreshBlock()
    }

    override fun onWindowHidden() {
        super.onWindowHidden()
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_PAUSE)
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
    }

    /**
     * The keyboard is going away. A dictation the user cannot see is one they
     * cannot stop, so it ends here.
     *
     * A **stop**, not a cancel: the words already spoken are real and are already
     * in the field as composing text, and the commit below is what settles them.
     * Throwing them away because the pane closed would lose text the user watched
     * themselves dictate.
     */
    override fun onFinishInputView(finishingInput: Boolean) {
        super.onFinishInputView(finishingInput)
        if (isDictating()) DictationService.requestStop(this)
    }

    override fun onFinishInput() {
        super.onFinishInput()
        currentInputType = null
    }

    override fun onDestroy() {
        lifecycleRegistry.handleLifecycleEvent(Lifecycle.Event.ON_DESTROY)
        store.clear()
        scope.cancel()
        super.onDestroy()
    }

    // ── the keys ─────────────────────────────────────────────────────────────

    /**
     * The only key that does anything, and the one place a dictation is allowed
     * to begin.
     *
     * The password refusal is enforced *here* as well as by the key being drawn
     * dark, and that is deliberate: the drawn state is a frame old by definition,
     * and this is the call that reaches the microphone. A guard that only exists
     * in the rendering is a guard that a race can walk through.
     */
    private fun onMicClick() {
        if (!InputFieldGuard.allowsDictation(currentInputType)) {
            refreshBlock()
            return
        }
        if (!hasMicPermission()) {
            // An input method has no Activity and so cannot request a runtime
            // permission. The settings screen can, and this is the tap that
            // takes the user there.
            onOpenSettings()
            return
        }
        if (isDictating()) {
            DictationService.requestStop(this)
            return
        }
        uiState = uiState.copy(failure = null, notice = null)
        DictationService.start(this)
        observeSession()
    }

    private fun onCancelClick() {
        if (isDictating()) DictationService.requestCancel(this)
    }

    /** One call. On iOS this is a hand-drawn side-slide track. */
    private fun onSwitchKeyboard() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            switchToNextInputMethod(false)
        } else {
            // minSdk is 29, so this is unreachable; the branch is here because
            // the platform method is only guaranteed from P and the lint for it
            // is worth keeping honest.
            requestHideSelf(0)
        }
    }

    private fun onOpenSettings() {
        startActivity(
            Intent(this, VoiceTypingSettingsActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }

    // ── the session ──────────────────────────────────────────────────────────

    /**
     * Watch the process-wide session and turn it into composing text.
     *
     * `collectLatest` on the session flow, so a new session replaces the watch on
     * the old one. Idempotent enough to be called from every callback that could
     * have missed a session starting.
     */
    private fun observeSession() {
        sessionJob?.cancel()
        sessionJob = scope.launch {
            DictationService.activeSession.collectLatest { session ->
                if (session == null) {
                    uiState = uiState.copy(phase = DictationPhase.IDLE, level = 0f, elapsedMs = 0)
                    return@collectLatest
                }
                launch { session.text.collect(::showComposing) }
                launch { session.level.collect { uiState = uiState.copy(level = it) } }
                launch { session.elapsedMs.collect { uiState = uiState.copy(elapsedMs = it) } }
                session.state.collect(::onSessionState)
            }
        }
    }

    /**
     * The live captions, straight into the user's field.
     *
     * `setComposingText` replaces the whole composing region every time, which is
     * what makes a relay that revises a run it already emitted a non-problem —
     * the revision is just the next call. The `1` puts the cursor after the text,
     * where a typist would expect it.
     */
    private fun showComposing(text: String) {
        currentInputConnection?.setComposingText(text, 1)
    }

    private fun onSessionState(state: DictationState) {
        when (state) {
            is DictationState.Idle ->
                uiState = uiState.copy(phase = DictationPhase.IDLE)

            is DictationState.Connecting ->
                uiState = uiState.copy(phase = DictationPhase.CONNECTING)

            is DictationState.Listening ->
                uiState = uiState.copy(
                    phase = DictationPhase.LISTENING,
                    failure = null,
                    notice = null,
                )

            is DictationState.Finishing ->
                uiState = uiState.copy(phase = DictationPhase.FINISHING)

            is DictationState.Done -> {
                commit(state.text)
                finish(
                    failure = null,
                    notice = if (state.reachedLimit) DictationNotice.LIMIT_REACHED else null,
                )
            }

            is DictationState.Failed -> {
                // Keep what was heard. Unlike iOS — which could not retract an
                // insertion and therefore had to make the whole utterance one
                // all-or-nothing transaction — the words are already on screen
                // as composing text and the user watched them arrive. Snatching
                // them back on a dropped socket would be the surprising
                // behaviour, not the safe one.
                commit(state.partialText)
                finish(failure = state.reason)
            }

            is DictationState.Cancelled -> {
                // The user asked for nothing to be left behind.
                clearComposing()
                finish(failure = null)
            }
        }
    }

    /**
     * Settle [text] in the field, replacing the composing region.
     *
     * `commitText` on a non-empty string replaces whatever is composing and ends
     * the composition in one operation, which is exactly the swap the polish pass
     * needs: the raw transcript is on screen, the polished text takes its place,
     * and the user's undo sees one edit rather than a delete and an insert.
     */
    private fun commit(text: String) {
        val connection: InputConnection = currentInputConnection ?: return
        if (text.isEmpty()) {
            clearComposing()
        } else {
            connection.commitText(text, 1)
        }
    }

    private fun clearComposing() {
        val connection = currentInputConnection ?: return
        connection.setComposingText("", 1)
        connection.finishComposingText()
    }

    /** Let the session go and put the pane back to rest. */
    private fun finish(failure: DictationFailure?, notice: DictationNotice? = null) {
        uiState = uiState.copy(
            phase = DictationPhase.IDLE,
            level = 0f,
            elapsedMs = 0,
            failure = failure,
            notice = notice,
        )
        DictationService.clear()
    }

    // ── state the pane needs ─────────────────────────────────────────────────

    private fun isDictating(): Boolean = when (DictationService.activeSession.value?.state?.value) {
        is DictationState.Connecting, is DictationState.Listening -> true
        else -> false
    }

    private fun hasMicPermission(): Boolean =
        checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    /** Recompute why the key is dark, if it is. */
    private fun refreshBlock() {
        val inputType = currentInputType
        uiState = uiState.copy(
            block = when {
                InputFieldGuard.isPasswordField(inputType ?: 0) -> DictationBlock.PASSWORD_FIELD
                !InputFieldGuard.allowsDictation(inputType) -> DictationBlock.NO_FIELD
                !hasMicPermission() -> DictationBlock.MIC_PERMISSION
                else -> null
            },
        )
    }
}
