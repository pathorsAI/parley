import { useEffect } from "react";
import { useStore } from "../../lib/store";
import { isTauri } from "../../lib/tauriEvents";
import { runFindingSolution } from "../../lib/analysis/solution";
import {
  broadcastFindingSolution,
  listenForFindingSolutionRequests,
  openFindingSolutionWindow,
  type FindingSolutionState,
} from "../../lib/findingSolutionSync";

/** Derive the window's view (selected finding + its solution entry) from the store. */
function currentState(): FindingSolutionState {
  const s = useStore.getState();
  const finding = s.findings.find((f) => f.id === s.selectedFindingId) ?? null;
  const entry = finding ? s.findingSolutions[finding.id] ?? null : null;
  return { finding, entry };
}

/**
 * Main-window host for the standalone finding-solution ("how to reply") window
 * (Tauri only). The main window owns generation and is the source of truth; the
 * window is a pure view that requests state/generation over events. Selecting a
 * finding opens/focuses the window and kicks generation; clearing the selection
 * tells the window to show its placeholder. No-op in plain browser dev — there
 * the in-app overlay is rendered instead.
 */
export function useFindingSolutionHost() {
  const selectedFindingId = useStore((s) => s.selectedFindingId);
  // Re-broadcast when the selected finding's solution transitions (running → done).
  const entry = useStore((s) =>
    s.selectedFindingId ? s.findingSolutions[s.selectedFindingId] ?? null : null
  );

  // Answer the window's requests. Registered once.
  useEffect(() => {
    if (!isTauri()) return;
    const un = listenForFindingSolutionRequests({
      onHello: () => void broadcastFindingSolution(currentState()),
      onGenerate: (id) => void runFindingSolution(id),
      onClose: () => useStore.getState().setSelectedFinding(null),
    });
    return () => void un.then((fn) => fn());
  }, []);

  // On selection change: open/focus + kick generation, then push state. On clear,
  // the push tells the window to show its placeholder.
  useEffect(() => {
    if (!isTauri()) return;
    if (selectedFindingId) {
      void openFindingSolutionWindow();
      void runFindingSolution(selectedFindingId);
    }
    void broadcastFindingSolution(currentState());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFindingId]);

  // Keep the window in sync as the solution generates.
  useEffect(() => {
    if (!isTauri()) return;
    void broadcastFindingSolution(currentState());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry]);
}
