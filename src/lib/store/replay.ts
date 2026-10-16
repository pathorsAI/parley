// The recording loaded for study: an upload or a saved entry, its playhead,
// seek signal and keep-window, and the transitions in and out of it.

import type { ActionItem, TimelineEvent, TranscriptSegment } from "../types";
import type { ReplaySession } from "../replay/types";
import type { HistoryEntry } from "../history/types";
import { analysisSignature } from "../analysis/lens";
import { inFlightStagesFor } from "../analysis/runRegistry";
import { log } from "../log";
import { CLEARED_STUDY_SLICE, restoredStudyStatuses } from "./study";
import type { ReplayTrim, SliceCreator } from "./types";

/** What committing a trim writes back in one update (see replay/trim.ts). */
export interface TrimmedRecording {
  replay: ReplaySession;
  segments: TranscriptSegment[];
  findings: TimelineEvent[];
  actionItems: ActionItem[];
}

export interface ReplaySlice {
  /** The uploaded recording under analysis (null in live mode). */
  replay: ReplaySession | null;
  /** Id of the saved History entry currently loaded into replay — set by
   *  {@link loadHistory}, and after a fresh upload auto-saves. When set, re-running
   *  the analysis OVERWRITES that entry on disk instead of the result being lost.
   *  null for a not-yet-saved upload or in live mode. */
  loadedHistoryId: string | null;
  setLoadedHistoryId: (id: string | null) => void;
  /** Update the loaded recording's display name (after a rename persisted via
   *  renameHistoryEntry) so the replay header reflects it immediately. */
  renameReplay: (title: string) => void;
  /** True while a READ-ONLY (org-shared) recording is loaded. Its generated study
   *  outputs can't be written back to the shared entry, so they persist into the
   *  local {@link import("../history/studyCache").writeStudyCache} instead —
   *  anything that ran is stored, and reopening never re-spends it. */
  replayReadOnly: boolean;
  /** The loaded PERSONAL entry's folder (null = unfiled/root; also null for
   *  read-only org recordings and not-yet-saved uploads). Mirrors the entry's
   *  on-disk folderId so the replay titlebar can show + change where this
   *  recording is filed without a History-window round trip. */
  replayFolderId: string | null;
  setReplayFolderId: (id: string | null) => void;
  /** Scrub position (ms) in replay mode — drives audio + transcript highlight. */
  replayPlayheadMs: number;
  /** Load an uploaded recording and switch into replay mode. */
  enterReplay: (session: ReplaySession) => void;
  /** Load a saved history entry into replay mode, RESTORING its analysis (unlike
   *  {@link enterReplay}, which clears findings so a fresh pass can run). Pass
   *  `{ readOnly: true }` for an ORG recording viewed from the cloud — it leaves
   *  {@link loadedHistoryId} null so the personal re-analysis-persist subscription
   *  never tries to write someone else's shared recording into the local dir. */
  loadHistory: (
    entry: HistoryEntry,
    session: ReplaySession,
    opts?: { readOnly?: boolean },
  ) => void;
  /** Leave replay mode and return to a clean live/idle state. */
  exitReplay: () => void;
  /** Move the replay playhead (drives both audio position and the transcript). */
  setReplayPlayhead: (ms: number) => void;
  /**
   * Bumped on every EXPLICIT seek (scrubber, timeline finding, transcript row,
   * action item) — but NOT on passive playback ticks. The transcript watches it
   * to scroll the active line into view on a jump even while paused, so audio ⇄
   * transcript ⇄ timeline stay visually in sync in both directions.
   */
  replaySeekNonce: number;
  bumpReplaySeek: () => void;

  /** Keep-window: segments outside it are excluded from the view + all analysis.
   *  null = no trim. See {@link ReplayTrim} and {@link isTrimmed}. */
  replayTrim: ReplayTrim | null;
  setReplayTrim: (trim: ReplayTrim | null) => void;
  /** Commit a trim: the rebased recording, transcript, findings and action
   *  items land together, the keep-window clears, and the playhead and
   *  selection reset — one update. */
  applyTrimmedRecording: (trimmed: TrimmedRecording) => void;
}

export const createReplaySlice: SliceCreator<ReplaySlice> = (set) => ({
  replay: null,
  loadedHistoryId: null,
  replayReadOnly: false,
  replayFolderId: null,
  replayPlayheadMs: 0,
  replaySeekNonce: 0,
  replayTrim: null,

  setLoadedHistoryId: (loadedHistoryId) => set({ loadedHistoryId }),
  setReplayFolderId: (replayFolderId) => set({ replayFolderId }),
  renameReplay: (title) =>
    set((s) => (s.replay ? { replay: { ...s.replay, name: title } } : {})),

  enterReplay: (session) => {
    log.info("store: enter replay", {
      name: session.name,
      segments: session.segments.length,
      durationMs: session.durationMs,
    });
    set({
      appMode: "study",
      replay: session,
      // A fresh upload isn't a saved entry yet — cleared until its auto-save.
      loadedHistoryId: null,
      replayReadOnly: false,
      replayFolderId: null,
      // Start at the beginning of the recording (the full transcript always
      // shows now — no masking); the playhead is just for playback/navigation.
      replayPlayheadMs: 0,
      replayTrim: null,
      segments: session.segments,
      speakerNames: session.speakerNames,
      meetingStatus: "stopped",
      highlightMs: null,
      // A fresh session gets fresh study outputs — a previous recording's
      // brief must never render over this one.
      ...CLEARED_STUDY_SLICE,
    });
  },

  loadHistory: (entry, session, opts) => {
    log.info("store: load history", {
      id: entry.id,
      source: entry.source,
      segments: entry.segments.length,
      findings: entry.findings.length,
      readOnly: !!opts?.readOnly,
    });
    const restored = restoredStudyStatuses(entry, inFlightStagesFor(session.id));
    const readOnly = !!opts?.readOnly;
    set((state) => ({
      appMode: "study",
      replay: session,
      // Re-running the analysis overwrites THIS saved entry on disk — but only for
      // an own/local entry. A read-only org recording leaves this null so the
      // re-analysis-persist subscription doesn't try to write it to the local dir.
      loadedHistoryId: readOnly ? null : entry.id,
      replayReadOnly: readOnly,
      replayFolderId: readOnly ? null : entry.folderId ?? null,
      replayPlayheadMs: 0,
      replaySeekNonce: state.replaySeekNonce + 1,
      replayTrim: null,
      ingestWizardOpen: false,
      ingestAudioPath: null,
      segments: entry.segments,
      speakerNames: entry.speakerNames,
      meetingStatus: "stopped",
      highlightMs: null,
      // Base-clear every study slice, then restore what the entry has (see
      // restoredStudyStatuses for how each status is decided).
      ...CLEARED_STUDY_SLICE,
      ...restored,
      findings: entry.findings,
      analyzedEvalSig: analysisSignature(entry.meetingKind, state.evaluations),
      actionItems: entry.actionItems,
      deliveryAssessment: entry.deliveryAssessment ?? null,
      brief: entry.brief || null,
      // A read-only org recording can be neither renamed nor refiled, so it
      // carries no suggestion — and the pass that would produce one declines too.
      filingSuggestion: readOnly ? null : entry.filingSuggestion ?? null,
      meetingKind: entry.meetingKind ?? null,
      // Restore the per-meeting context + negotiation setup.
      meetingContext: entry.meetingContext,
      meetingFolderId: entry.folderId ?? null,
      meetingBatna: entry.meetingBatna,
      meetingTarget: entry.meetingTarget,
      meetingFloor: entry.meetingFloor,
    }));
  },

  exitReplay: () => {
    log.info("store: exit replay");
    set(() => ({
      appMode: "home",
      replay: null,
      loadedHistoryId: null,
      replayReadOnly: false,
      replayFolderId: null,
      replayPlayheadMs: 0,
      replayTrim: null,
      ingestWizardOpen: false,
      ingestAudioPath: null,
      segments: [],
      speakerNames: {},
      meetingStatus: "idle",
      highlightMs: null,
      ...CLEARED_STUDY_SLICE,
    }));
  },

  setReplayPlayhead: (ms) => set({ replayPlayheadMs: Math.max(0, ms) }),
  bumpReplaySeek: () => set((s) => ({ replaySeekNonce: s.replaySeekNonce + 1 })),

  setReplayTrim: (trim) => set({ replayTrim: trim }),
  applyTrimmedRecording: ({ replay, segments, findings, actionItems }) =>
    set({
      replay,
      segments,
      findings,
      actionItems,
      replayTrim: null,
      replayPlayheadMs: 0,
      selectedFindingId: null,
    }),
});
