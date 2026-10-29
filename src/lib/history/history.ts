// Local meeting history: persist a finished session (recording + analysis) to
// disk and reload it into the replay UI later.
//
// Rust owns the files (see src-tauri/src/history.rs); this module owns the JSON
// shapes, builds entries from the live store, and turns a saved entry back into
// a replay session. Since #195 the library that lists these entries is a route
// in the main window, so opening one is a plain `loadHistoryEntry` call rather
// than a `history://open` message from a second window.

import { useStore, hasSpokenSegment, isMeetingActive } from "../store";
import { notify } from "../notify";
import { writeStudyCache } from "./studyCache";
import { isTauri } from "../tauriEvents";
import { log } from "../log";
import { CLOUD_ENABLED } from "../flags";
import { markDirty } from "../cloud/syncState";
import { syncEnabled } from "../cloud/client";
import type { OrgHandoffMode } from "../library/destination";
import { qualifiesForRediarization, rediarizeSegments } from "../speakers/postDiarize";
import { translate } from "../../i18n/messages";
import { markGettingStarted } from "../onboarding/gettingStarted";
import type { ReplaySession } from "../replay/types";
import { withoutEstimatedTiming } from "../replay/timing";
import type {
  DefaultSaveLocation,
  FilingSuggestion,
  Settings,
  TranscriptSegment,
} from "../types";
import type { StudyCacheEntry } from "./studyCache";
import type { HistoryEntry } from "./types";
import * as ipc from "../ipc/commands";
import { listenEvent, type UnlistenFn } from "../ipc/events";
import {
  emitHistoryUpdated,
  listHistory,
  readEntry,
  renameEntryFiles,
  rewriteEntry,
  rewriteEntryNow,
  withEntryWrite,
  writeEntry,
} from "./entryStore";

import { pushToCloud } from "./cloudPush";
import { loadHistoryEntry } from "./open";
import { PendingSaves } from "../meeting/pendingSaves";

// Storage access, opening, external writes and the folder repair live in their
// own modules; these keep their old import path.
export { loadHistoryEntry, loadOrgEntry, replaySessionFor } from "./open";
export {
  setEntryAnalysis,
  updateEntryMeta,
  type EntryAnalysisPatch,
  type EntryMetaPatch,
} from "./externalWrites";
export { migrateDuplicateFolders } from "./folderDedupe";
export {
  buildSummary,
  deleteHistoryEntry,
  emitHistoryUpdated,
  entryWritesSettled,
  listHistory,
  listenForHistoryUpdated,
} from "./entryStore";

const RECORDING_SAVED_EVENT = "meeting://recording-saved";
// Rust emits this instead of `recording-saved` when the stopped meeting produced
// no keepable recording (empty / too short / encode failed). Nothing is saved,
// so it exists only to release the titlebar's "finalizing" state.
const RECORDING_DISCARDED_EVENT = "meeting://recording-discarded";

// ── Build helpers ───────────────────────────────────────────────────────────

/** Snapshot the analysis-related slice of the store into a partial entry.
 *  Exported for testing. */
export function snapshotAnalysis() {
  const s = useStore.getState();
  return {
    // An estimated timeline is a display aid, not data: the entry keeps the
    // untimed transcript it came with (see replay/timing).
    segments: s.replay?.timingEstimated ? withoutEstimatedTiming(s.segments) : s.segments,
    speakerNames: s.speakerNames,
    findings: s.findings,
    actionItems: s.actionItems,
    // "Pipeline completed" marker — lets loadHistory restore even an EMPTY result
    // as done instead of re-running it. False when a pass hasn't run or failed
    // (a live save before the post-meeting pass; an errored action-items pass):
    // loading then falls back to the content heuristic, and the flag turns true
    // once a completed re-run persists (initHistoryPersistSync snapshots only
    // after both statuses settle "done").
    analyzed: s.analysisStatus === "done" && s.actionItemsStatus === "done",
    meetingContext: s.meetingContext,
    meetingBatna: s.meetingBatna,
    meetingTarget: s.meetingTarget,
    meetingFloor: s.meetingFloor,
    deliveryAssessment: s.deliveryAssessment,
    // Upload/loaded entries carry the measured pace on the replay session; a live
    // meeting has none here — saveLiveToHistory measures the recording + sets it.
    speechRateHz: s.replay?.speechRateHz ?? null,
    // Study outputs ride along so a plain save/overwrite never drops them.
    brief: s.brief,
    // A failed brief stays failed across a plain overwrite (see
    // HistoryEntry.briefFailed) — and a good one clears the flag.
    briefFailed: s.briefStatus === "error" && !s.brief,
    // Same for the filing suggestion: the upload's FIRST save happens while the
    // pass may already have landed, and a re-analysis overwrite must not drop a
    // suggestion the user hasn't answered yet. The completion flag is asserted
    // only while a suggestion is PENDING: a "done" stage with nothing pending is
    // either a pass that offered nothing (deliberately never persisted, so other
    // devices can still try — see filingRun) or one the user already answered,
    // which persistFilingSuggestion writes itself. Either way the snapshot
    // defers to what is on disk (mergeAnalysisSnapshot keeps meta's fields).
    filingSuggestion: s.filingSuggestion,
    filingSuggested: s.filingStatus === "done" && !!s.filingSuggestion,
    // The kind SHAPED those outputs, so it is part of them.
    meetingKind: s.meetingKind,
  };
}

/** Measure a recording's articulation rate (syllables/sec) via Rust; null on any
 *  failure. Same DSP quantity the upload path computes. For live saves this is
 *  only a FALLBACK for mic-only recordings — the primary source is the mic-derived
 *  session rate (store.micSessionRateHz), which never includes the other side. */
async function measureRecordingRate(path: string): Promise<number | null> {
  if (!isTauri()) return null;
  try {
    const hz = await ipc.measureAudioSpeechRate({ path });
    return hz > 0 ? hz : null;
  } catch (e) {
    log.warn("history: live speech-rate measure failed", { error: String(e) });
    return null;
  }
}

/** The analysis slice captured by {@link snapshotAnalysis} (passed to a deferred save). */
export type AnalysisSnapshot = ReturnType<typeof snapshotAnalysis>;

/** An analysis slice with nothing in it: a recording saved without its
 *  transcript (an orphaned or crash-recovered meeting). */
function emptyAnalysis(): AnalysisSnapshot {
  return {
    segments: [],
    speakerNames: {},
    findings: [],
    actionItems: [],
    analyzed: false,
    meetingContext: "",
    meetingBatna: "",
    meetingTarget: "",
    meetingFloor: "",
    deliveryAssessment: null,
    speechRateHz: null,
    brief: null,
    briefFailed: false,
    filingSuggestion: null,
    filingSuggested: false,
    meetingKind: null,
  };
}

/**
 * Everything a finished live meeting's save needs, captured the moment it
 * stops. The save runs only once Rust has encoded the recording, and by then
 * the user may have started the next meeting: reading the live store at that
 * point gave the old recording the new meeting's start time and transcript,
 * or discarded it as empty.
 */
export interface LiveMeetingSnapshot {
  /** The meeting's id (store.liveMeetingId) — also its history entry's id. */
  id: string;
  createdAt: number;
  analysis: AnalysisSnapshot;
  transcriptionDropped: boolean;
  micSessionRateHz: number | null;
  save: MeetingSaveTarget;
  /** The name typed in the floating window; absent = the dated default. */
  title?: string;
  /** The backend recorded it without this window knowing (the page reloaded
   *  under a running capture): its transcript is gone, keep the audio. */
  orphan: boolean;
}

/** Stopped meetings whose recording is still being encoded and saved. */
export const liveSaves = new PendingSaves<LiveMeetingSnapshot>();

/**
 * The meeting's context as saved: the prepared context, then the notes typed
 * during the meeting under a heading — so the report and every later analysis
 * read them along with the context. Pure; exported for testing.
 */
export function contextWithNotes(context: string, notes: string, heading: string): string {
  const n = notes.trim();
  if (!n) return context;
  const c = context.trim();
  return c ? `${c}\n\n${heading}\n${n}` : `${heading}\n${n}`;
}

/** Snapshot the live meeting the store shows now (null when it has no id). */
export function snapshotLiveMeeting(): LiveMeetingSnapshot | null {
  const s = useStore.getState();
  if (!s.liveMeetingId) return null;
  return {
    id: s.liveMeetingId,
    createdAt: s.meetingStartedAt ?? Date.now(),
    analysis: (() => {
      const a = snapshotAnalysis();
      const heading = translate(s.settings.language, "floating.notesHeading");
      return { ...a, meetingContext: contextWithNotes(a.meetingContext, s.meetingNotes, heading) };
    })(),
    transcriptionDropped: s.transcriptionDropped,
    micSessionRateHz: s.micSessionRateHz,
    save: resolveMeetingSave(),
    title: s.meetingTitle.trim() || undefined,
    orphan: false,
  };
}

/** A meeting this window never saw: only the backend's id and start time. */
export function orphanSnapshot(id: string, startedAtMs: number | undefined): LiveMeetingSnapshot {
  const def = useStore.getState().settings.defaultSaveLocation;
  return {
    id,
    createdAt: startedAtMs || Date.now(),
    analysis: emptyAnalysis(),
    transcriptionDropped: true,
    micSessionRateHz: null,
    save: {
      folderId: def.scope === "personal" ? (def.folderId ?? null) : null,
      autoShare: null,
      fallback: null,
      origin: "default",
    },
    orphan: true,
  };
}

/**
 * The snapshot to save meeting `id`'s recording with. Final words can still
 * land after Stop (the provider's closing flush), so while the store still
 * shows THIS meeting — nothing has replaced it — its transcript is re-read;
 * once another meeting has started, the Stop-time snapshot stands.
 */
export function liveSnapshotFor(id: string | undefined, startedAtMs: number | undefined): LiveMeetingSnapshot {
  const s = useStore.getState();
  const showsIt = !!id && s.liveMeetingId === id && !isMeetingActive(s.meetingStatus);
  const captured = id ? liveSaves.snapshotOf(id) : null;
  if (captured) {
    if (!showsIt) return captured;
    return {
      ...captured,
      analysis: snapshotAnalysis(),
      transcriptionDropped: s.transcriptionDropped,
      micSessionRateHz: s.micSessionRateHz,
    };
  }
  if (showsIt) return snapshotLiveMeeting() ?? orphanSnapshot(id, startedAtMs);
  return orphanSnapshot(id ?? crypto.randomUUID(), startedAtMs);
}

/** The meeting's entry is on disk (or it was deliberately not kept): its
 *  crash journal can go. Best-effort — a leftover journal is recovered into
 *  the same entry id next launch, and skipped then as already saved. */
function finishJournal(id: string): void {
  ipc.finishMeetingJournal({ meetingId: id }).catch((error) =>
    log.warn("history: dropping the meeting journal failed", { id, error: String(error) }),
  );
}

/**
 * Keep a finished live meeting's recording, or discard it? Discard only the
 * accidental Start/Stop — nothing transcribed AND the transcription link never
 * dropped. A meeting whose link went down at any point is kept even with no
 * transcript at all (#570): with the network gone, the recording may be the
 * only copy of what was said, and an empty transcript there means "not
 * transcribed", not "nothing happened". Pure + exported for testing.
 */
export function shouldKeepLiveRecording(
  s: Pick<ReturnType<typeof useStore.getState>, "segments" | "transcriptionDropped">,
): boolean {
  return hasSpokenSegment(s.segments) || s.transcriptionDropped;
}

/** Persist an entry: write meta + summary and place the audio. */
async function persist(
  entry: HistoryEntry,
  audioSourcePath: string | null,
  compress: boolean,
): Promise<void> {
  await writeEntry(entry, { audioSourcePath, compress });
  log.info("history: entry saved", { id: entry.id, source: entry.source });
  // Every NEW entry — live save, audio upload, transcript import — lands here
  // (cloud pulls write their own files and never pass through), so this is the
  // one place the getting-started checklist learns a recording exists, and that
  // it was filed when the save already had a folder (the ingest wizard's
  // destination, or a default save folder).
  markGettingStarted("recorded");
  if (entry.folderId) markGettingStarted("filed");
  // Best-effort push to the cloud when signed in (dynamic import avoids a static
  // cycle: sync.ts imports buildSummary/listHistory from here). No-op when signed out.
  pushToCloud(entry.id).catch((error) =>
    log.warn("history: cloud push failed", { id: entry.id, error: String(error) }),
  );
}

// ── Save location ─────────────────────────────────────────────────────────────

/** What saving this meeting will do: where the local entry files, and whether
 *  an org gets an auto-shared copy. */
export interface MeetingSaveTarget {
  folderId: string | null;
  autoShare: OrgShareChoice | null;
  fallback: "syncOff" | null;
  /** "meeting" = the folder picked for this call; "default" = the settings
   *  default (or the personal root). */
  origin: "meeting" | "default";
}

/** An org destination plus what it does to the personal original. The settings
 *  default is always a copy; only an explicit per-meeting pick can be a move. */
export interface OrgShareChoice {
  orgId: string;
  folderId: string | null;
  mode: OrgHandoffMode;
}

/** The per-meeting org-share choice. `null` follows the settings default;
 *  `"off"` suppresses a default share for this one meeting. */
export type MeetingShare = OrgShareChoice | "off" | null;

/**
 * THE one place that answers "what does saving this meeting do?".
 *
 * Two independent decisions: which personal folder the local entry files into
 * (this call's pick, else the settings default), and whether an org gets a
 * shared copy (this call's pick, else the settings default). A shared copy is a
 * second destination, never a move — the local entry always lands.
 */
/** The org share this meeting asks for, before the cloud/sync gate: the
 *  meeting's own pick, else the settings default. `"off"` suppresses both. */
function wantedOrgShare(
  meetingOrgShare: MeetingShare,
  def: DefaultSaveLocation,
): OrgShareChoice | null {
  if (meetingOrgShare === "off") return null;
  if (meetingOrgShare) return meetingOrgShare;
  if (def.scope === "org" && def.orgId) {
    return { orgId: def.orgId, folderId: def.folderId ?? null, mode: "copy" };
  }
  return null;
}

export function resolveMeetingSave(): MeetingSaveTarget {
  const s = useStore.getState();
  const def = s.settings.defaultSaveLocation;
  const defaultFolder = def.scope === "personal" ? (def.folderId ?? null) : null;
  const picked = s.meetingFolderId;
  const base: MeetingSaveTarget = {
    folderId: picked ?? defaultFolder,
    autoShare: null,
    fallback: null,
    origin: picked ? "meeting" : "default",
  };

  const wanted = wantedOrgShare(s.meetingOrgShare, def);
  if (!wanted) return base;
  // An org share needs the cloud edition, signed in, sync on.
  if (!CLOUD_ENABLED || !syncEnabled()) return { ...base, fallback: "syncOff" };
  return { ...base, autoShare: wanted };
}

/** After a save, hand the entry over to the chosen org folder — or toast why it
 *  fell back. A "move" drops the personal original once the copy is in, which
 *  also retires this window's loaded-entry pointer: nothing local is left for a
 *  later re-analysis to overwrite. */
async function applyDefaultOrgShare(id: string, res: MeetingSaveTarget): Promise<void> {
  const lang = useStore.getState().settings.language;
  if (res.fallback === "syncOff") {
    notify.message(translate(lang, "history.defaultSave.orgNeedsSync"));
    return;
  }
  if (!res.autoShare || !CLOUD_ENABLED) return;
  const { orgId, folderId, mode } = res.autoShare;
  try {
    const m = await import("../cloud/sync");
    if (mode === "move") {
      await m.moveRecordingToOrg(id, orgId, folderId);
      const st = useStore.getState();
      if (st.loadedHistoryId === id) st.setLoadedHistoryId(null);
      // Say so: the recording just vanished from the personal library, and a
      // silent disappearance reads as a lost save.
      notify.success(translate(lang, "history.move.movedToFolder"));
    } else {
      await m.shareRecordingToOrg(id, orgId, folderId);
    }
    markGettingStarted("filed");
  } catch (e) {
    log.error("history: org auto-share failed", { id, error: String(e) });
    notify.error(translate(lang, "history.defaultSave.orgShareFailed"));
  }
}

// ── Save paths ──────────────────────────────────────────────────────────────

/**
 * The in-flight UPLOAD save (Opus compress + write), or null. The re-analysis
 * persist subscription awaits this before overwriting, so a re-analysis fired
 * during the slow compress can't run updateHistoryEntry before the file exists.
 */
let uploadSaveInFlight: Promise<unknown> | null = null;

/**
 * Auto-save a finished LIVE meeting once Rust reports the encoded recording,
 * from the snapshot taken when it stopped (see {@link LiveMeetingSnapshot}).
 * No-op when the meeting produced no transcript (e.g. started + stopped at once)
 * — unless its transcription dropped, see {@link shouldKeepLiveRecording}.
 */
export async function saveLiveToHistory(
  audioTempPath: string,
  durationMs: number,
  snap: LiveMeetingSnapshot,
): Promise<void> {
  if (!isTauri()) return;
  const { analysis } = snap;
  if (!shouldKeepLiveRecording({ segments: analysis.segments, transcriptionDropped: snap.transcriptionDropped })) {
    await skipEmptyLiveSave(audioTempPath, snap.id);
    return;
  }
  if (snap.transcriptionDropped) {
    // Saved past the empty-transcript gate, or saved with a transcript that
    // has a hole in it — either way worth one line when a user asks where part
    // of their meeting went.
    log.info("history: live save after a transcription drop", {
      id: snap.id,
      orphan: snap.orphan,
      spoken: hasSpokenSegment(analysis.segments),
      segments: analysis.segments.length,
    });
  }
  const s = useStore.getState();
  const createdAt = snap.createdAt;
  const dateLabel = new Date(createdAt).toLocaleString(localeOf());
  // Mic-only measured pace (issue #22): prefer the whole-session articulation rate
  // the live prosody tap accumulated from the user's OWN mic. Only fall back to
  // measuring the saved file when the mic rate is missing AND the file can't
  // contain the other side — in diarized meetings the recording is the mic+system
  // MIX, and measuring it would fold the counterpart's pace into the number.
  const speechRateHz = await liveSpeechRate(snap, audioTempPath);
  const save = snap.save;
  log.info("history: live save destination", { id: snap.id, origin: save.origin, folderId: save.folderId });
  const entry: HistoryEntry = {
    // The meeting's own id: a second save of the same meeting (a recovered
    // journal, a repeated event) overwrites its entry instead of duplicating it.
    id: snap.id,
    title: snap.title ?? `${translate(s.settings.language, "history.liveTitle")} · ${dateLabel}`,
    source: "live",
    createdAt,
    durationMs,
    audio: "audio.ogg",
    folderId: save.folderId,
    ...analysis,
    speechRateHz,
  };
  try {
    await persist(entry, audioTempPath, /* compress */ false);
  } catch (e) {
    // Nothing landed, so there is nothing to open or correct — just release the
    // titlebar spinner (the caller also clears it; doing it here keeps this
    // function honest on its own) and let the caller log the failure. The
    // meeting's journal stays on disk, so the next launch recovers it.
    clearFinalizing();
    throw e;
  }
  finishJournal(snap.id);

  // A per-meeting MOVE to an org drops the personal original once the copy is
  // in, so there is no personal report to open — the copy must carry the
  // corrected speakers, though, so that one path still finishes the whole
  // chain before the spinner clears (as every save did before the report
  // started opening early).
  if (save.autoShare?.mode === "move") {
    try {
      await correctSpeakersThenShare(entry, save);
    } finally {
      clearFinalizing();
    }
    return;
  }

  // 會後 60 秒: a meeting's natural ending is its debrief — slide straight into
  // the study tense (landing on the report) the moment the recording is on
  // disk, unless the user already started another meeting or opened something
  // else meanwhile. The speaker correction and the org copy below can take
  // minutes on a long meeting; nothing about them needs the user to wait.
  //
  // The correction gate goes up BEFORE the report opens, so the study pipeline
  // never sees an un-gated tick for this entry and never dispatches a deep pass
  // on the provider's labels (filing still runs — it reads only the text).
  const correcting = qualifiesForRediarization(entry.segments);
  if (correcting) useStore.getState().setPostSaveDiarizingId(entry.id);
  try {
    const now = useStore.getState();
    const showsThisMeeting = now.liveMeetingId === entry.id || snap.orphan;
    if (!isMeetingActive(now.meetingStatus) && now.appMode === "live" && showsThisMeeting) {
      now.setStudyTab("report");
      await loadHistoryEntry(entry.id).catch((e) =>
        log.warn("history: auto-open after stop failed", { id: entry.id, error: String(e) }),
      );
    }
  } finally {
    // The report is up (or was skipped, or failed to open): the save the user
    // was waiting on is done, whatever the background passes do next.
    clearFinalizing();
  }

  // Background: correct the speakers from the audio, THEN make the org copy —
  // in that order, so a shared copy carries the corrected labels.
  void correctSpeakersThenShare(entry, save).catch((e) =>
    log.error("history: post-save background work failed", { id: entry.id, error: String(e) }),
  );
}

/** Nothing was transcribed and the link never dropped — almost certainly an
 *  accidental Start/Stop. Don't save a history entry, and discard the encoded
 *  temp recording so it doesn't orphan in the temp dir (an entry would
 *  normally consume it on save). */
async function skipEmptyLiveSave(audioTempPath: string, id: string): Promise<void> {
  log.info("history: live save skipped (no transcript)", { id });
  await ipc.discardRecording({ path: audioTempPath }).catch((error) =>
    log.warn("history: discard empty live recording failed", {
      path: audioTempPath,
      error: String(error),
    }),
  );
  finishJournal(id);
  if (useStore.getState().liveMeetingId === id) leaveStoppedCockpit("meeting.notSaved.noTranscript");
}

/** Mic-only measured pace (issue #22): prefer the whole-session articulation
 *  rate the live prosody tap accumulated from the user's OWN mic. Only measure
 *  the saved file when that is missing AND the file can't contain the other
 *  side — in diarized meetings the recording is the mic+system MIX. */
async function liveSpeechRate(snap: LiveMeetingSnapshot, audioTempPath: string): Promise<number | null> {
  if (snap.micSessionRateHz != null) return snap.micSessionRateHz;
  const micOnlyRecording = !snap.analysis.segments.some((seg) => seg.source === "mix");
  return micOnlyRecording && !snap.orphan ? measureRecordingRate(audioTempPath) : null;
}

function clearFinalizing(): void {
  useStore.getState().setFinalizingMeeting(false);
}

/** After a live save's first write: voice re-diarization (best-effort), then
 *  the default org share. Holds the study pipeline's deep stages for this entry
 *  (store.postSaveDiarizingId) for exactly as long as the correction runs. */
async function correctSpeakersThenShare(entry: HistoryEntry, save: MeetingSaveTarget): Promise<void> {
  if (qualifiesForRediarization(entry.segments)) await correctSpeakers(entry);
  await applyDefaultOrgShare(entry.id, save);
}

async function correctSpeakers(entry: HistoryEntry): Promise<void> {
  useStore.getState().setPostSaveDiarizingId(entry.id);
  try {
    await applyPostSaveDiarization(entry);
  } catch (e) {
    // Best-effort: any failure keeps the provider labels, and the pipeline
    // proceeds on them the moment the gate below drops.
    log.warn("history: post-save re-diarization failed", { id: entry.id, error: String(e) });
  } finally {
    // Only drop OUR gate — a newer meeting's save may already have raised its own.
    if (useStore.getState().postSaveDiarizingId === entry.id) {
      useStore.getState().setPostSaveDiarizingId(null);
    }
  }
}

/**
 * Fold re-diarized speaker numbers onto a segment list, by segment id. Only the
 * `speaker` field moves: text the user may have edited, and every other field,
 * stay as they are in `current`. Speaker NAMES are not touched at all — they
 * live in a separate map keyed by source + speaker number, and the correction
 * keeps the provider's numbering (postDiarize.remapToPriorSpeakers), so a name
 * typed against "speaker 2" while the pass ran still belongs to speaker 2.
 * Returns `current` itself when nothing changes. Pure + exported for testing.
 */
export function applyCorrectedSpeakers(
  current: TranscriptSegment[],
  corrected: TranscriptSegment[],
): TranscriptSegment[] {
  const bySegId = new Map(corrected.map((s) => [s.id, s.speaker]));
  let changed = false;
  const next = current.map((s) => {
    const sp = bySegId.get(s.id);
    if (sp === undefined || sp === s.speaker) return s;
    changed = true;
    return { ...s, speaker: sp };
  });
  return changed ? next : current;
}

/**
 * After a live save: re-derive the speakers from the recording's AUDIO and patch
 * the just-saved entry. Provider streaming diarization drifts over long meetings
 * (swapped labels, spurious late speakers); the on-device voice pipeline fixes
 * that once the full recording exists, remapping the new clusters onto the
 * provider's numbering so names assigned during the meeting stay attached (see
 * postDiarize.ts). No-op for mic-only meetings and when nothing changes.
 *
 * Runs in the BACKGROUND, after the report has opened — so by the time it
 * lands, the user may have renamed the recording, accepted a filing suggestion
 * or typed speaker names. The disk write is therefore a read-modify-write of
 * the CURRENT meta inside the per-entry write chain (only `segments` changes),
 * and the store keeps its own speaker names.
 */
async function applyPostSaveDiarization(entry: HistoryEntry): Promise<void> {
  const { audioPath } = await readEntry(entry.id);
  if (!audioPath) return;
  const result = await rediarizeSegments(entry.segments, audioPath);
  if (!result) return;

  await rewriteEntry(entry.id, (meta) => ({
    ...meta,
    segments: applyCorrectedSpeakers(meta.segments, result.segments),
  }));
  await emitHistoryUpdated(entry.id);
  pushToCloud(entry.id).catch((e) =>
    log.warn("history: cloud push failed", { id: entry.id, error: String(e) }),
  ); // refresh the cloud copy with the corrected labels

  // The finished meeting is usually on screen as its report by now — retag
  // those lines too. Live segment ids REPEAT across sessions ("mix-0",
  // "mix-1", …), so an id match alone could hit a different meeting's lines.
  // Only touch the store when it provably still shows THIS meeting: this very
  // entry (auto-opened, or re-opened from history), or the just-ended live
  // session if the auto-open was skipped (the entry carries its meeting's id).
  const st = useStore.getState();
  const showsThisMeeting =
    st.loadedHistoryId === entry.id ||
    (st.appMode === "live" && st.loadedHistoryId === null && st.liveMeetingId === entry.id);
  if (showsThisMeeting) {
    const segments = applyCorrectedSpeakers(st.segments, result.segments);
    // `speakerNames` deliberately untouched — see applyCorrectedSpeakers.
    if (segments !== st.segments) st.setSegments(segments);
    notify.message(translate(st.settings.language, "speakers.postRefined"));
  }
  log.info("history: post-save re-diarization applied", { id: entry.id, changed: result.changed });
}

/**
 * Auto-save a finished UPLOAD/replay session (after its analysis completes). The
 * source file is compressed into the entry folder so history is self-contained.
 * Returns the new entry id (null outside Tauri) so the caller can mark it as the
 * loaded entry — a later re-analysis then overwrites it instead of duplicating.
 */
export async function saveUploadToHistory(session: ReplaySession): Promise<string | null> {
  if (!isTauri()) return null;
  const id = crypto.randomUUID();
  const save = resolveMeetingSave();
  log.info("history: upload save destination", { origin: save.origin, folderId: save.folderId });
  const entry: HistoryEntry = {
    id,
    title: session.name,
    source: "upload",
    createdAt: session.createdAt,
    durationMs: session.durationMs,
    audio: "audio.ogg",
    folderId: save.folderId,
    ...snapshotAnalysis(),
  };
  // Mark this as the loaded entry BEFORE the (multi-second Opus) compress runs, so
  // a re-analysis fired DURING that window marks it dirty and overwrites it once
  // saved — instead of being lost because loadedHistoryId was still null. The
  // persist subscription awaits `uploadSaveInFlight` so the overwrite can't run
  // before the file exists.
  useStore.getState().setLoadedHistoryId(id);
  useStore.getState().setReplayFolderId(entry.folderId ?? null);
  const saving = persist(entry, session.audioPath, /* compress */ true);
  uploadSaveInFlight = saving;
  try {
    await saving;
  } finally {
    if (uploadSaveInFlight === saving) uploadSaveInFlight = null;
  }
  await applyDefaultOrgShare(id, save);
  return id;
}

/** What the transcript-import dialog saves (issue #130's text-ingest path). */
export interface TranscriptImportSave {
  title: string;
  segments: TranscriptSegment[];
  speakerNames: Record<string, string>;
  durationMs: number;
  createdAt: number;
  folderId: string | null;
}

/**
 * Save an imported PLAIN-TEXT transcript as a normal history entry (design doc
 * D11: source "upload", audio null — replay's audio-less degradation already
 * handles it). Unlike {@link saveUploadToHistory} this never snapshots the live
 * store: a bulk import must not inherit whatever meeting context the store
 * happens to hold — the destination arrives only as the EXPLICIT
 * `save.folderId` an import door passed. Saved with `analyzed: false`
 * and no findings, so the study pipeline analyzes it on FIRST OPEN — importing
 * a folder's worth of transcripts spends zero model calls up front. Returns
 * the new entry id.
 */
export async function saveTranscriptToHistory(save: TranscriptImportSave): Promise<string | null> {
  if (!isTauri()) return null;
  const entry: HistoryEntry = {
    id: crypto.randomUUID(),
    title: save.title,
    source: "upload",
    createdAt: save.createdAt,
    durationMs: save.durationMs,
    segments: save.segments,
    speakerNames: save.speakerNames,
    findings: [],
    actionItems: [],
    analyzed: false,
    meetingContext: "",
    meetingBatna: "",
    meetingTarget: "",
    meetingFloor: "",
    audio: null,
    folderId: save.folderId,
  };
  await persist(entry, null, /* compress */ false);
  // The import usually starts FROM the History window — tell its grid to re-list.
  await emitHistoryUpdated(entry.id).catch(() => {});
  return entry.id;
}

/**
 * Lay a store snapshot over the saved entry for {@link updateHistoryEntry}.
 * Pure + exported for testing.
 *
 * The snapshot is taken when findings + action items settle, while the brief,
 * delivery and filing passes may still be generating — the store reads null for
 * those, and each lands on disk by itself moments later (persistStageOutputs).
 * The snapshot's write can still arrive AFTER theirs (it is debounced), so a
 * null there means "not known yet", never "erase": it must not undo a sibling
 * stage that already saved. Filing fields are copied only when the snapshot
 * carries a pending suggestion (filingSuggested); otherwise meta's stand — a
 * user's dismiss/accept is already on disk via persistFilingSuggestion, and an
 * empty pass is never persisted at all.
 */
export function mergeAnalysisSnapshot(meta: HistoryEntry, analysis: AnalysisSnapshot): HistoryEntry {
  return {
    ...meta,
    ...analysis,
    deliveryAssessment: analysis.deliveryAssessment ?? meta.deliveryAssessment ?? null,
    brief: analysis.brief || meta.brief || null,
    briefFailed: analysis.brief ? false : analysis.briefFailed || !!meta.briefFailed,
    meetingKind: analysis.meetingKind ?? meta.meetingKind ?? null,
    ...(analysis.filingSuggested
      ? {}
      : { filingSuggestion: meta.filingSuggestion ?? null, filingSuggested: meta.filingSuggested }),
  };
}

/**
 * Overwrite an existing entry's ANALYSIS in place — used after the user re-runs
 * the analysis on a loaded record. Reads the saved entry first so its title,
 * source, createdAt, duration and audio are preserved, then patches in the
 * current store's findings + action items + transcript + context and rewrites
 * meta + summary. `audioSourcePath: null` leaves the recording untouched.
 */
export async function updateHistoryEntry(id: string, snapshot?: AnalysisSnapshot): Promise<void> {
  if (!isTauri()) return;
  // Use the caller's captured snapshot when given (a deferred/flushed save — the
  // live store may since have been cleared); otherwise snapshot now.
  const analysis = snapshot ?? snapshotAnalysis();
  const updated = await rewriteEntry(id, (meta) => mergeAnalysisSnapshot(meta, analysis));
  await emitHistoryUpdated(id);
  pushToCloud(id); // re-analysis → refresh the cloud copy too (best-effort)
  log.info("history: entry analysis overwritten", { id, findings: updated.findings.length });
}

/** What one study stage produced, as the entry fields it owns. */
export type StageOutputPatch = Partial<
  Pick<
    HistoryEntry,
    | "findings"
    | "actionItems"
    | "analyzed"
    | "meetingKind"
    | "deliveryAssessment"
    | "brief"
    | "briefFailed"
    | "filingSuggestion"
    | "filingSuggested"
  >
>;

/**
 * Fold one stage's output onto a saved entry. Only the stage's own fields move,
 * so a brief landing can't clobber a delivery assessment and vice versa. Pure +
 * exported for testing.
 *
 *  - findings / actionItems / deliveryAssessment: replaced when given;
 *  - analyzed: only ever set true here (it means the findings + action-items
 *    pipeline completed, and only the action-items stage says so);
 *  - meetingKind: a null never erases a saved kind;
 *  - brief: only a NON-EMPTY text is a brief (an empty one is what a failed
 *    stream yields — see HistoryEntry.briefFailed);
 *  - filingSuggestion: copied authoritatively when present, null included (a
 *    pass that had nothing to propose).
 */
export function mergeStageOutputs(meta: HistoryEntry, patch: StageOutputPatch): HistoryEntry {
  const next: HistoryEntry = { ...meta };
  if (patch.findings) next.findings = patch.findings;
  if (patch.actionItems) next.actionItems = patch.actionItems;
  if (patch.analyzed) next.analyzed = true;
  if (patch.meetingKind) next.meetingKind = patch.meetingKind;
  if (patch.deliveryAssessment) next.deliveryAssessment = patch.deliveryAssessment;
  if (patch.brief) next.brief = patch.brief;
  if (patch.briefFailed !== undefined) next.briefFailed = patch.briefFailed;
  if ("filingSuggestion" in patch) next.filingSuggestion = patch.filingSuggestion ?? null;
  if (patch.filingSuggested !== undefined) next.filingSuggested = patch.filingSuggested;
  return next;
}

/** The read-only twin of {@link mergeStageOutputs}: the same patch, as the
 *  local study cache's fields (writeStudyCache merges them accretively). */
function cachePatchOf(patch: StageOutputPatch): StudyCacheEntry {
  return {
    findings: patch.findings,
    actionItems: patch.actionItems,
    analyzed: patch.analyzed,
    meetingKind: patch.meetingKind,
    brief: patch.brief || undefined,
    briefFailed: patch.briefFailed,
    deliveryAssessment: patch.deliveryAssessment,
  };
}

/**
 * Write one study stage's output onto a saved entry — on disk, then the cloud
 * copy. Used both while the recording is on screen and after the user left it
 * (a stage that finished off screen), which is why it takes the entry id rather
 * than reading `loadedHistoryId`. Serialized per entry with every other in-place
 * update, so two stages landing together can't race their read-modify-writes.
 * `push: false` only marks the entry dirty, for a write the next stage's write
 * will push anyway (each push re-uploads the audio).
 */
export async function patchEntryOutputs(
  id: string,
  patch: StageOutputPatch,
  opts?: { push?: boolean },
): Promise<void> {
  if (!isTauri()) return;
  await withEntryWrite(id, async () => {
    // An upload's initial save may still be compressing — wait so the entry exists.
    await Promise.resolve(uploadSaveInFlight).catch(() => {});
    await rewriteEntryNow(id, (meta) => mergeStageOutputs(meta, patch));
  });
  await emitHistoryUpdated(id).catch(() => {});
  if (opts?.push === false) markDirty(id);
  else pushToCloud(id).catch((e) => log.warn("history: cloud push failed", { id, error: String(e) }));
  log.info("history: stage outputs saved", { id, fields: Object.keys(patch).join(",") });
}

/**
 * Persist one stage's output wherever its recording keeps outputs: its own
 * saved entry, or — for a READ-ONLY org recording, which can't be written back —
 * the local study cache, so anything that ran is still stored and reopening
 * never re-spends it. No-op for a not-yet-saved upload (its first save
 * snapshots the store anyway).
 */
export async function persistStageOutputs(
  target: { entryId: string | null; readOnlyId: string | null },
  patch: StageOutputPatch,
  opts?: { push?: boolean },
): Promise<void> {
  if (target.readOnlyId) {
    writeStudyCache(target.readOnlyId, cachePatchOf(patch));
    log.info("history: study outputs cached (read-only entry)", { id: target.readOnlyId });
    return;
  }
  if (target.entryId) await patchEntryOutputs(target.entryId, patch, opts);
}

/**
 * Fold the loaded READ-ONLY org recording's study outputs into the local study
 * cache. The study pipeline calls this when a findings or action-items pass
 * settles on one (those have no runner-side persist; brief, delivery and a pass
 * that finished off screen persist from their runners via persistStageOutputs).
 */
export async function persistReadOnlyStudyOutputs(): Promise<void> {
  const s = useStore.getState();
  if (!s.replayReadOnly || !s.replay?.id) return;
  writeStudyCache(s.replay.id, {
    findings: s.findings,
    actionItems: s.actionItems,
    analyzed: s.analysisStatus === "done" && s.actionItemsStatus === "done",
    meetingKind: s.meetingKind,
    brief: s.brief,
    deliveryAssessment: s.deliveryAssessment,
  });
  log.info("history: study outputs cached (read-only entry)", { id: s.replay.id });
}

/**
 * Persist the loaded entry's FILING SUGGESTION — the proposed title + folders,
 * or its absence once the user has answered it (a dismissal or acceptance). The
 * one place that copies the filing fields from the STORE authoritatively; the
 * filing pass itself lands its suggestion through {@link persistStageOutputs}.
 *
 * No-op for a read-only org recording (nothing to rename or refile, so it never
 * had a suggestion) and for a not-yet-saved upload (there is no entry yet; its
 * first save carries the fields via snapshotAnalysis).
 */
export async function persistFilingSuggestion(): Promise<void> {
  const s = useStore.getState();
  const id = s.loadedHistoryId;
  if (!isTauri() || s.replayReadOnly || !id) return;
  // An upload's initial save may still be compressing — wait so the entry exists.
  await Promise.resolve(uploadSaveInFlight).catch(() => {});
  const updated = await rewriteEntry(id, (meta) => ({
    ...meta,
    filingSuggestion: s.filingSuggestion,
    // The pass ran, whatever it produced — so reopening never pays for it twice.
    filingSuggested: true,
  }));
  pushToCloud(id);
  log.info("history: filing suggestion saved", { id, pending: !!updated.filingSuggestion });
}

// ── List / read / delete ─────────────────────────────────────────────────────

/**
 * A pending filing suggestion after the recording has been renamed: its title is
 * answered, its folders are not. Nothing left → null. The in-memory twin of
 * history.rs `apply_rename`; pure and exported for testing.
 */
export function clearSuggestedTitle(suggestion: FilingSuggestion | null): FilingSuggestion | null {
  if (!suggestion) return null;
  return suggestion.folders.length > 0 ? { ...suggestion, title: "" } : null;
}

/**
 * Rename an entry (patches the title in meta + summary). EVERY rename — the
 * replay titlebar, the library, MCP's rename_recording, the filing card — comes
 * through here, and every one also retires the pending filing suggestion's
 * title: the user has now named the recording, so a "suggested title" left
 * beside it is a second, competing name. Rust clears it in the same meta.json
 * write (history.rs `apply_rename`); this mirrors that into the store when the
 * renamed entry is the one on screen, so the card drops its title row at once.
 */
export async function renameHistoryEntry(id: string, title: string): Promise<void> {
  if (!isTauri()) return;
  await renameEntryFiles(id, title.trim());
  log.info("history: entry renamed", { id });
  const s = useStore.getState();
  if (s.loadedHistoryId === id && s.filingSuggestion?.title) {
    s.setFilingSuggestion(clearSuggestedTitle(s.filingSuggestion));
  }
  // A rename is a content change → go through the same dirty→push→clear lifecycle
  // as save/re-analysis, so a failed cloud push is retried by the background sweep.
  pushToCloud(id);
  // Renames can now start outside the History grid (replay header, MCP), so tell
  // any open History window to re-list.
  emitHistoryUpdated(id).catch((e) =>
    log.warn("history: rename update event failed", { id, error: String(e) }),
  );
}

/**
 * THE way a saved recording is filed: move it into a personal folder (or to the
 * personal root with folderId null). Read-modify-writes the entry's meta +
 * summary on disk so its folderId persists, then best-effort syncs the new
 * folderId to the cloud (gated by the sync toggle). Only valid for entries that
 * exist on local disk (a cloud-only card has no meta here — the caller skips
 * those).
 *
 * Every "put this recording somewhere else" affordance goes through here — the
 * library card menu, the replay titlebar chip, the MCP move, the org sync path.
 * Keeps the loaded recording's own chip honest when it is the one moving.
 */
export async function setEntryFolder(id: string, folderId: string | null): Promise<void> {
  if (!isTauri()) return;
  const changed = await rewriteEntry(id, (meta) =>
    (meta.folderId ?? null) === folderId ? null : { ...meta, folderId },
  );
  if (!changed) return;
  const s = useStore.getState();
  if (s.loadedHistoryId === id) s.setReplayFolderId(folderId);
  log.info("history: entry folder set", { id, folderId });
  pushToCloud(id); // sync the new folderId (best-effort; gated by the sync toggle)
}

// ── Cross-window events ─────────────────────────────────────────────────────
//
// The History window is gone (#195): the recordings library is a route in the
// main window, so opening an entry is a direct loadHistoryEntry / loadOrgEntry
// call and needs no `history://open` round trip. What remains here is the
// broadcast that a saved entry CHANGED, which several surfaces still listen to.

/**
 * A stopped meeting that produced no report — too short for Rust to keep, or
 * nothing transcribed — has nowhere to go but its own cockpit, which is a dead
 * screen once the meeting is over (and, before the cockpit hold, a four-column
 * one). Go Home and say why, unless the user has already moved on: started
 * another meeting, or opened something else while the stop settled.
 */
export function leaveStoppedCockpit(reasonKey: "meeting.notSaved.tooShort" | "meeting.notSaved.noTranscript"): void {
  const s = useStore.getState();
  if (s.appMode !== "live" || isMeetingActive(s.meetingStatus)) return;
  s.openHome();
  notify.message(translate(s.settings.language, reasonKey));
}

/** Main-window listener: auto-save the meeting once Rust finishes encoding it,
 *  and release the titlebar "finalizing" state. saveLiveToHistory clears it
 *  itself the moment the report opens (its speaker correction and org share
 *  carry on in the background); the `finally` here is the backstop for every
 *  path that throws or returns before that — and Rust reporting the recording
 *  was discarded clears it too, so the spinner can't hang forever. */
export async function listenForRecordingSaved(): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  // Snapshot every meeting the moment it stops — before the encode, before
  // anything else can start — so its save never reads another meeting's state.
  const unsubscribeStops = useStore.subscribe((next, prev) => {
    if (!isMeetingActive(prev.meetingStatus) || !prev.liveMeetingId) return;
    if (next.meetingStatus === "stopped") {
      const snap = snapshotLiveMeeting();
      if (snap) liveSaves.capture(snap.id, snap);
    } else if (next.meetingStatus === "idle") {
      // Cancelled: nothing will be saved (Rust drops the journal too).
      liveSaves.forget(prev.liveMeetingId);
    }
  });
  const unlistenSaved = await listenEvent<RecordingSavedPayload>(RECORDING_SAVED_EVENT, (e) => {
    const { path, durationMs, meetingId, startedAtMs } = e.payload;
    const snap = liveSnapshotFor(meetingId, startedAtMs);
    saveLiveToHistory(path, durationMs, snap)
      .catch((err) => {
        log.error("history: live save failed", { id: snap.id, error: String(err) });
        // Stay on the cockpit (its transcript is the only copy left on screen)
        // but say so — a failed save used to look exactly like a slow one.
        const lang = useStore.getState().settings.language;
        notify.error(translate(lang, "meeting.notSaved.failed", { error: String(err) }));
      })
      .finally(() => {
        clearFinalizing();
        liveSaves.settle(snap.id);
      });
  });
  const unlistenDiscarded = await listenEvent<RecordingDiscardedPayload | null>(RECORDING_DISCARDED_EVENT, (e) => {
    const meetingId = e.payload?.meetingId;
    if (meetingId) liveSaves.settle(meetingId);
    clearFinalizing();
    // Only say so while the cockpit still shows that meeting.
    if (!meetingId || useStore.getState().liveMeetingId === meetingId) {
      leaveStoppedCockpit("meeting.notSaved.tooShort");
    }
  });
  return () => {
    unsubscribeStops();
    unlistenSaved();
    unlistenDiscarded();
  };
}

/** Save one recovered recording as a transcript-less entry — unless its entry
 *  already exists (the journal outlived the save). Returns whether it saved. */
async function saveRecovered(
  r: ipc.RecoveredRecording,
  alreadySaved: boolean,
  lang: Settings["language"],
): Promise<boolean> {
  if (alreadySaved) {
    await ipc.discardRecording({ path: r.path });
    return false;
  }
  const snap = orphanSnapshot(r.meetingId, r.startedAtMs);
  const dateLabel = new Date(snap.createdAt).toLocaleString(localeOf());
  const entry: HistoryEntry = {
    id: r.meetingId,
    title: `${translate(lang, "history.liveTitle")} · ${dateLabel}${translate(lang, "history.recoveredSuffix")}`,
    source: "live",
    createdAt: snap.createdAt,
    durationMs: r.durationMs,
    audio: "audio.ogg",
    folderId: snap.save.folderId,
    ...snap.analysis,
  };
  await persist(entry, r.path, /* compress */ false);
  log.warn("history: recovered an unfinished meeting", { id: r.meetingId, durationMs: r.durationMs });
  return true;
}

/** `meeting://recording-saved`: where the encoded recording landed, and which
 *  meeting it is (absent only from a backend that predates the field). */
interface RecordingSavedPayload {
  path: string;
  durationMs: number;
  meetingId?: string;
  startedAtMs?: number;
}

/** `meeting://recording-discarded`: which meeting produced nothing to keep. */
interface RecordingDiscardedPayload {
  meetingId?: string;
  startedAtMs?: number;
}

/**
 * Save the meetings that were still recording when Parley last died — a
 * crash, a quit, a force-quit — from the crash journals Rust kept on disk
 * (see recording_journal.rs). Their transcripts died with the page, so each is
 * saved as a recording to transcribe again. Run once at boot, after the
 * orphan check. Returns how many were saved.
 */
export async function recoverCrashedMeetings(): Promise<number> {
  if (!isTauri()) return 0;
  const found = await ipc.recoverMeetingJournals();
  if (found.length === 0) return 0;
  const existing = new Set((await listHistory()).map((e) => e.id));
  const lang = useStore.getState().settings.language;
  let saved = 0;
  for (const r of found) {
    try {
      if (await saveRecovered(r, existing.has(r.meetingId), lang)) saved++;
      await ipc.finishMeetingJournal({ meetingId: r.meetingId });
    } catch (error) {
      log.error("history: recovering an unfinished meeting failed", { id: r.meetingId, error: String(error) });
    }
  }
  if (saved > 0) notify.message(translate(lang, "meeting.recovered", { count: saved }));
  return saved;
}

/**
 * Persist a RE-ANALYSIS of a loaded history entry back to disk. Mounted ONCE in
 * the main window (App). Lives at module level — NOT in a component — so a
 * navigate-away right after re-analyzing can't cancel the pending write by
 * unmounting. Subscribes to the store and, when a re-run of the loaded entry
 * settles successfully, debounces a single overwrite (coalescing "re-analyze
 * all"'s analysis→action-items two-step into one write).
 *
 * Safety invariants:
 *  - A plain OPEN restores statuses to "done"/"idle", so `dirty` is set only by
 *    a real run → opening an entry never re-saves it. (An open CAN restore
 *    "running" — a stage still in flight from before the user left — and that
 *    is a real run, which this then persists like any other.)
 *  - A failed/partial pass (either status "error") is dropped, so it can't
 *    clobber a good saved result with truncated findings/action items.
 *  - The snapshot is captured WHEN THE TIMER ARMS (state still good). Navigating
 *    away flushes that captured snapshot, so the write can't pick up a store the
 *    transition has since cleared.
 */
export function initHistoryPersistSync(): UnlistenFn {
  if (!isTauri()) return () => {};
  let dirty = false; // a real re-run happened that still needs persisting
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { id: string; snapshot: AnalysisSnapshot } | null = null;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const reset = () => {
    clearTimer();
    dirty = false;
    pending = null;
  };
  const commit = () => {
    clearTimer();
    const p = pending;
    pending = null;
    dirty = false;
    if (!p) return;
    // If an upload save is still compressing/writing this entry, wait for it so the
    // file exists before we overwrite it (the re-analyze-during-compress race).
    Promise.resolve(uploadSaveInFlight)
      .catch((error) =>
        log.warn("history: upload save failed before re-analysis persist", {
          id: p.id,
          error: String(error),
        }),
      )
      .then(() => updateHistoryEntry(p.id, p.snapshot))
      .catch((e) => log.error("history: re-analysis save failed", { id: p.id, error: String(e) }));
  };

  return useStore.subscribe((state, prev) => {
    const id = state.loadedHistoryId;
    const a = state.analysisStatus;
    const ai = state.actionItemsStatus;
    // Cheap gate — ignore the frequent unrelated changes (playhead ticks, etc.).
    if (id === prev.loadedHistoryId && a === prev.analysisStatus && ai === prev.actionItemsStatus) {
      return;
    }

    // The loaded entry is changing (exit replay / load another / start meeting).
    // Flush a pending write for the OLD entry FIRST — its snapshot was captured
    // when armed, so the now-cleared store can't corrupt it — then drop state.
    if (prev.loadedHistoryId && prev.loadedHistoryId !== id) {
      if (pending && pending.id === prev.loadedHistoryId) commit();
      else reset();
    }

    if (!id) return reset();
    if (a === "running" || ai === "running") {
      dirty = true; // a real re-run is underway
      clearTimer();
      return;
    }
    if (a === "error" || ai === "error") return reset(); // never persist a failed/partial pass
    if (dirty && a === "done" && ai === "done") {
      // Both settled OK after a re-run → capture the good state NOW and debounce
      // one write (the "running" branch above cancels the timer mid-chain).
      clearTimer();
      pending = { id, snapshot: snapshotAnalysis() };
      timer = setTimeout(commit, 500);
    }
  });
}

/** Map the UI language to a `toLocaleString` locale tag. */
function localeOf(): string {
  return useStore.getState().settings.language === "en" ? "en-US" : "zh-TW";
}
