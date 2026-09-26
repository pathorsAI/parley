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
  turns into Stop voice typing; the second click ends the dictation and the
  text lands on the clipboard. Where it pastes depends on which window is in
  front when the dictation ends — after a tray click that is usually not your
  document, so the clipboard is the reliable result.
- **Clipboard paste** (`paste_to_frontmost` in `src-tauri/src/voice_typing.rs`).
  Dictating into Notepad, a browser text field and an Office app pastes the
  text at the caret, and the held Ctrl+Alt of the shortcut does not turn the
  paste into Ctrl+Alt+V.
- **UIPI clipboard-only fallback.** Dictating into a window running as
  administrator (e.g. an elevated terminal) cannot paste — Windows blocks
  input injection into higher-integrity processes. The overlay should say the
  text is on the clipboard, and Ctrl+V should paste it.
- **Caches** (Settings › MCP Server › Caches). The only way to clear caches on
  Windows, which draws no menu bar: sizes show, each Clear works, and Clear all
  asks first.
