// Every analysis/study output of the loaded recording (or the live meeting):
// findings and their selection, action items, the delivery assessment, the
// brief, the filing suggestion, the meeting kind — and the statuses that gate
// the study pipeline.

import type {
  ActionItem,
  DeliveryAssessment,
  FilingSuggestion,
  FindingSolutionEntry,
  MeetingKind,
  TimelineEvent,
} from "../types";
import type { HistoryEntry } from "../history/types";
import type { StudyStage } from "../analysis/runRegistry";
import type { AsyncTaskStatus, ParleyState, SliceCreator } from "./types";

/** The status field of each study stage. */
export type StudyStatusField =
  | "analysisStatus"
  | "actionItemsStatus"
  | "deliveryStatus"
  | "briefStatus"
  | "filingStatus";

export interface StudySlice {
  // ── Unified analysis (shared by LIVE + REPLAY) ──────────────────────────────
  /**
   * Time-anchored findings from an analysis pass (eval-matched or AI "extra").
   * The timeline + findings list render these in both modes. LIVE re-analysis
   * REPLACES the whole list (and clears selection + solutions); REPLAY runs once.
   */
  findings: TimelineEvent[];
  analysisStatus: AsyncTaskStatus;
  analysisError: string | null;
  /** Signature of the eval set the current `findings` reflect (set by runAnalysis).
   *  When it differs from the active eval set, the findings are stale → re-analyze. */
  analyzedEvalSig: string;
  setAnalyzedEvalSig: (sig: string) => void;
  /** Replay id the user last asked to analyze BY HAND (regenerate / re-analyze
   *  all). It overrides `settings.autoStudyAnalysis` being off for that one
   *  recording, so a manual re-run still fans out through the pipeline. Pinned
   *  by id rather than cleared: loading another recording changes the id, so a
   *  stale pin can never re-enable the pipeline for a recording nobody asked
   *  about — no reset path has to remember it. */
  studyManualForId: string | null;
  setStudyManualForId: (id: string | null) => void;
  /** Reset one stage to "idle" and pin the recording as manually requested, in
   *  ONE update — the runner's lock sees "idle" exactly once, so the scheduler
   *  starts exactly one new pass (see studyPipeline.regenerateArtifact). */
  restartStudyStage: (field: StudyStatusField, manualForId: string | null) => void;
  /** "Regenerate all"'s downstream invalidation: action items, brief and
   *  delivery back to idle (the brief text cleared) in one update. */
  invalidateDownstreamStudy: () => void;
  /** The saved entry whose post-save voice re-diarization is still running
   *  (history.saveLiveToHistory opens the report BEFORE that pass finishes).
   *  While it matches the loaded recording, the study pipeline holds every
   *  deep-lane stage so no model reads the provider's drifted speaker labels
   *  and then has to re-run. Deliberately NOT in CLEARED_STUDY_SLICE: leaving
   *  the recording and coming back mid-pass must find the gate still shut. */
  postSaveDiarizingId: string | null;
  setPostSaveDiarizingId: (id: string | null) => void;
  setFindings: (events: TimelineEvent[]) => void;
  /** Which study-tense page is open while a recording is loaded: the merged
   *  meeting report (read the outcome) or the replay workbench (check the
   *  evidence). */
  studyTab: "report" | "replay";
  setStudyTab: (tab: StudySlice["studyTab"]) => void;
  /** The study brief (重點 debrief markdown) for the loaded recording. Lives in
   *  the store (not component state) so tab switches don't lose it, and is
   *  persisted onto the loaded entry so reopening never regenerates it. */
  brief: string | null;
  briefStatus: AsyncTaskStatus;
  /** Why the last brief pass failed (this session only — a failure restored
   *  from disk has no message). Shown by the generation chip. */
  briefError: string | null;
  setBrief: (brief: string | null) => void;
  setBriefError: (error: string | null) => void;
  /** What kind of meeting the loaded recording is — detected once by the
   *  analysis pass and overridable from the report page. It picks the analysis
   *  LENS (what the findings and brief look like), so changing it invalidates
   *  every derived output. `null` = not yet classified; readers fall back to the
   *  decision lens. See lib/analysis/lens.ts. */
  meetingKind: MeetingKind | null;
  setMeetingKind: (kind: MeetingKind | null) => void;
  /** Append a streamed chunk to the brief (streaming render). */
  appendBrief: (chunk: string) => void;
  setBriefStatus: (status: AsyncTaskStatus) => void;
  /** The pending filing suggestion for the LOADED recording — a better title and
   *  the folders it could move to. Per-recording, like the brief: it is cleared
   *  with the rest of the study slice and restored from the entry on load. `null`
   *  means nothing is pending, which covers both "never generated" and "the user
   *  already accepted or dismissed it" — `filingStatus` is what tells those apart
   *  (see HistoryEntry.filingSuggested). */
  filingSuggestion: FilingSuggestion | null;
  filingStatus: AsyncTaskStatus;
  setFilingSuggestion: (suggestion: FilingSuggestion | null) => void;
  setFilingStatus: (status: AsyncTaskStatus) => void;
  /** Insert one finding (MCP/external add) without replacing the list, keeping it
   *  ordered by atMs. A colliding id is reassigned so existing findings are safe. */
  addFinding: (event: TimelineEvent) => void;
  /** Patch a single finding by id (MCP/external edit). The id stays fixed. */
  updateFinding: (id: string, patch: Partial<TimelineEvent>) => void;
  /** Delete a single finding by id (MCP/external edit), clearing any selection
   *  or cached solution that pointed at it. */
  removeFinding: (id: string) => void;
  setAnalysisStatus: (status: AsyncTaskStatus) => void;
  setAnalysisError: (error: string | null) => void;
  /** Drop findings + action items outside the replay keep-window. Applied when a
   *  trim is committed — clears over-time results without re-running the analysis. */
  dropFindingsOutsideTrim: () => void;

  /** The finding highlighted + seeked by clicking a timeline dot or list row.
   *  Selection alone does NOT open the reply window or spend a generation. */
  selectedFindingId: string | null;
  setSelectedFinding: (id: string | null) => void;

  /** The finding whose standalone "how to reply" window is open — set only by the
   *  explicit "how to reply" action, kept separate from `selectedFindingId` so a
   *  plain click never opens the window or triggers a solution generation. */
  solutionFindingId: string | null;
  setSolutionFinding: (id: string | null) => void;

  /** Lazy per-finding solution cache, keyed by TimelineEvent.id. */
  findingSolutions: Record<string, FindingSolutionEntry>;
  setFindingSolution: (id: string, patch: Partial<FindingSolutionEntry>) => void;

  /** The current delivery assessment (tone + filler frequency). LIVE updates it
   *  on a rolling cadence; REPLAY computes it once over the whole recording. */
  deliveryAssessment: DeliveryAssessment | null;
  /** Mainly for REPLAY: drives the post-call delivery section's spinner. */
  deliveryStatus: AsyncTaskStatus;
  /** Why the last REPLAY delivery pass failed, for the generation chip. */
  deliveryError: string | null;
  setDeliveryAssessment: (a: DeliveryAssessment | null) => void;
  setDeliveryStatus: (s: AsyncTaskStatus) => void;
  setDeliveryError: (error: string | null) => void;

  // ── Action items (REPLAY post-meeting follow-ups) ───────────────────────────
  /** Generated from the analysis findings + transcript; ephemeral, replay-only. */
  actionItems: ActionItem[];
  actionItemsStatus: AsyncTaskStatus;
  actionItemsError: string | null;
  setActionItems: (items: ActionItem[]) => void;
  setActionItemsStatus: (status: AsyncTaskStatus) => void;
  setActionItemsError: (error: string | null) => void;
  toggleActionItem: (id: string) => void;
}

/**
 * Every analysis/study output slice, cleared as ONE unit. enterReplay,
 * loadHistory (as the base under its restores), exitReplay and startMeeting all
 * reset the same fields — defining the list once means a new output field can
 * never be forgotten on one of the four paths (parallel hand-maintained reset
 * lists are exactly how the old analysis-gate leak happened).
 */
export const CLEARED_STUDY_SLICE: Pick<
  ParleyState,
  | "findings"
  | "analysisStatus"
  | "analysisError"
  | "analyzedEvalSig"
  | "selectedFindingId"
  | "solutionFindingId"
  | "findingSolutions"
  | "actionItems"
  | "actionItemsStatus"
  | "actionItemsError"
  | "deliveryAssessment"
  | "deliveryStatus"
  | "deliveryError"
  | "brief"
  | "briefStatus"
  | "briefError"
  | "filingSuggestion"
  | "filingStatus"
  | "meetingKind"
> = {
  findings: [],
  analysisStatus: "idle",
  analysisError: null,
  analyzedEvalSig: "",
  selectedFindingId: null,
  solutionFindingId: null,
  findingSolutions: {},
  actionItems: [],
  actionItemsStatus: "idle",
  actionItemsError: null,
  deliveryAssessment: null,
  deliveryStatus: "idle",
  deliveryError: null,
  brief: null,
  briefStatus: "idle",
  briefError: null,
  filingSuggestion: null,
  filingStatus: "idle",
  meetingKind: null,
};

/**
 * The study statuses a saved entry restores to. Pure + exported for testing.
 *
 * Present output → "done": the pipeline only starts "idle" stages, so loading a
 * saved entry never re-spends a generation. Absent (transcript-only save, an
 * entry predating the field, a pass the user left before it finished) → "idle",
 * generated once on open and written back.
 *
 *  - findings and action items are decided SEPARATELY. The saved `analyzed`
 *    flag (both completed) marks even a genuinely EMPTY result as done; without
 *    it, each falls back to its own content. A stage's result is now saved the
 *    moment it lands, so an entry can hold findings but no action items yet —
 *    it must still get its action items rather than read as complete.
 *  - a brief that FAILED last time (and none saved since) restores as "error",
 *    not "idle": the user sees it and retries by hand instead of it silently
 *    re-running on every open.
 *  - a stage still IN FLIGHT for this recording (the user left and came back
 *    mid-pass) restores as "running", so the scheduler doesn't dispatch a
 *    duplicate — the original pass resumes writing into the store.
 */
export function restoredStudyStatuses(
  entry: Pick<
    HistoryEntry,
    | "analyzed"
    | "findings"
    | "actionItems"
    | "deliveryAssessment"
    | "brief"
    | "briefFailed"
    | "filingSuggested"
    | "filingSuggestion"
  >,
  inFlight: ReadonlySet<StudyStage> = new Set(),
): Pick<ParleyState, StudyStatusField> {
  const pick = (stage: StudyStage, done: boolean, failed = false): AsyncTaskStatus => {
    if (inFlight.has(stage)) return "running";
    if (done) return "done";
    return failed ? "error" : "idle";
  };
  return {
    analysisStatus: pick("findings", !!entry.analyzed || entry.findings.length > 0),
    actionItemsStatus: pick("actions", !!entry.analyzed || entry.actionItems.length > 0),
    deliveryStatus: pick("delivery", !!entry.deliveryAssessment),
    briefStatus: pick("brief", !!entry.brief, !!entry.briefFailed),
    filingStatus: pick("filing", !!entry.filingSuggested || !!entry.filingSuggestion),
  };
}

export const createStudySlice: SliceCreator<StudySlice> = (set) => ({
  ...CLEARED_STUDY_SLICE,
  studyManualForId: null,
  postSaveDiarizingId: null,
  studyTab: "report",

  setAnalyzedEvalSig: (analyzedEvalSig) => set({ analyzedEvalSig }),
  setStudyManualForId: (studyManualForId) => set({ studyManualForId }),
  restartStudyStage: (field, studyManualForId) =>
    set({ [field]: "idle", studyManualForId } as Partial<ParleyState>),
  invalidateDownstreamStudy: () =>
    set({
      actionItemsStatus: "idle",
      brief: null,
      briefStatus: "idle",
      deliveryStatus: "idle",
    }),
  setPostSaveDiarizingId: (postSaveDiarizingId) => set({ postSaveDiarizingId }),

  setStudyTab: (tab) => set({ studyTab: tab }),
  setBrief: (brief) => set({ brief }),
  setBriefError: (briefError) => set({ briefError }),
  setMeetingKind: (meetingKind) => set({ meetingKind }),
  appendBrief: (chunk) => set((s) => ({ brief: (s.brief ?? "") + chunk })),
  setBriefStatus: (status) => set({ briefStatus: status }),
  setFilingSuggestion: (filingSuggestion) => set({ filingSuggestion }),
  setFilingStatus: (filingStatus) => set({ filingStatus }),
  // Replace the findings list, keeping the selection + cached solutions of any
  // finding that STILL EXISTS in the new list. During streaming, partials commit
  // a growing list with stable ids, so a finding the user opened mid-stream (and
  // its in-flight "how to reply" solution) survives the next partial. A fresh
  // analysis pass mints new ids, so nothing matches → selection + solutions clear.
  setFindings: (events) =>
    set((s) => {
      const ids = new Set(events.map((e) => e.id));
      const keepSel = !!s.selectedFindingId && ids.has(s.selectedFindingId);
      const keepSol = !!s.solutionFindingId && ids.has(s.solutionFindingId);
      const findingSolutions = Object.fromEntries(
        Object.entries(s.findingSolutions).filter(([id]) => ids.has(id))
      );
      return {
        findings: events,
        selectedFindingId: keepSel ? s.selectedFindingId : null,
        solutionFindingId: keepSol ? s.solutionFindingId : null,
        findingSolutions,
      };
    }),

  addFinding: (event) =>
    set((s) => {
      // Never clobber an existing finding's id (it keys selection + solutions).
      const id = s.findings.some((f) => f.id === event.id) ? crypto.randomUUID() : event.id;
      // Re-sort by atMs to preserve the chronological invariant the analysis
      // pipeline establishes (timeline.ts) and the findings list renders in.
      return {
        findings: [...s.findings, { ...event, id }].sort((a, b) => a.atMs - b.atMs),
      };
    }),

  updateFinding: (id, patch) =>
    set((s) => ({
      // Spread patch first, then pin id back so an external edit can never
      // rewrite the id (which keys selection + the solution cache).
      findings: s.findings.map((f) => (f.id === id ? { ...f, ...patch, id: f.id } : f)),
    })),

  removeFinding: (id) =>
    set((s) => ({
      findings: s.findings.filter((f) => f.id !== id),
      selectedFindingId: s.selectedFindingId === id ? null : s.selectedFindingId,
      solutionFindingId: s.solutionFindingId === id ? null : s.solutionFindingId,
      findingSolutions: Object.fromEntries(
        Object.entries(s.findingSolutions).filter(([k]) => k !== id),
      ),
    })),

  dropFindingsOutsideTrim: () =>
    set((s) => {
      const trim = s.replayTrim;
      if (!trim) return {}; // no trim → nothing to clear
      const inWin = (atMs: number) => atMs >= trim.startMs && atMs <= trim.endMs;
      const keepSel = s.findings.some((f) => f.id === s.selectedFindingId && inWin(f.atMs));
      const keepSol = s.findings.some((f) => f.id === s.solutionFindingId && inWin(f.atMs));
      return {
        findings: s.findings.filter((f) => inWin(f.atMs)),
        actionItems: s.actionItems.filter((a) => a.atMs == null || inWin(a.atMs)),
        selectedFindingId: keepSel ? s.selectedFindingId : null,
        solutionFindingId: keepSol ? s.solutionFindingId : null,
      };
    }),
  setAnalysisStatus: (status) => set({ analysisStatus: status }),
  setAnalysisError: (error) => set({ analysisError: error }),
  setSelectedFinding: (id) => set({ selectedFindingId: id }),
  setSolutionFinding: (id) => set({ solutionFindingId: id }),
  setFindingSolution: (id, patch) =>
    set((state) => {
      const prev = state.findingSolutions[id] ?? { status: "idle", solution: null, error: null };
      return { findingSolutions: { ...state.findingSolutions, [id]: { ...prev, ...patch } } };
    }),

  setDeliveryAssessment: (a) => set({ deliveryAssessment: a }),
  setDeliveryStatus: (s) => set({ deliveryStatus: s }),
  setDeliveryError: (deliveryError) => set({ deliveryError }),

  setActionItems: (items) => set({ actionItems: items }),
  setActionItemsStatus: (status) => set({ actionItemsStatus: status }),
  setActionItemsError: (error) => set({ actionItemsError: error }),
  toggleActionItem: (id) =>
    set((state) => ({
      actionItems: state.actionItems.map((a) => (a.id === id ? { ...a, done: !a.done } : a)),
    })),
});
