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
