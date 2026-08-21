package com.pathors.parley.voicetyping

import android.content.res.Configuration
import android.inputmethodservice.InputMethodService
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.ImageButton
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.pathors.parley.BuildConfig
import com.pathors.parley.R
import com.pathors.parley.auth.AuthManager
import com.pathors.parley.parleyContainer
import com.pathors.parley.screenshot.DemoMode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Parley's dictation keyboard: an [InputMethodService] that streams the
 * microphone to the hosted STT relay and types the result into whatever app the
 * user is in.
 *
 * ## How this differs from iOS, and why
 *
 * On iOS a keyboard extension is *forbidden* from opening the microphone, so
 * `ios/Keyboard/` hands every dictation off to the container app, which records
 * and passes text back through an App Group. Android has no such rule: an IME
 * runs in its own app's process and may hold `RECORD_AUDIO`, so this keyboard
 * records **itself** — mic, relay and `InputConnection` all in one process, with
 * no channel, no session ids and no app switch per dictation.
 *
 * The one thing an IME cannot do is **request a runtime permission**: there is no
 * Activity to host the request. So the hand-off survives in a much smaller form —
 * a one-time trip to the app to grant the mic (and to sign in, if there is no
 * cloud session for the relay to authenticate with). Everything about that trip
 * lives in [VoiceTypingSetup], including why getting it wrong is the classic way
 * dictation keyboards die silently.
 *
 * ## Why classic Views and not Compose
 *
 * The app is otherwise entirely Compose, and this file is the deliberate
 * exception:
 *
 * * An `InputMethodService` is not a `LifecycleOwner`, `ViewModelStoreOwner` or
 *   `SavedStateRegistryOwner`, so `ComposeView` here needs hand-rolled owner
 *   plumbing attached to the input view before it will compose at all — extra
 *   moving parts in a surface the user cannot escape from if it breaks, since a
 *   keyboard that fails to draw leaves them unable to type.
 * * The surface is five controls. Compose buys nothing at this size, and this
 *   layout has no state that outlives a keystroke.
 * * An IME is loaded into the input pipeline of *every* app on the device. A
 *   plain `LinearLayout` inflates in microseconds and adds no runtime to a
 *   process we are a guest in.
 *
 * Material 3 still applies — the palette is the app's own scheme, including
 * dynamic color on API 31+ (see [KeyboardPalette]).
 *
 * ## The commit rule
 *
 * Provisional text goes in as **composing text** and settled text is
 * **committed**; the delta bookkeeping that keeps the user from seeing a word
 * twice is [TranscriptCommitter], which is pure and unit-tested. This service
 * only supplies it with an [DictationEditor] backed by `currentInputConnection`.
 */
class ParleyInputMethodService : InputMethodService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val handler = Handler(Looper.getMainLooper())

    private lateinit var auth: AuthManager

    /**
     * Whether a cloud session token exists. Null until the first DataStore read
     * lands — treated as "not yet known", which only ever makes the keyboard
     * offer the setup route a moment early.
     */
    private var signedIn: Boolean? = null

    private var session: VoiceTypingSession? = null
    private var sessionJobs: Job? = null
    private var lastState: VoiceTypingState = VoiceTypingState.Idle
    private var remainingSeconds: Long = VoiceTypingSession.MAX_SESSION_SECONDS

    /** The layout's own bottom padding, before the navigation-bar inset. */
    private var basePaddingBottom = 0

    private var palette: KeyboardPalette? = null
    private var stateLine: TextView? = null
    private var setupAction: TextView? = null
    private var micButton: MicButton? = null

    /**
     * The editor seam. It resolves `currentInputConnection` per call on purpose:
     * the connection is replaced whenever the user moves between fields, and a
     * cached one would type into a text box that is no longer there.
     */
    private val editor = object : DictationEditor {
        override fun commitText(text: String) {
            currentInputConnection?.commitText(text, 1)
        }

        override fun setComposingText(text: String) {
            currentInputConnection?.setComposingText(text, 1)
        }

        override fun finishComposing() {
            currentInputConnection?.finishComposingText()
        }
    }

    private val committer = TranscriptCommitter(editor)

    override fun onCreate() {
        super.onCreate()
        auth = parleyContainer.auth
        // The relay needs a bearer token, so "signed out" is a first-class state
        // of this keyboard rather than a failure to discover on the first tap.
        scope.launch {
            auth.isSignedIn.collect { value ->
                signedIn = value
                render()
            }
        }
    }

    // ---------------------------------------------------------------- the view

    override fun onCreateInputView(): View {
        val root = LayoutInflater.from(this).inflate(R.layout.keyboard_voice, null)
        stateLine = root.findViewById(R.id.keyboard_state)
        setupAction = root.findViewById(R.id.keyboard_setup_action)
        micButton = root.findViewById<MicButton>(R.id.keyboard_mic).apply {
            contentDescription = getString(R.string.voice_typing_mic_start)
            setOnClickListener { onMicTap() }
        }

        setupAction?.setOnClickListener { VoiceTypingSetup.openSetupInApp(this) }

        bindKey(
            root.findViewById(R.id.keyboard_switch_ime),
            R.drawable.ic_kb_language,
            R.string.voice_typing_switch_keyboard,
        ) { VoiceTypingSetup.showImePicker(this) }
        bindKey(
            root.findViewById(R.id.keyboard_backspace),
            R.drawable.ic_kb_backspace,
            R.string.voice_typing_backspace,
        ) { backspace() }
        bindKey(
            root.findViewById(R.id.keyboard_enter),
            R.drawable.ic_kb_return,
            R.string.voice_typing_enter,
        ) { enter() }
        armBackspaceRepeat(root.findViewById(R.id.keyboard_backspace))

        insetForNavigationBar(root)
        applyPalette(root)
        render()
        return root
    }

    /**
     * Keep the bottom row clear of the system navigation bar.
     *
     * From API 35 an IME window is drawn edge-to-edge, so it extends behind the
     * navigation bar — and the framework draws its *own* controls down there, the
     * hide-keyboard chevron and the input-method switcher. Without this padding
     * our globe and return keys are laid out underneath those: clipped, and two
     * targets on the same pixels.
     *
     * Applied from a listener *and* on every [onStartInputView], because a
     * listener registered on a detached view is not guaranteed a dispatch before
     * the keyboard is first shown — which is exactly what left the row clipped
     * after a configuration change recreated the input view.
     */
    private fun insetForNavigationBar(root: View) {
        basePaddingBottom = root.paddingBottom
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            applyBottomInset(view, insets)
            insets
        }
    }

    private fun applyBottomInset(root: View, insets: WindowInsetsCompat?) {
        val resolved = insets ?: ViewCompat.getRootWindowInsets(root) ?: return
        val bottom = resolved.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom
        val target = basePaddingBottom + bottom
        if (root.paddingBottom == target) return
        root.setPadding(root.paddingLeft, root.paddingTop, root.paddingRight, target)
    }

    private fun bindKey(button: ImageButton, icon: Int, description: Int, action: () -> Unit) {
        button.setImageDrawable(ContextCompat.getDrawable(this, icon))
        button.contentDescription = getString(description)
        button.setOnClickListener { action() }
    }

    /**
     * Hold-to-repeat on backspace. It is the only way to delete in this keyboard,
     * so one character per tap would make fixing a mis-heard sentence painful.
     *
     * The touch listener returns false so the ordinary click and long-click paths
     * keep working; it exists only to notice the finger lifting.
     */
    private fun armBackspaceRepeat(button: ImageButton) {
        val repeat = object : Runnable {
            override fun run() {
                backspace()
                handler.postDelayed(this, BACKSPACE_REPEAT_MS)
            }
        }
        button.setOnLongClickListener {
            handler.postDelayed(repeat, BACKSPACE_REPEAT_MS)
            true
        }
        button.setOnTouchListener { _, event ->
            if (event.actionMasked == MotionEvent.ACTION_UP ||
                event.actionMasked == MotionEvent.ACTION_CANCEL
            ) {
                handler.removeCallbacks(repeat)
            }
            false
        }
    }

    private fun applyPalette(root: View) {
        val colors = KeyboardPalette.of(this)
        palette = colors
        root.setBackgroundColor(colors.background)
        val radius = dp(14f)
        stateLine?.setTextColor(colors.muted)
        setupAction?.apply {
            setTextColor(colors.onAccent)
            background = colors.accentBackground(radius)
        }
        micButton?.palette = colors
        for (id in intArrayOf(
            R.id.keyboard_switch_ime,
            R.id.keyboard_backspace,
            R.id.keyboard_enter,
        )) {
            root.findViewById<ImageButton>(id).apply {
                background = colors.keyBackground(radius)
                setColorFilter(colors.onKey)
            }
        }
    }

    private fun dp(value: Float): Float =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, resources.displayMetrics)

    /**
     * Never take over the whole screen. Extract mode would hide the very field
     * the user is dictating into, and a dictation keyboard has nothing to gain
     * from the extra room.
     */
    override fun onEvaluateFullscreenMode(): Boolean = false

    // ----------------------------------------------------------- input plumbing

    override fun onStartInput(info: EditorInfo?, restarting: Boolean) {
        super.onStartInput(info, restarting)
        // A new field: any composing text belonged to the old one.
        if (!restarting) committer.reset()
    }

    override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
        super.onStartInputView(info, restarting)
        // Re-read the palette on every appearance so a night-mode flip lands even
        // if the framework reused the input view.
        micButton?.rootView?.let { root ->
            applyPalette(root)
            applyBottomInset(root, null)
        }
        render()
    }

    /**
     * The keyboard is going away. Stop the microphone — a dictation must never
     * outlive the surface that shows it is running, and the mic is the one
     * resource here the user would not forgive us for holding.
     */
    override fun onFinishInputView(finishingInput: Boolean) {
        super.onFinishInputView(finishingInput)
        endSession()
    }

    override fun onFinishInput() {
        super.onFinishInput()
        // The connection is gone; forget the high-water mark without touching it.
        committer.reset()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        micButton?.let { applyPalette(it.rootView) }
    }

    override fun onDestroy() {
        session?.dispose()
        session = null
        handler.removeCallbacksAndMessages(null)
        scope.cancel()
        super.onDestroy()
    }

    // ------------------------------------------------------------------- keys

    private fun backspace() {
        // Settle the composing region first: deleting *into* provisional text
        // would leave the committer's bookkeeping describing something the field
        // no longer contains.
        committer.finish()
        sendDownUpKeyEvents(KeyEvent.KEYCODE_DEL)
    }

    /**
     * Return. Unlike iOS — where a keyboard extension has no way to fire the
     * host's return action and `ios/Keyboard/` therefore always types a line
     * break — Android exposes [android.view.inputmethod.InputConnection.performEditorAction],
     * so a field asking for Send/Go/Search gets exactly that. Anything else types
     * a newline.
     */
    private fun enter() {
        committer.finish()
        val info = currentInputEditorInfo
        val action = info?.imeOptions?.and(EditorInfo.IME_MASK_ACTION) ?: EditorInfo.IME_ACTION_NONE
        val suppressed = (info?.imeOptions?.and(EditorInfo.IME_FLAG_NO_ENTER_ACTION) ?: 0) != 0
        if (!suppressed &&
            action != EditorInfo.IME_ACTION_NONE &&
            action != EditorInfo.IME_ACTION_UNSPECIFIED
        ) {
            currentInputConnection?.performEditorAction(action)
        } else {
            currentInputConnection?.commitText("\n", 1)
        }
    }

    // --------------------------------------------------------------- dictation

    /**
     * Whether this keyboard can dictate on its own right now.
     *
     * ScreenshotDemo stands both conditions down in debug builds, the same way
     * it stands down the sign-in wall in `ParleyRoot` — it serves a scripted
     * transcript and never touches the microphone, an account or the network.
     */
    private val ready: Boolean
        get() = (BuildConfig.DEBUG && DemoMode.isActive) ||
            (signedIn == true && VoiceTypingSetup.hasMicPermission(this))

    private fun onMicTap() {
        val current = session
        if (current != null && current.state.value is VoiceTypingState.Listening) {
            scope.launch { current.stop() }
            return
        }
        if (!ready) {
            // The whole point of the hand-off: an IME cannot request the
            // permission, and it cannot sign in either.
            VoiceTypingSetup.openSetupInApp(this)
            return
        }
        startSession()
    }

    private fun startSession() {
        endSession()
        committer.reset()
        val fresh = VoiceTypingSession(this, auth)
        session = fresh
        sessionJobs = scope.launch {
            launch {
                // The only place text reaches the editor. Conflation is safe:
                // `settled` is cumulative and `tail` is absolute, so skipping an
                // intermediate value can never lose or duplicate a word.
                fresh.text.collect { committer.update(it.settled, it.tail) }
            }
            launch { fresh.level.collect { micButton?.level = it } }
            launch {
                fresh.elapsedMs.collect { elapsed ->
                    val left = VoiceTypingSession.MAX_SESSION_SECONDS - elapsed / 1_000L
                    if (left != remainingSeconds) {
                        remainingSeconds = left
                        if (left <= COUNTDOWN_FROM_SECONDS) render()
                    }
                }
            }
            launch {
                fresh.state.collect { state ->
                    lastState = state
                    if (state is VoiceTypingState.Done || state is VoiceTypingState.Failed) {
                        // Whatever was still provisional is the last thing the
                        // user said; keep it. Safe in either order relative to
                        // the final text update — see TranscriptCommitter.
                        committer.finish()
                    }
                    render()
                }
            }
        }
        fresh.start()
    }

    /** Stop the mic and drop the session, without waiting for a flush. */
    private fun endSession() {
        sessionJobs?.cancel()
        sessionJobs = null
        session?.dispose()
        session = null
        committer.finish()
        micButton?.level = 0f
        remainingSeconds = VoiceTypingSession.MAX_SESSION_SECONDS
        lastState = VoiceTypingState.Idle
    }

    // ------------------------------------------------------------------ render

    /**
     * One place that decides what the keyboard looks like, from `lastState`,
     * `signedIn` and the mic grant. Called from every input that can change any
     * of those, so there is no partial-update path to get wrong.
     */
    private fun render() {
        val mic = micButton ?: return
        val state = lastState
        val listening = state is VoiceTypingState.Listening
        val finishing = state is VoiceTypingState.Finishing ||
            state is VoiceTypingState.Connecting

        mic.listening = listening
        mic.muted = finishing || !ready
        mic.contentDescription = getString(
            if (listening) R.string.voice_typing_mic_stop else R.string.voice_typing_mic_start
        )

        val needsSetup = !ready
        setupAction?.visibility = if (needsSetup) View.VISIBLE else View.GONE
        setupAction?.text = getString(
            if (signedIn == false) R.string.voice_typing_open_sign_in
            else R.string.voice_typing_open_app
        )

        stateLine?.text = stateText(state, needsSetup)
        stateLine?.setTextColor(
            if (state is VoiceTypingState.Failed) {
                palette?.error ?: 0
            } else {
                palette?.muted ?: 0
            }
        )
    }

    private fun stateText(state: VoiceTypingState, needsSetup: Boolean): String = when {
        // Setup copy wins over everything: it is the only message with an action
        // attached, and a stale error above it would just be noise.
        needsSetup && signedIn == false -> getString(R.string.voice_typing_needs_sign_in)
        needsSetup -> getString(R.string.voice_typing_needs_mic)
        state is VoiceTypingState.Listening ->
            if (remainingSeconds <= COUNTDOWN_FROM_SECONDS) {
                getString(
                    R.string.voice_typing_listening_countdown,
                    remainingSeconds.coerceAtLeast(0),
                )
            } else {
                getString(R.string.voice_typing_listening)
            }

        state is VoiceTypingState.Connecting -> getString(R.string.voice_typing_connecting)
        state is VoiceTypingState.Finishing -> getString(R.string.voice_typing_transcribing)
        state is VoiceTypingState.Done ->
            if (state.reachedLimit) {
                getString(R.string.voice_typing_limit_reached)
            } else {
                getString(R.string.voice_typing_idle)
            }

        state is VoiceTypingState.Failed -> getString(failureMessage(state.reason))
        else -> getString(R.string.voice_typing_idle)
    }

    private fun failureMessage(reason: VoiceTypingFailure): Int = when (reason) {
        VoiceTypingFailure.NOT_SIGNED_IN -> R.string.voice_typing_needs_sign_in
        VoiceTypingFailure.MIC_PERMISSION -> R.string.voice_typing_needs_mic
        VoiceTypingFailure.MIC_UNAVAILABLE -> R.string.voice_typing_error_mic
        VoiceTypingFailure.CONNECTION -> R.string.voice_typing_error_connection
        VoiceTypingFailure.QUOTA_EXCEEDED -> R.string.voice_typing_error_quota
        VoiceTypingFailure.RELAY_ERROR -> R.string.voice_typing_error_relay
    }

    private companion object {
        const val BACKSPACE_REPEAT_MS = 55L

        /** Only show the cap as a countdown once it is close enough to matter. */
        const val COUNTDOWN_FROM_SECONDS = 30L
    }
}
