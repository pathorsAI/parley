import { useEffect, useRef } from "react";
import { useStore } from "../../lib/store";
import { hasProviderKey } from "../../lib/ai/settings";
import { runAnalysis } from "../../lib/analysis/engine";
import { runActionItems } from "../../lib/analysis/actionItems";
import { runDeliveryAnalysis } from "../../lib/analysis/deliveryRun";
import { runBriefGeneration } from "../../lib/analysis/briefRun";
import { runIntelExtraction } from "../../lib/intel/extract";
import { saveUploadToHistory } from "../../lib/history/history";
import { log } from "../../lib/log";

/**
 * The STUDY pipeline: ONE orchestrator for every model pass over a loaded
 * recording, mounted at the StudyScreen root so it runs no matter which page
 * (report / replay) the user lands on. Stages:
 *
 *   1. analysis (findings)          — once, when status is "idle"
 *   2. action items                 — chained off the finished analysis
 *   2b. delivery assessment         — chained off the analysis, ∥ to 2
 *   2c. brief (重點 debrief)         — after action items SETTLE, so the
 *                                     checklist it folds in is real
 *   2d. intel extraction            — whenever the recording's meeting type is
 *                                     typed and the current intel doesn't match
 *   3. auto-save fresh uploads      — after the pipeline settles
 *
 * Every stage is once-per-session (status guards + the runners' own busy
 * flags); restored entries load with their saved outputs as "done", so opening
 * a recording never re-spends a generation. Dragging the playhead never
 * re-runs anything. Manual re-runs (the player's Analyze menu, the brief's
 * Regenerate, the intel refresh) call the same runners directly.
 *
 * Persistence: findings/action items write back via initHistoryPersistSync (a
 * module-level store subscription, so navigating away can't cancel it); brief,
 * intel and a legacy entry's recomputed delivery write back via
 * persistStudyOutputs inside their runners.
 */
export function useReplayAnalysis(): void {
  const replayId = useStore((s) => s.replay?.id ?? null);
  const analysisStatus = useStore((s) => s.analysisStatus);
  const actionItemsStatus = useStore((s) => s.actionItemsStatus);
  const analysisGate = useStore((s) => s.analysisGate);
  const deliveryStatus = useStore((s) => s.deliveryStatus);
  const briefStatus = useStore((s) => s.briefStatus);
  const studyMeetingType = useStore((s) => s.studyMeetingType);
  const intelType = useStore((s) => s.intel?.meetingType ?? null);
  const intelStatus = useStore((s) => s.intelStatus);
  const analysisStartedFor = useRef<string | null>(null);
  const actionsStartedFor = useRef<string | null>(null);
  const deliveryStartedFor = useRef<string | null>(null);
  const intelStartedFor = useRef<string | null>(null);
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
    if (!hasProviderKey(settings, "deep")) return;
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

  // 2b) Chain the delivery assessment off the finished analysis too (independent
  //     of action items). Once per session. The assessment IS persisted in
  //     history — a loaded entry restores it with status "done" so this never
  //     fires; only a legacy entry (saved before the field existed) loads as
  //     "idle", recomputes once here, and is saved back by runDeliveryAnalysis.
  useEffect(() => {
    if (!replayId) {
      deliveryStartedFor.current = null;
      return;
    }
    if (analysisStatus !== "done") return;
    if (deliveryStatus !== "idle") return;
    if (deliveryStartedFor.current === replayId) return;

    const { settings, segments } = useStore.getState();
    if (!hasProviderKey(settings, "deep")) return;
    if (!segments.some((s) => s.isFinal && s.text.trim())) return;

    deliveryStartedFor.current = replayId;
    void runDeliveryAnalysis();
  }, [replayId, analysisStatus, deliveryStatus]);

  // 2c) Generate the brief once the action items SETTLE (done or error), so the
  //     checklist it folds in reflects this recording's real follow-ups. No
  //     started-ref: briefStatus is the guard ("idle" only fires once — the
  //     runner flips it to "running" synchronously, and error stays "error"
  //     until the user hits Regenerate). reanalyzeAll resets it to "idle" to
  //     regenerate against a fresh pass.
  useEffect(() => {
    if (!replayId) return;
    if (analysisStatus !== "done") return;
    if (actionItemsStatus !== "done" && actionItemsStatus !== "error") return;
    if (briefStatus !== "idle") return;
    void runBriefGeneration();
  }, [replayId, analysisStatus, actionItemsStatus, briefStatus]);

  // 2d) Intel: run whenever the recording's meeting type is typed and the
  //     current intel doesn't match it — independent of the findings pass (it
  //     only reads the transcript). Keyed per session+type so a failed run
  //     doesn't retry-loop (the intel section's refresh button re-runs it) but
  //     switching types extracts the new template.
  useEffect(() => {
    if (!replayId) {
      intelStartedFor.current = null;
      return;
    }
    if (studyMeetingType === "general") return;
    if (intelType === studyMeetingType) return;
    if (intelStatus === "running") return;
    const key = `${replayId}:${studyMeetingType}`;
    if (intelStartedFor.current === key) return;
    intelStartedFor.current = key;
    runIntelExtraction(studyMeetingType, "deep").catch((e) =>
      log.warn("study: intel run failed", { error: String(e) })
    );
  }, [replayId, studyMeetingType, intelType, intelStatus]);

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
    // Already persisted (the ingest wizard saved it transcript-only when analysis
    // was skipped/cancelled) — creating a second entry here would duplicate it.
    // A manual re-analysis overwrites the existing one via initHistoryPersistSync.
    if (useStore.getState().loadedHistoryId) {
      savedFor.current = replayId;
      return;
    }
    savedFor.current = replayId;
    // saveUploadToHistory marks the new entry as loaded BEFORE its slow compress,
    // so a re-analysis during that window overwrites it (initHistoryPersistSync)
    // instead of being lost or duplicated.
    void saveUploadToHistory(session).catch((e) =>
      log.error("history: upload save failed", { error: String(e) }),
    );
  }, [replayId, actionItemsStatus]);
}
