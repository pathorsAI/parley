import { useMemo } from "react";
import { useStore } from "../../lib/store";
import type { TimelineEvent } from "../../lib/types";

/** Reactive selectors over the shared analysis slice — used by both modes. */
export function useFindings(): TimelineEvent[] {
  return useStore((s) => s.findings);
}

/**
 * Map of evaluation id → display name, for labelling which eval a finding came
 * from (findings with source === "eval" carry an `evalId`). Memoized off the
 * runtime `evaluations` so it only rebuilds when the active set changes.
 */
export function useEvalNames(): Map<string, string> {
  const evaluations = useStore((s) => s.evaluations);
  return useMemo(() => new Map(evaluations.map((e) => [e.id, e.name])), [evaluations]);
}

export function useAnalysisStatus() {
  return useStore((s) => s.analysisStatus);
}

export function useAnalysisError() {
  return useStore((s) => s.analysisError);
}

export function useSelectedFindingId() {
  return useStore((s) => s.selectedFindingId);
}

/** Highlight a finding in the timeline + list (no window, no generation). */
export function selectFinding(id: string | null) {
  useStore.getState().setSelectedFinding(id);
}

/**
 * Highlight a finding and seek to its moment — the response to clicking a timeline
 * dot or a list row. Deliberately does NOT open the "how to reply" window (that
 * would spend a solution generation on every click); use {@link openSolution} for
 * that. `onSeek` is mode-specific: live highlights the transcript (setHighlightMs);
 * replay seeks audio.
 */
export function selectAndSeek(event: TimelineEvent, onSeek: (ms: number) => void) {
  useStore.getState().setSelectedFinding(event.id);
  onSeek(event.atMs);
}

/**
 * Open the standalone "how to reply" window for a finding — the explicit action
 * (the only one that triggers a solution generation). Also selects + seeks so the
 * finding is highlighted and we jump to its moment.
 */
export function openSolution(event: TimelineEvent, onSeek: (ms: number) => void) {
  const s = useStore.getState();
  s.setSelectedFinding(event.id);
  s.setSolutionFinding(event.id);
  onSeek(event.atMs);
}
