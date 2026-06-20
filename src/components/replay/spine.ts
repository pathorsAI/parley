/**
 * Replay store selectors.
 *
 * A thin, typed surface over the store's replay slice (`appMode`, `replay`,
 * `replayPlayheadMs`, `setReplayPlayhead`, `exitReplay`) so the rest of
 * `components/replay/*` doesn't reach into the raw store shape directly. The
 * `replay.*` i18n keys now live in messages.ts, so components use `useI18n().t`
 * directly — there's no longer an i18n shim here.
 */
import { useStore } from "../../lib/store";
// Canonical contract published by the ingest module.
import type { ReplaySession } from "../../lib/replay/types";

export type { ReplaySession };

export function useAppMode(): "live" | "replay" {
  return useStore((s) => s.appMode);
}

export function useReplaySession(): ReplaySession | null {
  return useStore((s) => s.replay);
}

export function useReplayPlayheadMs(): number {
  return useStore((s) => s.replayPlayheadMs);
}

export function useSetReplayPlayhead(): (ms: number) => void {
  return useStore((s) => s.setReplayPlayhead);
}

export function useExitReplay(): () => void {
  return useStore((s) => s.exitReplay);
}
