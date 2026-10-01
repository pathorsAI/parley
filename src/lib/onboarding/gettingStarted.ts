/**
 * Home "getting started" checklist + one-time contextual hints.
 *
 * Philosophy: the checklist teaches by doing. Each flag flips only from a real
 * product event — a recording got saved, a recording got filed into a folder,
 * the user sought in replay, the transcript was handed to an external AI — and
 * never from "I've read this" or a click on the checklist itself. Callers wire
 * `markGettingStarted` into the code path where the event actually succeeds.
 *
 * Hints are the same idea in miniature: shown once in context, gone for good
 * after the user has seen or closed them.
 *
 * All writes go through the store's `updateSettings`, so they persist and reach
 * secondary windows through the usual settings sync (see settingsSync.ts).
 */
import { useCallback } from "react";
import { DEFAULT_GETTING_STARTED, useStore } from "../store";
import type { GettingStartedState, GettingStartedStep, HintId, Settings } from "../types";

export { ALL_HINT_IDS } from "../store";

/** The checklist items, in display order. */
export const GETTING_STARTED_STEPS: readonly GettingStartedStep[] = [
  "recorded",
  "filed",
  "replayed",
  "handedOff",
];

/** Current checklist state, tolerating a settings object synced from an older shape. */
function currentGettingStarted(): GettingStartedState {
  return { ...DEFAULT_GETTING_STARTED, ...useStore.getState().settings.gettingStarted };
}

function currentHintsSeen(): HintId[] {
  return useStore.getState().settings.hintsSeen ?? [];
}

/** Tick a checklist item. Idempotent: a no-op (no store write) when already done. */
export function markGettingStarted(step: GettingStartedStep): void {
  const gs = currentGettingStarted();
  if (gs[step]) return;
  useStore.getState().updateSettings({ gettingStarted: { ...gs, [step]: true } });
}

/** The user closed the checklist; it stays closed. */
export function dismissGettingStarted(): void {
  useStore.getState().updateSettings({
    gettingStarted: { ...currentGettingStarted(), dismissedAt: Date.now() },
  });
}

/** Start the checklist over (Settings → "show the checklist again"). */
export function resetGettingStarted(): void {
  useStore.getState().updateSettings({ gettingStarted: { ...DEFAULT_GETTING_STARTED } });
}

export function gettingStartedProgress(s: GettingStartedState): { done: number; total: number } {
  const done = GETTING_STARTED_STEPS.filter((step) => s[step]).length;
  return { done, total: GETTING_STARTED_STEPS.length };
}

/** Shown until the user dismisses it or finishes all four items. */
export function isGettingStartedVisible(s: GettingStartedState): boolean {
  if (s.dismissedAt !== null) return false;
  return !GETTING_STARTED_STEPS.every((step) => s[step]);
}

/** Record that a hint was seen (or closed). Idempotent. */
export function markHintSeen(id: HintId): void {
  const seen = currentHintsSeen();
  if (seen.includes(id)) return;
  useStore.getState().updateSettings({ hintsSeen: [...seen, id] });
}

export function hasSeenHint(settings: Settings, id: HintId): boolean {
  return (settings.hintsSeen ?? []).includes(id);
}

/** `[visible, dismiss]` for a one-time hint; re-renders when it is marked seen. */
export function useHint(id: HintId): [visible: boolean, dismiss: () => void] {
  const visible = useStore((s) => !hasSeenHint(s.settings, id));
  const dismiss = useCallback(() => markHintSeen(id), [id]);
  return [visible, dismiss];
}
