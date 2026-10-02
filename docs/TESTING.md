# Testing

Parley's automated tests cover the **application + domain layer** — the app's own
logic and use-cases — not infrastructure and not "the model".

## What we test (and what we don't)

**Do test**

- Pure domain functions: trim-window overlap, speaker identity/labeling,
  transcript formatting, cost arithmetic, definition→runtime transforms.
- Application use-cases driven through their real surface: the zustand store via
  its actions, and use-cases like voice diarization with their boundaries mocked.

**Don't test**

- Tauri `invoke`/IPC, the ONNX/diarization native pipeline, network, or real
  LLM/STT calls. These are **boundaries** — they're mocked at the seam, never hit.
- Trivial getters, or anything non-deterministic (clocks, randomness, real models).

## Methodology

- **Behavior over implementation.** Assert observable contracts (inputs → outputs,
  actions → resulting state), not internal wiring.
- **Arrange–Act–Assert.** Each test sets up a known state, performs one action,
  and asserts the result.
- **Deterministic fixtures.** Shared builders live in
  [`src/lib/test/fixtures.ts`](../src/lib/test/fixtures.ts). No clocks, no
  randomness, no network — every value is fixed.
- **Test at the application boundary.** Drive the store through its actions and
  read state back via `useStore.getState()`; call pure functions with realistic
  inputs.
- **Mock only the boundaries** with `vi.mock`:
  - `@tauri-apps/api/core` `invoke` (would run native diarization / IPC),
  - `@tauri-apps/api/event` (backend event stream),
  - the `log` module (its non-Tauri path touches `window`; logging is a
    side-channel we don't assert on).
- **Few high-value tests per use-case** over many shallow ones.

### Resetting the singleton store

The store is a module singleton. Tests snapshot the pristine state once and
restore it before each test so every case starts from a known baseline:

```ts
const INITIAL = useStore.getState();
beforeEach(() => useStore.setState(INITIAL, true)); // `true` = replace, not merge
```

## Layout

Tests are co-located as `*.test.ts` next to the code they cover:

- `src/lib/store.helpers.test.ts` — pure helpers (`isTrimmed`, `speakerKey`,
  `defaultSpeakerLabel`, `speakerLabel`, `transcriptAsText`,
  `transcriptWithTimestamps`, `formatClock`).
- `src/lib/store.actions.test.ts` — the store as an application surface
  (enter/exit replay, ingest wizard + analysis gate, playhead/trim, findings
  selection invalidation, transcript upsert, todos/action items, lifecycle).
- `src/lib/speakers/diarize.test.ts` — the `runVoiceDiarize` use-case with
  `invoke` mocked: maps the IPC result onto the store, excludes trimmed/non-final
  segments, returns the right counts.
- `src/lib/usage/pricing.test.ts` — LLM/STT cost computation (per-bucket billing,
  context tiers, cache-rate fallbacks, unknown-model = 0).
- `src/lib/evaluations/presets.test.ts` — `evalsFromDefs` (definition → runtime
  transform that preserves in-flight state by id).

## Running

```sh
npm test          # run once (vitest run)
npm run test:watch
```

Config lives in [`vitest.config.ts`](../vitest.config.ts) — `environment: "node"`
(the store + pure functions need no DOM); switch a file to `jsdom` only if a test
genuinely needs the DOM.

## Voice-typing overlay: what only a person can check

The overlay's window behaviour is native (`present_voice_overlay` in
`src-tauri/src/voice_typing.rs`), so no unit test reaches it. Walk these on a
Mac, and on Windows as part of the next section, before a release that touches
the overlay:

- **Clicking the overlay never activates Parley.** Click the overlay pill and
  the suggestion buttons mid-dictation: the menu bar stays on the target app,
  the main window does not come forward (whether it is open behind other apps
  or closed to the Dock), and the release still pastes into the original
  field. The suggestion's Add, Ignore and Undo still respond to the first
  click. On macOS, `parley.log` shows `overlay panel preventsActivation=true`
  the first time the overlay appears.
- **Transparent parts pass clicks through** (macOS; `start_hit_poller`). With
  a chat app's composer at the bottom centre of the screen, start a dictation
  and click the composer beside or above the pill: the caret lands there and
  the menu bar stays on the chat app. Moving onto the pill or a suggestion
  bubble catches clicks again, and the buttons still respond. Repeat on a 1×
  external display next to a Retina laptop, and over a full-screen app's
  Space.
- **⌥↩ on a suggestion only accepts it** (`on_ptt` in
  `src-tauri/src/hotkey.rs`). In hold mode, accept a dictionary suggestion
  with ⌥↩ (Alt+Enter on Windows): the bubble turns into "Added · Undo" and no
  dictation starts. The push-to-talk key still works afterwards, after a
  shortcut change in Settings, and after sleep and wake.
- **Esc cancels a dictation** (`src/lib/voiceTyping/cancel.ts`,
  `cancel_shortcuts_for` in `src-tauri/src/hotkey.rs`). Hold each trigger and
  press Esc while still holding it: a recorded combo such as F13, fn, ⌥Space,
  right ⌘ and right ⌥. The overlay turns to "Transcription cancelled · Undo",
  nothing is pasted, and releasing the key does nothing. Also in toggle mode
  (tap, speak, Esc), and during "Polishing…". Then:
  - Undo within 5 s: the text is on the clipboard, a history entry appears,
    nothing is pasted, and the target app keeps focus. Undo while the
    spinner still shows works too.
  - No Undo: the overlay fades and hides at about 5 s, with no history
    entry.
  - A new press during those 5 s starts a fresh dictation.
  - Esc with no dictation running still reaches the app in front, and so
    does Esc right after a dictation has pasted.
  - If ⌥Esc, fn+Esc or another held-key Esc never fires, `parley.log` names
    the chord that did not register (`escape cancel … not registered`).

## Voice typing and the clipboard: what only a person can check

A dictation reaches the field through the clipboard and then gives the
clipboard back (`insert_text`, `src-tauri/src/voice_typing/clipboard.rs`).
The bookkeeping is unit-tested against a fake clipboard; what the real
pasteboard and the apps reading it do is not. On a Mac, and on Windows as
part of the next section:

- **Your clipboard survives a dictation.** Copy an image (from a browser or
  Preview), then a link, and each time dictate into Notes and into a browser
  text field: the text is inserted and the overlay says "Inserted"; ⌘V
  afterwards pastes the image or the link, not the dictation. `parley.log`
  shows `clipboard restored` about a second after each paste.
- **The paste reads the dictation, not the restore.** Dictate into a busy
  Electron app (Slack, VS Code) and a Chromium page: the dictated text
  appears, never the clipboard you had before.
- **A copy made right after wins.** Dictate, then copy something else within
  the second after the text appears: ⌘V pastes what you copied, and the log
  says `clipboard changed after the paste; left as it is`.
- **Back to back.** Two quick dictations in a row, then ⌘V: your original
  clipboard, not the first dictation.
- **No paste, so the clipboard is the delivery.** Revoke Accessibility (or
  click Parley's main window so it is in front) and dictate: the overlay
  turns warning and says to press ⌘V; the text is on the clipboard and stays
  there.
- **Clipboard managers do not keep it.** With Maccy, Raycast or Paste
  running, dictate: the dictation does not appear in their history.
- **Nowhere to paste.** Dictate with no text field focused (click the
  desktop first): nothing is inserted; the overlay's Copy puts the text on the
  clipboard and the pill turns into "Copied to clipboard", which ⌘V then
  pastes.
- **Esc, Undo.** Undo of a cancelled dictation leaves its text on the
  clipboard to stay, also when the previous dictation's restore was still
  pending.
- **A password stays out of it.** Copy a password from a password manager,
  then dictate: the dictation is inserted, and afterwards the clipboard is
  empty — Parley neither keeps nor puts back a concealed entry.

## Windows: what only a Windows machine can check

CI builds and lints the Windows target (`cargo clippy --target
x86_64-pc-windows-msvc` on `windows-latest`), and the unit suite is
platform-neutral, so neither says anything about how the Windows build
*behaves*. Nobody on the core team develops on Windows, so these need a real
Windows 10/11 machine — walk them before a release that touches the areas
involved:

- **Tray icon** (`src-tauri/src/tray.rs`). The Parley icon appears in the
  notification area (on Windows 11 it may start behind the ^ overflow arrow);
  hovering shows "Parley"; left click brings the window back, including after it
  was minimized; right click shows Open Parley / Start voice typing / Quit
  Parley, in the app's language, and switching the language in Settings
  relabels them.
- **Close-to-tray** (`hideToTray` in `src/App.tsx`). The close button hides the
  window instead of quitting; the first time only, a dialog explains where it
  went. Voice typing's shortcut still works with the window hidden. Closing
  mid-meeting ends and saves the meeting before hiding. Launching Parley again
  (Start menu, taskbar pin) shows the hidden window rather than starting a
  second copy. Quit Parley from the tray ends the process (check Task Manager),
  and mid-meeting it saves the meeting first.
- **Tray voice typing.** Start voice typing opens the overlay and the item
  turns into Stop voice typing; the second click ends the dictation. Where it
  goes depends on which window is in front when the dictation ends — after a
  tray click that is often not your document. When it is Parley itself, the
  text is left on the clipboard and the overlay says to press Ctrl+V.
- **Dictating with the window hidden** (`src/lib/voiceTyping/settle.ts`). The
  dictation host runs in the main window, and WebView2 throttles a hidden
  page's timers harder after five minutes. Hide Parley to the tray for longer
  than that, then dictate a single word with a short tap: it still pastes, and
  `parley.log` shows `voice-typing: settled` with `reason` `closed`.
- **Voice-typing overlay clicks.** The overlay checks in the section above:
  clicking the pill or a suggestion button mid-dictation leaves the target app
  in front, and the release still pastes into the original field.
- **Overlay click-through, before it is switched on** (`CLICK_THROUGH` in the
  Windows `imp` of `src-tauri/src/voice_typing.rs`). It is off on Windows:
  the toggle needs WS_EX_LAYERED, which can blank a WebView2 window, so the
  transparent area around the pill still eats clicks. Whoever implements the
  toggle walks this at 100 % and 150 % scaling: clicks beside or above the
  pill reach the app behind; the overlay never shows in Alt+Tab or the
  taskbar; it never turns black or invisible after the cursor moves on and off
  the pill; and Ctrl+V still lands in the target app.
- **Esc cancel under a held key** (`windows_hook.rs`, `modifier_ptt.rs`). Hold
  right Ctrl, speak, press Esc: the dictation cancels, the Start menu does not
  open, and nothing is pasted; the next hold dictates normally. The same with
  right Alt (and AltGr on a German or French layout — no menu bar is left
  armed in Notepad), with Ctrl+Alt+Space held, and with an elevated window in
  front.
- **Clipboard paste** (`insert_text` in `src-tauri/src/voice_typing.rs`).
  Dictating into Notepad, a browser text field and an Office app pastes the
  text at the caret, and the held Ctrl+Alt of the shortcut does not turn the
  paste into Ctrl+Alt+V.
- **The clipboard comes back** (`clipboard/windows.rs`). Walk the clipboard
  section above on Windows. Also: copy a range of cells in Excel, dictate into
  Notepad, then paste into Excel — the cells come back as cells (the restore
  is best effort: formats that are GDI objects are skipped, and Windows
  rebuilds the bitmap ones from the DIB). Win+V history (turn it on in
  Settings › System › Clipboard) does not list the dictation. If the restore
  never happens, `parley.log` says why (`clipboard changed after the paste`
  means the sequence number moved while the target app read the paste).
- **UIPI clipboard-only fallback.** Dictating into a window running as
  administrator (e.g. an elevated terminal) cannot paste — Windows blocks
  input injection into higher-integrity processes. The overlay should say the
  text is on the clipboard, and Ctrl+V should paste it; it stays there (no
  restore follows a refused paste).
- **Caches** (Settings › MCP Server › Caches). The only way to clear caches on
  Windows, which draws no menu bar: sizes show, each Clear works, and Clear all
  asks first.
