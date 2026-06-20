/**
 * Replay spine adapter.
 *
 * The replay feature is built around a small set of store additions and i18n
 * keys (`appMode`, `replay`, `replayPlayheadMs`, `setReplayPlayhead`,
 * `exitReplay`, `visibleSegments`, and the `replay.*` strings). Those live in
 * the shared spine files (`src/lib/store.ts`, `src/lib/types.ts`,
 * `src/i18n/messages.ts`) which are owned by another agent.
 *
 * This module is the ONLY place in `src/components/replay/*` that reaches into
 * those (possibly not-yet-landed) symbols. It gives the rest of the replay UI a
 * typed, stable surface to build against. When the real spine lands:
 *   - delete the local `ReplaySession` type here and import it from
 *     `../../lib/types` instead,
 *   - drop the `as` casts in the selectors below (the fields will exist), and
 *   - delete `replayT` and call `useI18n().t` directly (keys will exist).
 *
 * Nothing else in `replay/` should touch the store's replay fields directly.
 */
import { useStore, type useStore as UseStore } from "../../lib/store";
import { translate, type TranslationKey } from "../../i18n";
import type { AppLanguage } from "../../lib/types";
// Canonical contract published by the ingest module. Once a `ReplaySession`
// also lands in `../../lib/types`, prefer that import; the shape is identical.
import type { ReplaySession } from "../../lib/replay/types";

export type { ReplaySession };

/**
 * Shape of the replay-related store slice. The real store will expose exactly
 * these; until then we read them defensively off whatever the store provides.
 */
interface ReplaySpine {
  appMode: "live" | "replay";
  replay: ReplaySession | null;
  replayPlayheadMs: number;
  setReplayPlayhead: (ms: number) => void;
  exitReplay: () => void;
}

type StoreState = ReturnType<typeof UseStore.getState>;

/** Read the replay slice off the (possibly extended) store state. */
function spine(s: StoreState): Partial<ReplaySpine> {
  return s as unknown as Partial<ReplaySpine>;
}

// --- Reactive selectors (use inside components) ----------------------------

export function useAppMode(): "live" | "replay" {
  return useStore((s) => spine(s).appMode ?? "live");
}

export function useReplaySession(): ReplaySession | null {
  return useStore((s) => spine(s).replay ?? null);
}

export function useReplayPlayheadMs(): number {
  return useStore((s) => spine(s).replayPlayheadMs ?? 0);
}

export function useSetReplayPlayhead(): (ms: number) => void {
  return useStore((s) => spine(s).setReplayPlayhead ?? noop);
}

export function useExitReplay(): () => void {
  return useStore((s) => spine(s).exitReplay ?? noop);
}

function noop() {
  /* spine not wired yet */
}

// --- i18n shim --------------------------------------------------------------
//
// The `replay.*` keys are defined in the spine's messages.ts. Until that lands,
// `TranslationKey` won't include them and `t("replay.title")` won't type-check.
// We resolve via the real `translate()` (so once keys exist, they win) and fall
// back to these literals otherwise. Delete this and use `useI18n().t` directly
// when the keys are in messages.ts.

const FALLBACK: Record<AppLanguage, Record<string, string>> = {
  en: {
    "replay.title": "Replay",
    "replay.transcript": "Transcript",
    "replay.evalHere": "Re-evaluate at this moment",
    "replay.evaluating": "Evaluating…",
    "replay.maskedNote":
      "Everything after the playhead is hidden — evals and questions only see up to this moment.",
    "replay.maskedCount": "{count} of {total} segments visible",
    "replay.play": "Play",
    "replay.pause": "Pause",
    "replay.empty": "No transcript yet for this recording.",
    "replay.jumpToMoment": "Jump to this moment",
    "replay.playhead": "Playhead",
  },
  "zh-TW": {
    "replay.title": "重播",
    "replay.transcript": "逐字稿",
    "replay.evalHere": "在此時刻重新評估",
    "replay.evaluating": "評估中…",
    "replay.maskedNote": "播放點之後的內容會被隱藏 — 評估與提問只會看到此刻為止的對話。",
    "replay.maskedCount": "{total} 段中顯示 {count} 段",
    "replay.play": "播放",
    "replay.pause": "暫停",
    "replay.empty": "此錄音尚無逐字稿。",
    "replay.jumpToMoment": "跳到此刻",
    "replay.playhead": "播放點",
  },
};

function interpolate(tpl: string, vars?: Record<string, string | number>): string {
  if (!vars) return tpl;
  return tpl.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ""));
}

/**
 * Translate a `replay.*` key, preferring the real dictionary (once the spine
 * lands) and falling back to bundled literals otherwise.
 */
export function replayT(
  language: AppLanguage,
  key: string,
  vars?: Record<string, string | number>
): string {
  const real = translate(language, key as TranslationKey, vars);
  // `translate` returns the key itself when missing — detect that and fall back.
  if (real !== key) return real;
  const tpl = FALLBACK[language]?.[key] ?? FALLBACK.en[key] ?? key;
  return interpolate(tpl, vars);
}
