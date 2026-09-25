# Voice typing — the Parley keyboard

Dictation into *any* app: an `InputMethodService` that streams the microphone to
the hosted STT relay and types the result at the cursor. The Android counterpart
of the iOS keyboard extension (`ios/Keyboard/`) and the desktop's push-to-talk
(`src-tauri/src/voice_typing.rs`).

```
com.pathors.parley
  voicetyping/
    ParleyInputMethodService.kt  the IME: input view, keys, session lifecycle
    VoiceTypingSession.kt        mic → relay → text; the max-duration cap
    DictationTextAssembler.kt    segments → (settled, tail)          [pure]
    TranscriptCommitter.kt       (settled, tail) → InputConnection    [pure]
    VoiceTypingSetup.kt          the permission hand-off, both directions
    MicButton.kt                 mic toggle with a level ring
    KeyboardPalette.kt           the keyboard's Material 3 colors
  ui/
    VoiceTypingSetupScreen.kt    in-app onboarding + the hand-off landing pad
  res/
    xml/method.xml               input-method metadata (required)
    layout/keyboard_voice.xml    the input view
    values{,-night}/colors_keyboard.xml
```

## Architecture

```
                    ┌─────────────── the app's own process ───────────────┐
                    │                                                     │
 user speaks ──▶ MicCapture ──ByteArray(3200)──▶ SttRelayClient           │
                    │          16 kHz mono s16le    (feature=voice_typing)│
                    │                                      │              │
                    │                              SttRelayEvent.Segment  │
                    │                                      ▼              │
                    │                        DictationTextAssembler       │
                    │                          (settled, tail)            │
                    │                                      ▼              │
                    │                        TranscriptCommitter          │
                    │                                      ▼              │
                    └────────────────────────── InputConnection ──────────┘
                                                           │
                                                           ▼
                                            whatever app the user is in
```

Everything reused, nothing forked: `MicCapture`, `SttRelayClient`,
`SonioxStreamParser` and `SegmentBuilder` are the same classes a meeting uses.
Voice typing is the meeting pipeline with the encoder and the uploader removed —
compare `meeting/MeetingSession.kt`, which is deliberately the same shape.

Cloud usage is attributed with `SttRelayClient.Feature.VOICE_TYPING`
(`?feature=voice_typing`). The relay whitelists exactly
`meeting | voice_typing | realtime`; anything else bills as unattributed.

### Why the keyboard records, when iOS's cannot

On iOS a keyboard extension is *forbidden* from opening the microphone, so
`ios/Keyboard/KeyboardViewController.swift` hands every dictation to the container
app over an App Group and only inserts the text that comes back. Android has no
such rule: an IME runs inside its own app's process and may hold `RECORD_AUDIO`.
So there is no channel, no session ids, no per-dictation app switch — mic, relay
and `InputConnection` all live in one place.

### Why classic Views, not Compose

The app is otherwise entirely Compose. This one surface is not:

- `InputMethodService` is not a `LifecycleOwner`, `ViewModelStoreOwner` or
  `SavedStateRegistryOwner`, so a `ComposeView` needs hand-rolled owner plumbing
  attached to the input view before it composes at all. That is extra machinery in
  the one surface the user cannot escape if it breaks — a keyboard that fails to
  draw leaves them unable to type at all.
- The surface is five controls with no state that outlives a keystroke.
- An IME is loaded into the input pipeline of every app on the device. A
  `LinearLayout` inflates in microseconds and adds nothing to a process we are a
  guest in.

Material 3 still applies: `KeyboardPalette` is the app's own scheme (the seeds
from `ui/theme/Theme.kt` plus M3 neutrals) including dynamic color on API 31+,
which is what `ParleyTheme` does through `dynamicLightColorScheme()`.

### No foreground service

`MeetingService` needs `foregroundServiceType="microphone"` because a meeting
keeps recording with no UI at all. The keyboard does not: an IME showing its input
view **has a visible window**, which is what Android's microphone policy requires,
and the session is torn down in `onFinishInputView` — the mic never outlives the
surface that shows it running. That also means no notification for something the
user is looking at.

## The permission hand-off

**An `InputMethodService` cannot request a runtime permission.** There is no
Activity to host the request. This is the single most common way third-party
dictation keyboards die: the mic button appears to do nothing, forever, because
nothing in the IME can ever ask for the `RECORD_AUDIO` it is missing.

So the keyboard never tries. `ParleyInputMethodService.ready` is
`signed in && mic granted`; while it is false the keyboard:

1. **says which one is missing** in the state line, in the user's language, and
2. **shows a call to action** whose tap opens `parley://voice-typing`.

```
keyboard (mic button tapped, not ready)
   │  startActivity(parley://voice-typing, FLAG_ACTIVITY_NEW_TASK)
   ▼
MainActivity.handleDeepLink
   │  VoiceTypingSetup.SetupRequest.handle(uri)     ← latches, does not navigate
   ▼
ParleyRoot → (sign-in wall, if signed out) → ParleyNavHost
   │  VoiceTypingHandOff consumes the latch
   ▼
VoiceTypingSetupScreen
   │  step 3 → ActivityResultContracts.RequestPermission(RECORD_AUDIO)
   ▼
user switches back to their app, taps the mic again — now it works
```

Notes on the pieces that are easy to get wrong:

- **The request is a latch, not an event.** The commonest hand-off reason after a
  fresh install is *no signed-in session*, and while the sign-in wall is up the
  navigation graph does not exist yet. A one-shot event would be dropped; the
  latch survives the sign-in trip that the user was sent on.
- **Starting an Activity from a Service** needs `FLAG_ACTIVITY_NEW_TASK`, and it
  is permitted despite Android 10+ background-activity-start restrictions because
  an IME with a visible input view is an app with a visible window — a documented
  exemption. It is also only ever reached from a tap.
- **Signed-out is a first-class state**, not a failure discovered on the first
  tap: the service collects `AuthManager.isSignedIn` for its whole life, so the
  keyboard knows before the user speaks a word.
- **The setup screen re-reads all three conditions on `ON_RESUME`**, because all
  three (keyboard enabled, keyboard selected, mic granted) are toggled in system
  UI where the app gets no callback.
- The keyboard's globe key (`showInputMethodPicker`) is always live, in every
  state. A user who cannot dictate must still be able to leave.

The app also reaches *out* to the system for the two steps no API can do for the
user — enabling the keyboard (`ACTION_INPUT_METHOD_SETTINGS`) and switching to it
(the picker). `ios/App/Parley/SettingsView.swift` presents its equivalent the same
way, for the same reason.

## The partial/final commit rule

This is where a voice keyboard types a word twice, so it is the part with the most
tests (`app/src/test/kotlin/com/pathors/parley/voicetyping/`).

`SegmentBuilder` emits two kinds of segment and the difference is the whole
problem:

| Segment | Id | Behaviour |
|---|---|---|
| **Committed run** | `mix-0`, `mix-1`, … | Settled. Keeps growing under the *same* id until an endpoint or a speaker change closes it, so the concatenation of all runs only ever grows **by appending at the end**. |
| **Tentative tail** | `mix-tail` | The provider's current guess. Rewritten wholesale on nearly every frame, and its words re-appear a moment later inside a committed run. |

The rule:

> **The tail is composing text. Settled growth is committed text.**

`DictationTextAssembler` flattens segments to `(settled, tail)`;
`TranscriptCommitter` turns that into `InputConnection` calls:

```kotlin
if (settled.startsWith(committed)) {          // always true via SegmentBuilder
    val delta = settled.substring(committed.length)
    if (delta.isNotEmpty()) {
        editor.commitText(delta)              // ← also replaces the composing region
        committed = settled
    }
}
if (tail != composing) editor.setComposingText(tail)
```

Two things make it work:

1. **A high-water mark.** Only the delta beyond what was already committed is
   typed, so a run that is re-emitted as it grows does not re-type its prefix.
2. **`commitText` implicitly replaces the composing region.** Committing the
   settled delta erases the stale guess *in the same call*. That is precisely why
   the user never sees `hello hello`.

At the end of a session the tail is the last thing the user said, so it is kept:
`VoiceTypingSession.foldTail()` moves it into `settled`, and the service also
calls `TranscriptCommitter.finish()` on the terminal state. Those arrive over two
separate flows, so **both orders happen** — and both converge, because `finish()`
adds the composing text to the same high-water mark that the final update is
measured against. There is a test for exactly that
(`fold-then-finish and finish-then-fold agree`).

`reset()` is called when a *new* dictation starts and when the editor changes: an
abandoned tail was never settled, and the cursor may be in a different field
entirely.

Mirrors iOS `DictationCoordinator` (which keeps `committed`/`partial` apart and
inserts only the committed delta) and the desktop overlay (which renders committed
runs solid and the tail faint, then pastes the settled result).

## Max session duration

`VoiceTypingSession.MAX_SESSION_SECONDS = 600` — the desktop's
`HOSTED_VOICE_TYPING_MAX_SECONDS` in `src/lib/limits.ts`. **Keep the two in
step.** A dictation the user forgets to stop must not quietly burn the account's
whole transcription quota.

At the cap the session stops itself the same way the user's tap would — the mic
closes, the relay flushes its tail, the text is committed — and the state resolves
to `Done(reachedLimit = true)`, which the keyboard reports rather than leaving the
stop looking like a bug. The last 30 seconds show as a countdown in the state
line.

iOS uses a tighter 120 s: its keyboard extension records through the host app
under a hard jetsam limit. An Android IME runs in the app's own process, so it can
afford the desktop number.

## Manual test checklist

`assembleDebug`, `:parleykit:test` and `:app:testDebugUnitTest` cover the text
path. Everything below needs a real device, because an emulator has no microphone
input.

**Setup and hand-off**

- [ ] Fresh install, signed out: enable the keyboard, switch to it, tap the mic →
      the state line says to sign in and the button opens Parley at the sign-in
      wall. Sign in → the setup screen appears by itself.
- [ ] Signed in, mic not granted: tap the mic → the state line says the keyboard
      cannot ask, the button opens the setup screen, step 3 requests the
      permission. Grant, switch back, tap the mic → it dictates.
- [ ] Deny the permission twice (permanent denial) → the setup screen shows the
      "open app settings" route, and it works.
- [ ] Revoke `RECORD_AUDIO` in system settings while the keyboard is on screen →
      next tap hands off again rather than failing silently.
- [ ] The globe key opens the picker in *every* state, including signed out.

**Dictation**

- [ ] Dictate a sentence into a plain `EditText` (Notes, Messages): words settle
      in place, nothing appears twice, no leftover underlined text at the end.
- [ ] Speak, then stop mid-word: the last guess is kept, not dropped.
- [ ] Speak two sentences with a pause between them → both land, in order,
      joined with the spacing the provider gave (the pause closes a run).
- [ ] zh-TW: dictate Mandarin and check the text is Traditional (the relay's
      S→T pass) and that no character is duplicated at a run boundary.
- [ ] Watch the mic ring: it must move while you speak. A frozen ring during
      speech means another app took the mic and Android is feeding us silence.
- [ ] Tap the mic twice quickly (start, immediate stop) → no crash, no orphaned
      session, and the next tap starts a fresh one.

**Keys and hosts**

- [ ] Backspace deletes one character; hold it and it repeats.
- [ ] Backspace immediately after dictating, while the tail is still underlined →
      deletes exactly one character (the tail is settled first).
- [ ] Return types a newline in a multi-line field, and fires the action in a
      field that asks for one (a search box submits, a chat box sends).
- [ ] Move the cursor / switch to another field mid-dictation → no text lands in
      the wrong place.

**Lifecycle**

- [ ] Dismiss the keyboard while listening → the mic stops (check the status-bar
      mic indicator disappears).
- [ ] Home / recents / lock the screen while listening → the mic stops.
- [ ] Take a phone call while listening → the state line reports the mic being
      unavailable rather than hanging.
- [ ] Turn on airplane mode and tap the mic → a connection error, retryable.
- [ ] With an exhausted hosted quota → the quota message, not a generic failure.
- [ ] Flip the system into dark mode with the keyboard open → the palette follows
      on the next appearance.
- [ ] Leave a dictation running for 10 minutes → it ends itself at the cap, the
      text is committed, and the state line says the limit was reached.
