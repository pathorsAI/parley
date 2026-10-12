// The STUDY pipeline: ONE module owning every model pass over a loaded
// recording — what runs next (scheduler), what a manual "regenerate" means
// (invalidation), and what the UI should say about it (display derivation).
// The topology lives here and only here:
//
//   findings ──done──▶ action items ──settled──▶ brief
//        └────done──▶ delivery
//   filing   (no upstream — the transcript alone is its input)
//
// Scheduling is a plain store subscription (initStudyPipeline, mounted once in
// App — the same pattern as initHistoryPersistSync), not a React hook: the
// pipeline is a domain concern and must not depend on which screen is mounted.
// The store's per-artifact statuses are the ONLY state; each tick asks "which
// idle stages have their prerequisites met?" and dispatches them. The runners
// hold their own reentrancy locks (status set synchronously) and write-guards
// (runGuard: session pin + latest-wins), so double-dispatch is a no-op and a
// stale pass can't corrupt — there are no once-per-session refs, no busy
// flags, and no gate to leak. A pass that outlives its recording being on
// screen still lands its result on that recording's entry, and reopening the
// recording mid-pass restores the stage as "running" (runRegistry) instead of
// dispatching it a second time.
//
// Both pure functions read the same StudyPipelineFacts value — plain
// primitives extracted from the store by factsOf() — so the scheduler and the
// UI can never disagree, and tests need no store or fixtures.

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore, hasSpokenSegment, type AsyncTaskStatus } from "../store";
import { hasProviderKey } from "../ai/settings";
import { cancelAnalysis, runAnalysis } from "./engine";
import { cancelActionItems, runActionItems } from "./actionItems";
import { cancelBriefGeneration, runBriefGeneration } from "./briefRun";
import { cancelDeliveryAnalysis, runDeliveryAnalysis } from "./deliveryRun";
import { cancelFilingSuggestion, runFilingSuggestion } from "./filingRun";
import { persistReadOnlyStudyOutputs, saveUploadToHistory } from "../history/history";
import { isSampleEntry } from "../onboarding/sample";
import { log } from "../log";

type StoreState = ReturnType<typeof useStore.getState>;

export type StudyArtifactKey = "findings" | "actions" | "brief" | "delivery";

/**
 * Everything the SCHEDULER dispatches — the four report artifacts plus the
 * stages that aren't ones. A stage is a model pass this module starts; an
 * artifact is a piece of the report the titlebar chip counts. Filing is the
 * first stage that is one but not the other: it proposes a title and a folder,
 * which is a prompt to the user rather than a section of the report, so it must
 * not move the chip's "3 of 4 ready". Keeping the two key types distinct means
 * the distinction is checked by the compiler instead of by a filter someone has
 * to remember to write.
 */
export type StudyStageKey = StudyArtifactKey | "filing";

export type StudyArtifactDisplay = "idle" | "queued" | "running" | "done" | "error";

/** Everything the pipeline's decisions depend on, as plain values. */
export interface StudyPipelineFacts {
  inReplay: boolean;
  /** The ingest wizard owns the session until it closes (trim, diarization,
   *  speaker naming, the first analysis at Confirm) — the whole DAG defers
   *  while it's open so no pass spends on an unconfirmed transcript. */
  wizardOpen: boolean;
  /** The loaded recording is a just-saved live meeting whose voice
   *  re-diarization is still running (store.postSaveDiarizingId). Its speaker
   *  labels are about to change, so the deep-lane stages — which read who said
   *  what — wait for the corrected transcript instead of analysing the
   *  provider's drifted labels and then re-running. Filing reads only the text,
   *  so it is not held. The artifacts still read "queued" meanwhile: a run IS
   *  coming, it is only waiting for its input. */
  diarizing: boolean;
  hasDeepKey: boolean;
  /** The cheap lane. Only the filing pass rides it, which is why it can run for a
   *  user who has no deep-lane key at all. */
  hasRealtimeKey: boolean;
  /** A read-only org recording can be neither renamed nor refiled — nothing for
   *  the filing pass to act on. */
  readOnly: boolean;
  /** Spoken content inside the keep-window — same predicate the runners guard on. */
  hasTranscript: boolean;
  analysisStatus: AsyncTaskStatus;
  actionItemsStatus: AsyncTaskStatus;
  briefStatus: AsyncTaskStatus;
  deliveryStatus: AsyncTaskStatus;
  filingStatus: AsyncTaskStatus;
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
    diarizing: replayId != null && s.postSaveDiarizingId === replayId,
    hasDeepKey: hasProviderKey(s.settings, "deep"),
    hasRealtimeKey: hasProviderKey(s.settings, "realtime"),
    readOnly: s.replayReadOnly,
    hasTranscript: hasSpokenSegment(s.segments, trim),
    analysisStatus: s.analysisStatus,
    actionItemsStatus: s.actionItemsStatus,
    briefStatus: s.briefStatus,
    deliveryStatus: s.deliveryStatus,
    filingStatus: s.filingStatus,
    // The bundled sample ships its analysis prewritten (onboarding/sample.ts),
    // and a model reading its synthetic voices would only overwrite that with
    // worse — so auto-analysis never touches it. A manual regenerate still can.
    autoAnalyze:
      (s.settings.autoStudyAnalysis && !(replayId != null && isSampleEntry({ id: replayId }))) ||
      (replayId != null && s.studyManualForId === replayId),
  };
}

function settled(status: AsyncTaskStatus): boolean {
  return status === "done" || status === "error";
}

/** Which stages should START now — the whole topology, in one place. */
export function evaluateStages(f: StudyPipelineFacts): StudyStageKey[] {
  // Being in replay, having a transcript, the wizard being shut and auto-analysis
  // being allowed gate EVERY stage. The deep-lane key does not: it only gates the
  // four report artifacts, since filing rides the cheap realtime lane.
  if (!f.inReplay || !f.hasTranscript) return [];
  if (f.wizardOpen) return [];
  // Auto-analysis off and no manual request for this recording: leave it
  // unanalyzed so an external AI can write the analysis back over MCP.
  if (!f.autoAnalyze) return [];

  const out: StudyStageKey[] = [];
  // Filing has NO upstream dependency — it reads the transcript alone, so it
  // goes out in the same tick as the findings pass rather than queueing behind
  // the expensive one. That IS the point: the suggested title and folder should
  // land the moment the transcript does, while the user is still looking at the
  // recording. It is also the one stage a realtime-only user ever gets.
  if (!f.readOnly && f.hasRealtimeKey && f.filingStatus === "idle") out.push("filing");

  if (!f.hasDeepKey) return out;
  // Speaker correction still running: every deep stage reads speaker labels
  // (findings attribute lines, the brief names people), so they all wait for
  // the corrected transcript. Clearing the flag is a WATCHED change, so the
  // pipeline dispatches the moment it does — once, on the corrected labels.
  if (f.diarizing) return out;
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
const RUNNERS: Record<StudyStageKey, () => Promise<unknown> | void> = {
  findings: () => {
    const force = forceNextFindings;
    forceNextFindings = false;
    return runAnalysis({ mode: "replay", force });
  },
  actions: () => runActionItems(),
  brief: () => runBriefGeneration(),
  delivery: () => runDeliveryAnalysis(),
  filing: () => runFilingSuggestion(),
};

/** How a RUNNING stage is stopped before a manual restart (runGuard.cancel). */
const CANCELLERS: Record<StudyStageKey, () => boolean> = {
  findings: cancelAnalysis,
  actions: cancelActionItems,
  brief: cancelBriefGeneration,
  delivery: cancelDeliveryAnalysis,
  filing: cancelFilingSuggestion,
};

const STATUS_FIELD = {
  findings: "analysisStatus",
  actions: "actionItemsStatus",
  brief: "briefStatus",
  delivery: "deliveryStatus",
  filing: "filingStatus",
} as const satisfies Record<StudyStageKey, keyof StoreState>;

/**
 * Stop a stage that reads "running" so it can be restarted: cancel its run
 * (aborting the model call; whatever it still produces is dropped) and return.
 * The caller resets the status. Also covers a "running" with no live run
 * behind it — nothing to cancel, and the reset alone unsticks it.
 */
function cancelRunning(key: StudyStageKey): void {
  const cancelled = CANCELLERS[key]();
  log.info("study: restarting a running stage", { stage: key, cancelled });
}

/**
 * Manual regeneration = invalidation: reset the artifact's status to "idle"
 * and let the scheduler dispatch the re-run in dependency order.
 *
 * A stage that is still RUNNING is cancelled first and then restarted the same
 * way — that is how a pass whose model call hung gets unstuck. The cancel and
 * the reset happen in one synchronous step, so the runner's own lock (its
 * status) sees "idle" exactly once and the scheduler starts exactly one new
 * pass; the cancelled one is superseded and discarded by runGuard.
 *
 * Asking by hand also pins this recording as manually requested, so the button
 * still works when auto-analysis is off (otherwise the reset to "idle" would
 * just sit there — the scheduler would never dispatch it).
 */
export function regenerateArtifact(key: StudyStageKey): void {
  const s = useStore.getState();
  if (s[STATUS_FIELD[key]] === "running") cancelRunning(key);
  if (key === "findings") forceNextFindings = true;
  useStore.setState({
    [STATUS_FIELD[key]]: "idle",
    studyManualForId: s.replay?.id ?? null,
  } as Partial<StoreState>);
}

/** The stages "regenerate all" invalidates once the fresh findings land. */
const DOWNSTREAM = ["actions", "brief", "delivery"] as const satisfies readonly StudyStageKey[];

/** Resolves once the findings pass is no longer running (immediately if it isn't). */
function findingsSettled(): Promise<void> {
  return new Promise((resolve) => {
    if (useStore.getState().analysisStatus !== "running") {
      resolve();
      return;
    }
    const unsubscribe = useStore.subscribe((s) => {
      if (s.analysisStatus === "running") return;
      unsubscribe();
      resolve();
    });
  });
}

/**
 * "Regenerate all": one fresh forced findings pass, then invalidate every
 * downstream output — the scheduler re-runs them against the new findings.
 * Downstream only invalidates if the analysis actually succeeded (a failed
 * pass must not wipe good outputs) and the same recording is still loaded
 * (pinned by replay id — loadedHistoryId is null for read-only/unsaved
 * sessions, so it can't tell two of those apart).
 *
 * A findings pass that is still running (hung, typically) is cancelled and
 * replaced. Resetting its status to "idle" lets the scheduler start the
 * replacement in the same tick — forced, via forceNextFindings — in which case
 * the direct call below is a no-op and this waits for THAT pass to settle.
 */
export async function reanalyzeAll(): Promise<void> {
  const startedFor = useStore.getState().replay?.id ?? null;
  if (!startedFor) {
    log.warn("study: regenerate all ignored — no recording loaded");
    return;
  }
  // This one calls the findings runner directly instead of going through the
  // scheduler, so it has to honour the speaker-correction hold itself.
  if (factsOf(useStore.getState()).diarizing) {
    log.info("study: regenerate all deferred — speakers are still being corrected");
    return;
  }
  // Pin BEFORE the pass: with auto-analysis off, the downstream invalidation
  // below would otherwise never be picked up by the scheduler.
  useStore.setState({ studyManualForId: startedFor });
  if (useStore.getState().analysisStatus === "running") {
    cancelRunning("findings");
    forceNextFindings = true;
    useStore.setState({ analysisStatus: "idle" });
    // Not consumed when the scheduler did not dispatch (auto-analysis off, no
    // key…): the direct call below is forced anyway.
    forceNextFindings = false;
  }
  await runAnalysis({ mode: "replay", force: true });
  await findingsSettled();
  const s = useStore.getState();
  if ((s.replay?.id ?? null) !== startedFor) {
    log.info("study: regenerate all — recording changed before findings settled");
    return;
  }
  if (s.analysisStatus !== "done") {
    log.warn("study: regenerate all stopped — findings did not complete", { status: s.analysisStatus });
    return;
  }
  // Downstream runs still in flight were started against the OLD findings.
  // Cancel them in the same synchronous step as the reset: one that is not
  // superseded by a replacement (the new brief waits for new action items)
  // would otherwise land "done" with stale output, persist it, and keep the
  // scheduler from ever dispatching the fresh pass.
  for (const key of DOWNSTREAM) {
    if (CANCELLERS[key]()) log.info("study: regenerate all cancelled a running stage", { stage: key });
  }
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
  "filingStatus",
  "loadedHistoryId",
  "replayReadOnly",
  "studyManualForId",
  "postSaveDiarizingId",
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
        persistReadOnlyStudyOutputs().catch((e) =>
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
  /** Speaker correction is running for this recording (see the fact). The chip
   *  says so instead of a queued count, and manual regeneration waits. */
  diarizing: boolean;
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

const ARTIFACT_STATUS = {
  findings: "analysisStatus",
  actions: "actionItemsStatus",
  brief: "briefStatus",
  delivery: "deliveryStatus",
} as const satisfies Record<StudyArtifactKey, keyof StudyPipelineFacts>;

const ARTIFACT_ORDER: readonly StudyArtifactKey[] = ["findings", "actions", "brief", "delivery"];

/** One artifact's display state. The chip (deriveStudyPipeline) and the report
 *  sections (useStudyArtifactDisplay) both go through here, so a section's
 *  skeleton and the chip's "queued" can't disagree. */
export function artifactDisplay(f: StudyPipelineFacts, key: StudyArtifactKey): StudyArtifactDisplay {
  const status = f[ARTIFACT_STATUS[key]];
  if (key === "findings") {
    // "queued" is a promise that the scheduler WILL dispatch. With auto-analysis
    // off nothing is coming, so every untouched artifact reads idle rather than
    // queuing forever against a pipeline that will never run.
    return displayStatus(status, f.autoAnalyze && f.hasDeepKey && f.hasTranscript);
  }
  return displayStatus(status, chainQueued(f));
}

export function deriveStudyPipeline(f: StudyPipelineFacts): StudyPipelineState {
  const artifacts: StudyArtifactState[] = ARTIFACT_ORDER.map((key) => ({
    key,
    display: artifactDisplay(f, key),
  }));

  return {
    artifacts,
    total: artifacts.length,
    done: artifacts.filter((a) => a.display === "done").length,
    errors: artifacts.filter((a) => a.display === "error").length,
    active: artifacts.some((a) => a.display === "queued" || a.display === "running"),
    hasDeepKey: f.hasDeepKey,
    hasTranscript: f.hasTranscript,
    diarizing: f.diarizing,
  };
}

/** Live view for the titlebar chip. useShallow keeps the facts reference
 *  stable across unrelated store changes (they're all primitives), so the
 *  derivation only re-runs when a fact actually changed. */
export function useStudyPipeline(): StudyPipelineState {
  const facts = useStore(useShallow(factsOf));
  return useMemo(() => deriveStudyPipeline(facts), [facts]);
}

/** One report section's display state, as a primitive — so a section only
 *  re-renders when ITS state changes, never on unrelated pipeline transitions.
 *  Only an idle status needs the full facts (to tell queued from idle); every
 *  other status is its own answer, which keeps the selector cheap. Mount it in
 *  study-only components: outside the study tense "queued" means nothing. */
export function useStudyArtifactDisplay(key: StudyArtifactKey): StudyArtifactDisplay {
  return useStore((s) => {
    const status = s[ARTIFACT_STATUS[key]];
    return status === "idle" ? artifactDisplay(factsOf(s), key) : status;
  });
}

/** BriefSection subscribes to just this boolean so unrelated pipeline
 *  transitions never re-render the (potentially large) brief markdown. */
export function useBriefQueued(): boolean {
  return useStudyArtifactDisplay("brief") === "queued";
}
