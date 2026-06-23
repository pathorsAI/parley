import { useEffect, useRef } from "react";
import { useStore } from "../../lib/store";
import { hasProviderKey } from "../../lib/ai/settings";
import { runAnalysis } from "../../lib/analysis/engine";
import { runActionItems } from "../../lib/analysis/actionItems";
import { saveUploadToHistory } from "../../lib/history/history";
import { log } from "../../lib/log";

/**
 * REPLAY lifecycle: run the whole-recording analysis ONCE when a session loads,
 * then auto-generate the post-meeting action items once that analysis finishes.
 * Both fire once per session (guarded by a per-session ref + the engines' own
 * module-level busy flags). Dragging the playhead never re-runs anything.
 */
export function useReplayAnalysis(): void {
  const replayId = useStore((s) => s.replay?.id ?? null);
  const analysisStatus = useStore((s) => s.analysisStatus);
  const actionItemsStatus = useStore((s) => s.actionItemsStatus);
  const analysisGate = useStore((s) => s.analysisGate);
  const analysisStartedFor = useRef<string | null>(null);
  const actionsStartedFor = useRef<string | null>(null);
  const savedFor = useRef<string | null>(null);

  // 1) Analyze the whole recording once — but only after the ingest wizard's
  //    review-confirm releases the gate (it arms "deferred" on open).
  useEffect(() => {
    if (!replayId) {
      analysisStartedFor.current = null;
      return;
    }
    if (analysisGate !== "open") return;
    if (analysisStatus !== "idle") return;
    if (analysisStartedFor.current === replayId) return;

    const { settings, segments } = useStore.getState();
    if (!hasProviderKey(settings)) return;
    if (!segments.some((s) => s.isFinal && s.text.trim())) return;

    analysisStartedFor.current = replayId;
    void runAnalysis({ mode: "replay" });
  }, [replayId, analysisStatus, analysisGate]);

  // 2) Chain action items off the finished analysis.
  useEffect(() => {
    if (!replayId) {
      actionsStartedFor.current = null;
      return;
    }
    if (analysisStatus !== "done") return;
    if (actionItemsStatus !== "idle") return;
    if (actionsStartedFor.current === replayId) return;

    actionsStartedFor.current = replayId;
    void runActionItems();
  }, [replayId, analysisStatus, actionItemsStatus]);

  // 3) Auto-save a freshly-analyzed UPLOAD to history once its analysis + action
  //    items settle. Gated on `actionsStartedFor` (set only when WE ran the
  //    pipeline this session) so a loaded-history entry — whose statuses are
  //    already "done" — never re-saves itself.
  useEffect(() => {
    if (!replayId) {
      savedFor.current = null;
      return;
    }
    if (actionsStartedFor.current !== replayId) return; // not a fresh upload pass
    if (actionItemsStatus !== "done" && actionItemsStatus !== "error") return;
    if (savedFor.current === replayId) return;

    const session = useStore.getState().replay;
    if (!session) return;
    savedFor.current = replayId;
    void saveUploadToHistory(session).catch((e) =>
      log.error("history: upload save failed", { error: String(e) }),
    );
  }, [replayId, actionItemsStatus]);
}
