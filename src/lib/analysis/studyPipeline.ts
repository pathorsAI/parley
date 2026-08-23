// The STUDY pipeline: ONE module owning every model pass over a loaded
// recording — what runs next (scheduler), what a manual "regenerate" means
// (invalidation), and what the UI should say about it (display derivation).
// The topology lives here and only here:
//
//   findings ──done──▶ action items ──settled──▶ brief
//        └────done──▶ delivery
//
// Scheduling is a plain store subscription (initStudyPipeline, mounted once in
// App — the same pattern as initHistoryPersistSync), not a React hook: the
// pipeline is a domain concern and must not depend on which screen is mounted.
// The store's per-artifact statuses are the ONLY state; each tick asks "which
// idle stages have their prerequisites met?" and dispatches them. The runners
// hold their own reentrancy locks (status set synchronously) and write-guards
// (runGuard: session pin + latest-wins), so double-dispatch is a no-op and a
// stale pass can't corrupt — there are no once-per-session refs, no busy
// flags, and no gate to leak.
//
// Both pure functions read the same StudyPipelineFacts value — plain
// primitives extracted from the store by factsOf() — so the scheduler and the
// UI can never disagree, and tests need no store or fixtures.

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore, hasSpokenSegment, type AsyncTaskStatus } from "../store";
import { hasProviderKey } from "../ai/settings";
import { runAnalysis } from "./engine";
import { runActionItems } from "./actionItems";
import { runBriefGeneration } from "./briefRun";
import { runDeliveryAnalysis } from "./deliveryRun";
import { persistStudyOutputs, saveUploadToHistory } from "../history/history";
import { log } from "../log";

type StoreState = ReturnType<typeof useStore.getState>;

export type StudyArtifactKey = "findings" | "actions" | "brief" | "delivery";

export type StudyArtifactDisplay = "idle" | "queued" | "running" | "done" | "error";

/** Everything the pipeline's decisions depend on, as plain values. */
export interface StudyPipelineFacts {
  inReplay: boolean;
  /** The ingest wizard owns the session until it closes (trim, diarization,
   *  speaker naming, the first analysis at Confirm) — the whole DAG defers
   *  while it's open so no pass spends on an unconfirmed transcript. */
  wizardOpen: boolean;
  hasDeepKey: boolean;
  /** Spoken content inside the keep-window — same predicate the runners guard on. */
  hasTranscript: boolean;
  analysisStatus: AsyncTaskStatus;
  actionItemsStatus: AsyncTaskStatus;
  briefStatus: AsyncTaskStatus;
  deliveryStatus: AsyncTaskStatus;
  /** May the pipeline spend on its own? `settings.autoStudyAnalysis` OR a manual
   *  regenerate pinned to THIS recording — folded into one fact here so the
   *  scheduler and the display derivation can't disagree, and so evaluateStages
   *  stays a pure function of plain values. Off leaves the recording unanalyzed
   *  for an external AI to own over MCP (see Settings.autoStudyAnalysis).
   *  NB: unrelated to the store's live-mode `autoAnalyze` re-analysis timer. */
  autoAnalyze: boolean;
}

export function factsOf(s: StoreState): StudyPipelineFacts {
  const trim = s.appMode === "study" ? s.replayTrim : null;
  const replayId = s.replay?.id ?? null;
  return {
    inReplay: s.appMode === "study" && s.replay != null,
    wizardOpen: s.ingestWizardOpen,
    hasDeepKey: hasProviderKey(s.settings, "deep"),
    hasTranscript: hasSpokenSegment(s.segments, trim),
    analysisStatus: s.analysisStatus,
    actionItemsStatus: s.actionItemsStatus,
    briefStatus: s.briefStatus,
    deliveryStatus: s.deliveryStatus,
    autoAnalyze:
      s.settings.autoStudyAnalysis ||
      (replayId != null && s.studyManualForId === replayId),
  };
}

function settled(status: AsyncTaskStatus): boolean {
  return status === "done" || status === "error";
}

/** Which stages should START now — the whole topology, in one place. */
export function evaluateStages(f: StudyPipelineFacts): StudyArtifactKey[] {
  if (!f.inReplay || !f.hasDeepKey || !f.hasTranscript) return [];
  if (f.wizardOpen) return [];
  // Auto-analysis off and no manual request for this recording: leave it
  // unanalyzed so an external AI can write the analysis back over MCP.
  if (!f.autoAnalyze) return [];

  const out: StudyArtifactKey[] = [];
  const analysisDone = f.analysisStatus === "done";
  if (f.analysisStatus === "idle") out.push("findings");
  if (analysisDone && f.actionItemsStatus === "idle") out.push("actions");
  if (analysisDone && f.deliveryStatus === "idle") out.push("delivery");
  // The brief folds the action items in, so it waits for them to SETTLE —
  // done or error — rather than only done (an empty checklist is still a brief).
  if (analysisDone && settled(f.actionItemsStatus) && f.briefStatus === "idle") out.push("brief");
  return out;
}

// Manual findings regeneration must bypass the content-keyed analysis cache
// (otherwise invalidation would just restore the identical cached result).
// One-shot, consumed by the findings runner on its next dispatch.
let forceNextFindings = false;

/** How each stage runs. A keyed table, so dispatch is data — not a switch. */
const RUNNERS: Record<StudyArtifactKey, () => Promise<unknown> | void> = {
  findings: () => {
    const force = forceNextFindings;
    forceNextFindings = false;
    return runAnalysis({ mode: "replay", force });
  },
  actions: () => runActionItems(),
  brief: () => runBriefGeneration(),
  delivery: () => runDeliveryAnalysis(),
};

const STATUS_FIELD = {
  findings: "analysisStatus",
  actions: "actionItemsStatus",
  brief: "briefStatus",
  delivery: "deliveryStatus",
} as const satisfies Record<StudyArtifactKey, keyof StoreState>;

/**
 * Manual regeneration = invalidation: reset the artifact's status to "idle"
 * and let the scheduler dispatch the re-run in dependency order. No-op while
 * that artifact streams (resetting mid-flight would fork a second pass; an
 * OLDER pass superseded this way is discarded by the runners' runGuard).
 *
 * Asking by hand also pins this recording as manually requested, so the button
 * still works when auto-analysis is off (otherwise the reset to "idle" would
 * just sit there — the scheduler would never dispatch it).
 */
export function regenerateArtifact(key: StudyArtifactKey): void {
  const s = useStore.getState();
  if (s[STATUS_FIELD[key]] === "running") return;
  if (key === "findings") forceNextFindings = true;
  useStore.setState({
    [STATUS_FIELD[key]]: "idle",
    studyManualForId: s.replay?.id ?? null,
  } as Partial<StoreState>);
}

/**
 * "Regenerate all": one fresh forced findings pass, then invalidate every
 * downstream output — the scheduler re-runs them against the new findings.
 * Downstream only invalidates if the analysis actually succeeded (a failed
 * pass must not wipe good outputs) and the same recording is still loaded
 * (pinned by replay id — loadedHistoryId is null for read-only/unsaved
 * sessions, so it can't tell two of those apart).
 */
export async function reanalyzeAll(): Promise<void> {
  const startedFor = useStore.getState().replay?.id ?? null;
  if (!startedFor) return;
  // Pin BEFORE the pass: with auto-analysis off, the downstream invalidation
  // below would otherwise never be picked up by the scheduler.
  useStore.setState({ studyManualForId: startedFor });
  await runAnalysis({ mode: "replay", force: true });
  const s = useStore.getState();
  if (s.analysisStatus !== "done") return;
  if ((s.replay?.id ?? null) !== startedFor) return;
  useStore.setState({
    actionItemsStatus: "idle",
    brief: null,
    briefStatus: "idle",
    deliveryStatus: "idle",
  });
}

// Fields the subscription reacts to — everything factsOf and the auto-save
// transition read. One list, so a new input can't be forgotten in the gate.
const WATCHED = [
  "appMode",
  "replay",
  "ingestWizardOpen",
  "segments",
  "settings",
  "replayTrim",
  "analysisStatus",
  "actionItemsStatus",
  "briefStatus",
  "deliveryStatus",
  "loadedHistoryId",
  "replayReadOnly",
  "studyManualForId",
] as const satisfies readonly (keyof StoreState)[];

function dispatchReady(state: StoreState): void {
  for (const key of evaluateStages(factsOf(state))) {
    Promise.resolve(RUNNERS[key]()).catch((e) =>
      log.error("study: stage failed", { stage: key, error: String(e) }),
    );
  }
}

/**
 * Mount the pipeline: subscribe to the store, dispatch ready stages, and
 * persist fresh outputs once a pass settles. Returns unsubscribe.
 */
export function initStudyPipeline(): () => void {
  // Catch up once on mount (a dev HMR remount mid-session, say) — dispatch is
  // idempotent, so this is free when nothing is pending.
  dispatchReady(useStore.getState());
  return useStore.subscribe((state, prev) => {
    // The pipeline is inert outside replay — skip the live screen's high-rate
    // transcript/prosody traffic outright, then the unrelated store changes.
    if (state.appMode !== "study" && prev.appMode !== "study") return;
    if (WATCHED.every((k) => state[k] === prev[k])) return;

    dispatchReady(state);

    // Persist when a fresh pass SETTLES (running → done/error is a transition
    // only a real run produces, so restored entries never re-save):
    //  - own unsaved upload   → save a history entry (actions settling marks
    //    the initial pipeline complete; later re-runs overwrite via
    //    initHistoryPersistSync on the then-loaded entry)
    //  - read-only org entry  → fold into the local study cache; findings
    //    have no runner-side persist hook, so their settle is caught here too
    //    (brief/delivery persist from their runners).
    const actionsSettled =
      prev.actionItemsStatus === "running" && settled(state.actionItemsStatus);
    const analysisDone =
      prev.analysisStatus === "running" && state.analysisStatus === "done";
    if (state.appMode !== "study" || !state.replay || state.loadedHistoryId) return;
    if (state.replayReadOnly) {
      if (actionsSettled || analysisDone) {
        persistStudyOutputs().catch((e) =>
          log.error("study: read-only cache persist failed", { error: String(e) }),
        );
      }
    } else if (actionsSettled) {
      saveUploadToHistory(state.replay).catch((e) =>
        log.error("study: auto-save failed", { error: String(e) }),
      );
    }
  });
}

// ── Display derivation ───────────────────────────────────────────────────────

export interface StudyArtifactState {
  key: StudyArtifactKey;
  display: StudyArtifactDisplay;
}

export interface StudyPipelineState {
  artifacts: StudyArtifactState[];
  /** Artifact count. */
  total: number;
  /** Artifacts already "done". */
  done: number;
  /** Failed artifacts. */
  errors: number;
  /** Anything queued or generating right now. */
  active: boolean;
  hasDeepKey: boolean;
  hasTranscript: boolean;
}

/** Queue rule shared by every stage chained off the findings pass (actions /
 *  brief / delivery): an "idle" status reads QUEUED while the findings pass is
 *  pending or succeeded and a run is possible — a failed analysis kills the
 *  chain. Used by deriveStudyPipeline AND the narrow per-section selectors, so
 *  they agree by construction. */
export function chainQueued(
  f: Pick<StudyPipelineFacts, "analysisStatus" | "hasDeepKey" | "hasTranscript" | "autoAnalyze">
): boolean {
  return f.autoAnalyze && f.analysisStatus !== "error" && f.hasDeepKey && f.hasTranscript;
}

/**
 * What the UI should SAY about each artifact — the store statuses plus a
 * synthetic "queued" for stages whose status is still "idle" only because an
 * upstream stage hasn't settled yet. Derived, never stored: the chip's promise
 * ("while anything is missing, every artifact is visibly either generating,
 * queued, or failed") falls out of the same facts the scheduler acts on.
 */
/** An untouched ("idle") artifact reads QUEUED while a run is still coming. */
function displayStatus(status: AsyncTaskStatus, queued: boolean): StudyArtifactDisplay {
  if (status === "idle") return queued ? "queued" : "idle";
  return status;
}

export function deriveStudyPipeline(f: StudyPipelineFacts): StudyPipelineState {
  // "queued" is a promise that the scheduler WILL dispatch. With auto-analysis
  // off nothing is coming, so every untouched artifact reads idle rather than
  // queuing forever against a pipeline that will never run.
  const can = f.autoAnalyze && f.hasDeepKey && f.hasTranscript;

  const findings = displayStatus(f.analysisStatus, can);

  const chained = (status: AsyncTaskStatus): StudyArtifactDisplay =>
    displayStatus(status, chainQueued(f));

  const artifacts: StudyArtifactState[] = [
    { key: "findings", display: findings },
    { key: "actions", display: chained(f.actionItemsStatus) },
    { key: "brief", display: chained(f.briefStatus) },
    { key: "delivery", display: chained(f.deliveryStatus) },
  ];

  return {
    artifacts,
    total: artifacts.length,
    done: artifacts.filter((a) => a.display === "done").length,
    errors: artifacts.filter((a) => a.display === "error").length,
    active: artifacts.some((a) => a.display === "queued" || a.display === "running"),
    hasDeepKey: f.hasDeepKey,
    hasTranscript: f.hasTranscript,
  };
}

/** Live view for the titlebar chip. useShallow keeps the facts reference
 *  stable across unrelated store changes (they're all primitives), so the
 *  derivation only re-runs when a fact actually changed. */
export function useStudyPipeline(): StudyPipelineState {
  const facts = useStore(useShallow(factsOf));
  return useMemo(() => deriveStudyPipeline(facts), [facts]);
}

/** BriefSection subscribes to just this boolean so unrelated pipeline
 *  transitions never re-render the (potentially large) brief markdown. */
export function useBriefQueued(): boolean {
  return useStore((s) => s.briefStatus === "idle" && chainQueued(factsOf(s)));
}
