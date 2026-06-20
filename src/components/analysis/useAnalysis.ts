import { useStore } from "../../lib/store";
import type { TimelineEvent } from "../../lib/types";

/** Reactive selectors over the shared analysis slice — used by both modes. */
export function useFindings(): TimelineEvent[] {
  return useStore((s) => s.findings);
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

/** Open/close the per-finding solution drilldown (also drives timeline highlight). */
export function selectFinding(id: string | null) {
  useStore.getState().setSelectedFinding(id);
}

/**
 * Toggle a finding's drilldown open/closed and seek to its moment. Shared by the
 * timeline dots and the findings list so both behave identically. `onSeek` is
 * mode-specific: live jumps the transcript (setHighlightMs); replay seeks audio.
 */
export function selectAndSeek(event: TimelineEvent, onSeek: (ms: number) => void) {
  const { selectedFindingId, setSelectedFinding } = useStore.getState();
  setSelectedFinding(selectedFindingId === event.id ? null : event.id);
  onSeek(event.atMs);
}
