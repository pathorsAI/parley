# Parley desktop screenshots — harness

Marketing screenshots of the desktop app (post-#417 "Pathors blue" skin), rendered by the
**real app frontend** (`src/main.tsx` of this repo) in headless Chrome, with fictional demo
data. No UI is drawn by hand. The harness only reads the app source; everything it writes
(`dist/`, `out/`, `text/`) is gitignored.

## Regenerate

From the repository root, with the repo's own dependencies installed (`bun install`):

```bash
cd website/tools/desktop-shots
(cd shooter && bun install)                                    # puppeteer-core only
../../../node_modules/.bin/vite build --config vite.config.ts   # → dist/
node shooter/shoot.mjs                  # every shot → out/*.png + out/*.jpg, text/*.txt
node shooter/shoot.mjs live report      # only shots whose name starts with these
```

Vite resolves `vite`, `react`, `tailwindcss` and `@tauri-apps/api` from the repo root's
`node_modules`. `PARLEY_REPO` defaults to the repo this harness lives in; set it to shoot a
different checkout.

`shoot.mjs` serves `dist/` on an ephemeral 127.0.0.1 port only while it runs, and closes it on
exit. No dev server is involved. It uses `/Applications/Google Chrome.app` (override with
`CHROME_PATH`) and exits non-zero if a shot shows a toast or throws a page error.

Outputs:

- `out/<scene>-<lang>-<theme>.png`: 2880×1800, a 1440×900 CSS-px window at @2x. The window's
  12px rounded corners are **transparent**, as the real macOS window has them. There is no
  native shadow or border, so add one in CSS when you embed the image.
- `out/<scene>-<lang>-<theme>.jpg`: q80, 2000px wide, flattened on white.
- `text/<name>.txt`: the visible text plus `aria-label`/`title`/`placeholder` values of each
  shot, for grepping for i18n leaks.

The site publishes a few of these as web images; see `website/README.md` → "Screenshots" for
the `cwebp` step that turns `out/` into `website/assets/shots/`.

## How it works

| Piece | What it does |
|---|---|
| `vite.config.ts` | Vite root is `app/`, and `@`/`@repo` point to `<repo>/src`. A small plugin appends `@source "<repo>/src"` to the app stylesheet as it loads, because Tailwind v4 otherwise only scans the Vite root. |
| `app/harness.tsx` | Runs before the app. It seeds `localStorage` (language, theme, onboarding done, folders, release notes seen), installs Tauri's own IPC mock (`@tauri-apps/api/mocks`: `mockIPC` + `mockWindows`, with `__TAURI_OS_PLUGIN_INTERNALS__.platform = "macos"`), boots `src/main.tsx`, and then drives the store into the scene. |
| `app/demo-data.ts` | All fictional data: folders, 5 recordings, the renewal transcript, findings, action items, brief and delivery read, in zh-TW and en. |
| `app/harness.css` | The only visual override. See "Honesty notes". |
| `shooter/shoot.mjs` | Headless Chrome with a macOS Safari UA at 1440×900 @2x. It blocks every non-local request, waits for `window.__SHOT_READY__`, and captures. |

Because `isTauri()` is true under the mock, the app takes its **desktop** code paths. The
library route, history reads, traffic lights, the MCP indicator and the menu-bar command
bridge all run as they do in the app. Every backend command is answered by `handle()` in
`harness.tsx`. An unexpected command is logged as `ipc: <cmd>` in the shooter output, so if a
future app version adds a boot-time command, add it there.

Scene URLs: `dist/index.html?scene=home|library|live|report&lang=zh|en&theme=light|dark`.

| Scene | Seeded through |
|---|---|
| `home` | `list_history` → 5 summaries; `openHome()` |
| `library` | same, then `openLibrary({kind:"personal", node:{kind:"all"}})` |
| `library-cmdk` | library, then `emit("menu://command", "nav.jumpTo")`: on macOS the NSMenu owns ⌘K and forwards it as this event, which is why a synthetic keypress does nothing. The shooter then types `續約` / `renew`. |
| `live` | Selects the built-in `tpl-sales` watcher set, then `startMeeting()` with the start time back-dated to 18:47, `addTodo`/`toggleTodo`, `upsertSegment` × 4 (the last one `isFinal: false`), `setFindings` and `setAnalysisStatus("done")`. `audio://level` events drive the titlebar mic meter. |
| `report` | `loadHistoryEntry("rec-northwind")`: the real load path through the `read_history_entry` mock, restoring the brief, action items, delivery, kind `sales` and folder `續約`. |

## Honesty notes

- **No vibrancy.** On macOS the rail sits on NSVisualEffectView's sidebar material, which a
  browser cannot produce. `harness.css` paints the rail with the **solid** `--sidebar` token
  (the value the opaque Windows window uses) instead of a fake gradient.
- **Speakers keep the app's defaults** (`你` / `遠端 1`, `You` / `Remote 1`). Nobody is renamed.
- **Findings, the brief, action items and the delivery read are seeded**, not generated. They
  are written in the shape the app's lenses produce (sales / "opportunity" lens), but no model
  ran. Placeholder `groqApiKey`/`sonioxApiKey` values keep the "no key" gates down. Nothing is
  ever sent: all saved outputs are restored as done, and the shooter aborts all non-local
  network requests.
- **Live timestamps are shifted.** The live excerpt sits at 17:52–18:38 so the timer (18:47)
  and the findings axis agree. The report uses the script's own times (0:12–1:32) for its
  timestamp pills, and the entry lists as 24:36 long.
- **Relative dates are relative to capture time** ("today", "yesterday", …), so recaptures
  stay fresh.
