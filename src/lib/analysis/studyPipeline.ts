// The STUDY pipeline: ONE module owning every model pass over a loaded
// recording — what runs next (scheduler), what a manual "regenerate" means
// (invalidation), and what the UI should say about it (display derivation).
// The topology lives here and only here:
//
//   findings ──done──▶ action items ──settled──▶ brief
//        └────done──▶ delivery                intel (per meeting type)
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
import { runIntelExtraction, intelTranscriptReady } from "../intel/extract";
import { persistStudyOutputs, saveUploadToHistory } from "../history/history";
import { log } from "../log";
import type { MeetingType } from "../types";

type StoreState = ReturnType<typeof useStore.getState>;

export type StudyArtifactKey = "findings" | "actions" | "brief" | "delivery" | "intel";

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
  /** Enough text for an intel extraction — same predicate its runner guards on. */
  intelExtractable: boolean;
  analysisStatus: AsyncTaskStatus;
  actionItemsStatus: AsyncTaskStatus;
  briefStatus: AsyncTaskStatus;
  deliveryStatus: AsyncTaskStatus;
  intelStatus: AsyncTaskStatus;
  studyMeetingType: MeetingType;
  /** Type of the intel board currently in the store, or null. */
  intelType: MeetingType | null;
}

export function factsOf(s: StoreState): StudyPipelineFacts {
  const trim = s.appMode === "replay" ? s.replayTrim : null;
  return {
    inReplay: s.appMode === "replay" && s.replay != null,
    wizardOpen: s.ingestWizardOpen,
    hasDeepKey: hasProviderKey(s.settings, "deep"),
    hasTranscript: hasSpokenSegment(s.segments, trim),
    intelExtractable: intelTranscriptReady(s.segments, trim),
    analysisStatus: s.analysisStatus,
    actionItemsStatus: s.actionItemsStatus,
    briefStatus: s.briefStatus,
    deliveryStatus: s.deliveryStatus,
    intelStatus: s.intelStatus,
    studyMeetingType: s.studyMeetingType,
    intelType: s.intel?.meetingType ?? null,
  };
}

function settled(status: AsyncTaskStatus): boolean {
  return status === "done" || status === "error";
}

/** Should the intel stage extract? "idle" always wants a run (a fresh pick, an
 *  invalidation, or a discarded stale pass); "done" only re-runs when the board
 *  on hand is for a different template than the one picked. */
function intelWanted(f: StudyPipelineFacts): boolean {
  if (f.studyMeetingType === "general" || !f.intelExtractable) return false;
  return (
    f.intelStatus === "idle" ||
    (f.intelStatus === "done" && f.intelType !== f.studyMeetingType)
  );
}

/** Which stages should START now — the whole topology, in one place. */
export function evaluateStages(f: StudyPipelineFacts): StudyArtifactKey[] {
  if (!f.inReplay || !f.hasDeepKey || !f.hasTranscript) return [];
  if (f.wizardOpen) return [];

  const out: StudyArtifactKey[] = [];
  const analysisDone = f.analysisStatus === "done";
  if (f.analysisStatus === "idle") out.push("findings");
  if (analysisDone && f.actionItemsStatus === "idle") out.push("actions");
  if (analysisDone && f.deliveryStatus === "idle") out.push("delivery");
  // The brief folds the action items in, so it waits for them to SETTLE —
  // done or error — rather than only done (an empty checklist is still a brief).
  if (analysisDone && settled(f.actionItemsStatus) && f.briefStatus === "idle") out.push("brief");
  // Intel is independent of the findings pass (it only reads the transcript).
  // A FAILED extraction blocks auto-retry until the user switches type (which
  // resets the status) or retries manually from the chip.
  if (intelWanted(f)) out.push("intel");
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
  intel: () => runIntelExtraction(useStore.getState().studyMeetingType, "deep"),
};

const STATUS_FIELD = {
  findings: "analysisStatus",
  actions: "actionItemsStatus",
  brief: "briefStatus",
  delivery: "deliveryStatus",
  intel: "intelStatus",
} as const satisfies Record<StudyArtifactKey, keyof StoreState>;

/**
 * Manual regeneration = invalidation: reset the artifact's status to "idle"
 * and let the scheduler dispatch the re-run in dependency order. No-op while
 * that artifact streams (resetting mid-flight would fork a second pass; an
 * OLDER pass superseded this way is discarded by the runners' runGuard).
 */
export function regenerateArtifact(key: StudyArtifactKey): void {
  const s = useStore.getState();
  if (s[STATUS_FIELD[key]] === "running") return;
  if (key === "findings") forceNextFindings = true;
  useStore.setState({ [STATUS_FIELD[key]]: "idle" } as Partial<StoreState>);
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
  await runAnalysis({ mode: "replay", force: true });
  const s = useStore.getState();
  if (s.analysisStatus !== "done") return;
  if ((s.replay?.id ?? null) !== startedFor) return;
  useStore.setState({
    actionItemsStatus: "idle",
    brief: null,
    briefStatus: "idle",
    deliveryStatus: "idle",
    intelStatus: "idle",
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
  "intelStatus",
  "intel",
  "studyMeetingType",
  "loadedHistoryId",
  "replayReadOnly",
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
    if (state.appMode !== "replay" && prev.appMode !== "replay") return;
    if (WATCHED.every((k) => state[k] === prev[k])) return;

    dispatchReady(state);

    // Persist when a fresh pass SETTLES (running → done/error is a transition
    // only a real run produces, so restored entries never re-save):
    //  - own unsaved upload   → save a history entry (actions settling marks
    //    the initial pipeline complete; later re-runs overwrite via
    //    initHistoryPersistSync on the then-loaded entry)
    //  - read-only org entry  → fold into the local study cache; findings
    //    have no runner-side persist hook, so their settle is caught here too
    //    (brief/intel/delivery persist from their runners).
    const actionsSettled =
      prev.actionItemsStatus === "running" && settled(state.actionItemsStatus);
    const analysisDone =
      prev.analysisStatus === "running" && state.analysisStatus === "done";
    if (state.appMode !== "replay" || !state.replay || state.loadedHistoryId) return;
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
  /** Counts toward the chip's n/total. Only intel opts out (no template picked
   *  or nothing to extract). */
  applicable: boolean;
}

export interface StudyPipelineState {
  artifacts: StudyArtifactState[];
  /** Applicable artifact count (4, or 5 with a typed intel template). */
  total: number;
  /** Applicable artifacts already "done". */
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
  f: Pick<StudyPipelineFacts, "analysisStatus" | "hasDeepKey" | "hasTranscript">
): boolean {
  return f.analysisStatus !== "error" && f.hasDeepKey && f.hasTranscript;
}

/**
 * What the UI should SAY about each artifact — the store statuses plus a
 * synthetic "queued" for stages whose status is still "idle" only because an
 * upstream stage hasn't settled yet. Derived, never stored: the chip's promise
 * ("while anything is missing, every artifact is visibly either generating,
 * queued, or failed") falls out of the same facts the scheduler acts on.
 */
export function deriveStudyPipeline(f: StudyPipelineFacts): StudyPipelineState {
  const can = f.hasDeepKey && f.hasTranscript;

  const findings: StudyArtifactDisplay =
    f.analysisStatus !== "idle" ? f.analysisStatus : can ? "queued" : "idle";

  const chained = (status: AsyncTaskStatus): StudyArtifactDisplay =>
    status !== "idle" ? status : chainQueued(f) ? "queued" : "idle";

  const intelApplicable = f.studyMeetingType !== "general" && f.intelExtractable;
  const intel: StudyArtifactDisplay =
    f.intelStatus !== "idle" ? f.intelStatus : intelApplicable && can ? "queued" : "idle";

  const artifacts: StudyArtifactState[] = [
    { key: "findings", display: findings, applicable: true },
    { key: "actions", display: chained(f.actionItemsStatus), applicable: true },
    { key: "brief", display: chained(f.briefStatus), applicable: true },
    { key: "delivery", display: chained(f.deliveryStatus), applicable: true },
    { key: "intel", display: intel, applicable: intelApplicable },
  ];

  const applicable = artifacts.filter((a) => a.applicable);
  return {
    artifacts,
    total: applicable.length,
    done: applicable.filter((a) => a.display === "done").length,
    errors: applicable.filter((a) => a.display === "error").length,
    active: applicable.some((a) => a.display === "queued" || a.display === "running"),
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
