// Local meeting history: persist a finished session (recording + analysis) to
// disk and reload it into the replay UI later.
//
// Rust owns the files (see src-tauri/src/history.rs); this module owns the JSON
// shapes, builds entries from the live store, and turns a saved entry back into
// a replay session. Since #195 the library that lists these entries is a route
// in the main window, so opening one is a plain `loadHistoryEntry` call rather
// than a `history://open` message from a second window.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { toast } from "sonner";
import { useStore, speakerKey, hasSpokenSegment, isMeetingActive } from "../store";
import { readStudyCache, writeStudyCache } from "./studyCache";
import { companyFolderId, ensureCompanyFolder } from "../accounts/folders";
import { useAccounts } from "../accounts/store";
import { isTauri } from "../tauriEvents";
import { log } from "../log";
import { CLOUD_ENABLED } from "../flags";
import { markDirty } from "../cloud/syncState";
import { CLOUD_URL, cloudFetch, cloudToken, syncEnabled } from "../cloud/client";
import { deleteLocalFolder, emitFoldersUpdated, listLocalFolders } from "./folders";
import { deleteCloudFolder } from "../cloud/folders";
import { buildOwnershipIndex, ownerBackfill, planFolderDedupe } from "../library/scope";
import { rediarizeSegments } from "../speakers/postDiarize";
import { translate } from "../../i18n/messages";
import type { ReplaySession } from "../replay/types";
import type { TranscriptSegment } from "../types";
import type { HistoryEntry, HistoryEntrySummary } from "./types";

const HISTORY_UPDATED_EVENT = "history://updated";
const RECORDING_SAVED_EVENT = "meeting://recording-saved";
// Rust emits this instead of `recording-saved` when the stopped meeting produced
// no keepable recording (empty / too short / encode failed). Nothing is saved,
// so it exists only to release the titlebar's "finalizing" state.
const RECORDING_DISCARDED_EVENT = "meeting://recording-discarded";

// ── Build helpers ───────────────────────────────────────────────────────────

/** Distinct speaker count among spoken (non-empty) segments. */
function speakerCountOf(entry: HistoryEntry): number {
  const keys = new Set<string>();
  for (const s of entry.segments) if (s.text.trim()) keys.add(speakerKey(s));
  return keys.size;
}

/** First spoken line of the transcript (trimmed), for the card preview. */
function snippetOf(entry: HistoryEntry): string {
  const first = [...entry.segments]
    .filter((s) => s.isFinal && s.text.trim())
    .sort((a, b) => a.startMs - b.startMs)[0];
  const text = first?.text.trim() ?? "";
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

/** The lightweight card derived from a full entry (written to summary.json). */
export function buildSummary(entry: HistoryEntry): HistoryEntrySummary {
  return {
    id: entry.id,
    title: entry.title,
    source: entry.source,
    createdAt: entry.createdAt,
    durationMs: entry.durationMs,
    speakerCount: speakerCountOf(entry),
    findingsCount: entry.findings.length,
    actionItemsCount: entry.actionItems.length,
    hasAudio: entry.audio != null,
    snippet: snippetOf(entry),
    folderId: entry.folderId ?? null,
    companyId: entry.companyId ?? null,
  };
}

/** Snapshot the analysis-related slice of the store into a partial entry. */
function snapshotAnalysis() {
  const s = useStore.getState();
  return {
    segments: s.segments,
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
    companyId: s.meetingCompanyId,
    threadId: s.meetingThreadId,
    attendeePersonIds: s.meetingAttendeeIds,
    meetingBatna: s.meetingBatna,
    meetingTarget: s.meetingTarget,
    meetingFloor: s.meetingFloor,
    deliveryAssessment: s.deliveryAssessment,
    // Upload/loaded entries carry the measured pace on the replay session; a live
    // meeting has none here — saveLiveToHistory measures the recording + sets it.
    speechRateHz: s.replay?.speechRateHz ?? null,
    // Study outputs ride along so a plain save/overwrite never drops them. A live
    // save records the type the live board ran with; replay uses the per-entry one.
    brief: s.brief,
    intel: s.intel,
    meetingType: s.meetingType,
  };
}

/** Measure a recording's articulation rate (syllables/sec) via Rust; null on any
 *  failure. Same DSP quantity the upload path computes. For live saves this is
 *  only a FALLBACK for mic-only recordings — the primary source is the mic-derived
 *  session rate (store.micSessionRateHz), which never includes the other side. */
async function measureRecordingRate(path: string): Promise<number | null> {
  if (!isTauri()) return null;
  try {
    const hz = await invoke<number>("measure_audio_speech_rate", { path });
    return hz > 0 ? hz : null;
  } catch (e) {
    log.warn("history: live speech-rate measure failed", { error: String(e) });
    return null;
  }
}

/** The analysis slice captured by {@link snapshotAnalysis} (passed to a deferred save). */
export type AnalysisSnapshot = ReturnType<typeof snapshotAnalysis>;

/** Whether the current transcript has any spoken content worth saving. */
function hasSpokenTranscript(): boolean {
  return hasSpokenSegment(useStore.getState().segments);
}

/** Persist an entry: write meta + summary and place the audio. */
async function persist(
  entry: HistoryEntry,
  audioSourcePath: string | null,
  compress: boolean,
): Promise<void> {
  await invoke("save_history_entry", {
    id: entry.id,
    summaryJson: JSON.stringify(buildSummary(entry)),
    metaJson: JSON.stringify(entry),
    audioSourcePath,
    compress,
  });
  log.info("history: entry saved", { id: entry.id, source: entry.source });
  // Best-effort push to the cloud when signed in (dynamic import avoids a static
  // cycle: sync.ts imports buildSummary/listHistory from here). No-op when signed out.
  pushToCloud(entry.id).catch((error) =>
    log.warn("history: cloud push failed", { id: entry.id, error: String(error) }),
  );
}

/** Fire-and-forget cloud push (gated by the sync toggle); save paths stay simple. */
async function pushToCloud(id: string): Promise<void> {
  // Content changed → flag dirty even when sync is off, so flipping sync ON later
  // makes the background sweep push this entry. pushLocalEntry clears dirty on a
  // confirmed push.
  markDirty(id);
  // Sync toggle off (or signed out / OSS) → don't push now; the sweep handles it
  // when sync is turned on. This is the save-time half of the syncEnabled chokepoint.
  if (!syncEnabled()) return;
  const sync = await import("../cloud/sync");
  await sync.pushLocalEntrySafe(id);
}

// ── Save location ─────────────────────────────────────────────────────────────

/** What saving this meeting will do: where the local entry files, and whether
 *  an org gets an auto-shared copy. */
export interface MeetingSaveTarget {
  folderId: string | null;
  autoShare: { orgId: string; folderId: string | null } | null;
  fallback: "syncOff" | null;
  /** "company" = filed under the linked customer; "default" = no customer. */
  origin: "company" | "default";
}

/** The per-meeting org-share choice. `null` follows the settings default;
 *  `"off"` suppresses a default share for this one meeting. */
export type MeetingShare = { orgId: string; folderId: string | null } | "off" | null;

/**
 * THE one place that answers "what does saving this meeting do?".
 *
 * Filing is not a choice anymore (#211): the linked customer's folder, or the
 * personal root when there is no customer. The only real decision left is
 * whether an org gets a shared copy — per-meeting choice first, else the
 * settings default — and that decision is INDEPENDENT of the customer link.
 * The old model let a "save somewhere else" override beat the company link,
 * which silently unfiled the customer's own recording; there is no override
 * to express that mistake with now.
 *
 * Exported so pre-flight displays exactly what the save will do.
 */
export function resolveMeetingSave(): MeetingSaveTarget {
  const s = useStore.getState();
  const companyFolder = companyFolderId(s.meetingCompanyId);
  const base: MeetingSaveTarget = {
    folderId: companyFolder,
    autoShare: null,
    fallback: null,
    origin: companyFolder ? "company" : "default",
  };

  let wanted: { orgId: string; folderId: string | null } | null = null;
  if (s.meetingOrgShare === "off") {
    wanted = null;
  } else if (s.meetingOrgShare) {
    wanted = s.meetingOrgShare;
  } else {
    const def = s.settings.defaultSaveLocation;
    if (def.scope === "org" && def.orgId) {
      wanted = { orgId: def.orgId, folderId: def.folderId ?? null };
    }
  }
  if (!wanted) return base;
  // An org share needs the cloud edition, signed in, sync on.
  if (!CLOUD_ENABLED || !syncEnabled()) return { ...base, fallback: "syncOff" };
  return { ...base, autoShare: wanted };
}

/** After a save, auto-share into the default org folder — or toast why it fell back. */
async function applyDefaultOrgShare(id: string, res: MeetingSaveTarget): Promise<void> {
  const lang = useStore.getState().settings.language;
  if (res.fallback === "syncOff") {
    toast.message(translate(lang, "history.defaultSave.orgNeedsSync"));
    return;
  }
  if (!res.autoShare || !CLOUD_ENABLED) return;
  try {
    const m = await import("../cloud/sync");
    await m.shareRecordingToOrg(id, res.autoShare.orgId, res.autoShare.folderId);
  } catch (e) {
    log.error("history: org auto-share failed", { id, error: String(e) });
    toast.error(translate(lang, "history.defaultSave.orgShareFailed"));
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
 * Auto-save a finished LIVE meeting once Rust reports the encoded recording.
 * No-op when the meeting produced no transcript (e.g. started + stopped at once).
 */
export async function saveLiveToHistory(audioTempPath: string, durationMs: number): Promise<void> {
  if (!isTauri()) return;
  if (!hasSpokenTranscript()) {
    // Nothing was transcribed — almost certainly an accidental Start/Stop. Don't
    // save a history entry, and discard the encoded temp recording so it doesn't
    // orphan in the temp dir (an entry would normally consume it on save).
    log.info("history: live save skipped (no transcript)");
    await invoke("discard_recording", { path: audioTempPath }).catch((error) =>
      log.warn("history: discard empty live recording failed", {
        path: audioTempPath,
        error: String(error),
      }),
    );
    return;
  }
  const s = useStore.getState();
  const createdAt = s.meetingStartedAt ?? Date.now();
  const dateLabel = new Date(createdAt).toLocaleString(localeOf());
  // Mic-only measured pace (issue #22): prefer the whole-session articulation rate
  // the live prosody tap accumulated from the user's OWN mic. Only fall back to
  // measuring the saved file when the mic rate is missing AND the file can't
  // contain the other side — in diarized meetings the recording is the mic+system
  // MIX, and measuring it would fold the counterpart's pace into the number.
  const micOnlyRecording = !s.segments.some((seg) => seg.source === "mix");
  const speechRateHz =
    s.micSessionRateHz ?? (micOnlyRecording ? await measureRecordingRate(audioTempPath) : null);
  const save = resolveMeetingSave();
  log.info("history: live save destination", { origin: save.origin, folderId: save.folderId });
  const entry: HistoryEntry = {
    id: crypto.randomUUID(),
    title: `${translate(s.settings.language, "history.liveTitle")} · ${dateLabel}`,
    source: "live",
    createdAt,
    durationMs,
    audio: "audio.ogg",
    folderId: save.folderId,
    ...snapshotAnalysis(),
    speechRateHz,
  };
  await persist(entry, audioTempPath, /* compress */ false);
  // With the recording now on disk, fix the provider's drifted speaker labels
  // from the audio BEFORE the org copy is made, so a shared copy isn't stale.
  // Best-effort: any failure keeps the provider labels.
  await applyPostSaveDiarization(entry).catch((e) =>
    log.warn("history: post-save re-diarization failed", { id: entry.id, error: String(e) }),
  );
  await applyDefaultOrgShare(entry.id, save);
  // 會後 60 秒: a meeting's natural ending is its debrief — slide straight into
  // the study tense (landing on the report), unless the user already started
  // another meeting or opened a different recording in the meantime.
  const now = useStore.getState();
  if (!isMeetingActive(now.meetingStatus) && now.appMode === "live") {
    now.setStudyTab("report");
    await loadHistoryEntry(entry.id).catch((e) =>
      log.warn("history: auto-open after stop failed", { id: entry.id, error: String(e) }),
    );
  }
}

/**
 * After a live save: re-derive the speakers from the recording's AUDIO and patch
 * the just-saved entry. Provider streaming diarization drifts over long meetings
 * (swapped labels, spurious late speakers); the on-device voice pipeline fixes
 * that once the full recording exists, remapping the new clusters onto the
 * provider's numbering so names assigned during the meeting stay attached (see
 * postDiarize.ts). No-op for mic-only meetings and when nothing changes.
 */
async function applyPostSaveDiarization(entry: HistoryEntry): Promise<void> {
  const { audioPath } = await invoke<HistoryReadResult>("read_history_entry", { id: entry.id });
  if (!audioPath) return;
  const result = await rediarizeSegments(entry.segments, audioPath);
  if (!result) return;

  const updated: HistoryEntry = { ...entry, segments: result.segments };
  await invoke("save_history_entry", {
    id: entry.id,
    summaryJson: JSON.stringify(buildSummary(updated)),
    metaJson: JSON.stringify(updated),
    audioSourcePath: null, // leave the recording untouched
    compress: false,
  });
  await emitHistoryUpdated(entry.id);
  pushToCloud(entry.id); // refresh the cloud copy with the corrected labels

  // The finished meeting is usually still on screen — retag those lines too.
  // Live segment ids REPEAT across sessions ("mix-0", "mix-1", …), so an id
  // match alone could hit a different meeting's lines. Only touch the store
  // when it provably still shows THIS meeting: the just-ended live session
  // (same start timestamp) or this very entry re-opened from history.
  const st = useStore.getState();
  const showsThisMeeting =
    st.loadedHistoryId === entry.id ||
    (st.appMode === "live" && st.loadedHistoryId === null && st.meetingStartedAt === entry.createdAt);
  if (showsThisMeeting) {
    const bySegId = new Map(result.segments.map((s) => [s.id, s.speaker]));
    useStore.setState({
      segments: st.segments.map((s) => {
        const sp = bySegId.get(s.id);
        return sp === undefined || sp === s.speaker ? s : { ...s, speaker: sp };
      }),
    });
    toast.message(translate(st.settings.language, "speakers.postRefined"));
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
  /** Explicit company pre-link from a company import door (R7); null = none. */
  companyId: string | null;
}

/**
 * Save an imported PLAIN-TEXT transcript as a normal history entry (design doc
 * D11: source "upload", audio null — replay's audio-less degradation already
 * handles it). Unlike {@link saveUploadToHistory} this never snapshots the live
 * store: a bulk import must not inherit whatever meeting context/company the
 * store happens to hold — a company link arrives only as the EXPLICIT
 * `save.companyId` a company import door passed. Saved with `analyzed: false`
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
    companyId: save.companyId,
  };
  await persist(entry, null, /* compress */ false);
  // The import usually starts FROM the History window — tell its grid to re-list.
  await emitHistoryUpdated(entry.id).catch(() => {});
  return entry.id;
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
  const { meta } = await invoke<HistoryReadResult>("read_history_entry", { id });
  const updated: HistoryEntry = { ...meta, ...analysis };
  await invoke("save_history_entry", {
    id,
    summaryJson: JSON.stringify(buildSummary(updated)),
    metaJson: JSON.stringify(updated),
    audioSourcePath: null,
    compress: false,
  });
  await emitHistoryUpdated(id);
  pushToCloud(id); // re-analysis → refresh the cloud copy too (best-effort)
  log.info("history: entry analysis overwritten", { id, findings: updated.findings.length });
}

/**
 * Persist the loaded entry's STUDY OUTPUTS (brief, intel, meeting type, and a
 * legacy entry's recomputed delivery assessment) without touching the rest of
 * its analysis. Called right after each output finishes generating, so a
 * recording pays for each generation exactly once. Store-null outputs keep the
 * on-disk value (a brief finishing must not clobber a saved intel, and vice
 * versa). A READ-ONLY org recording can't be written back — its outputs go into
 * the local study cache instead, so anything that ran is still stored and
 * reopening never re-spends it. No-op when nothing is loaded (live meeting /
 * fresh upload — their save paths snapshot these fields anyway).
 */
export async function persistStudyOutputs(): Promise<void> {
  const s = useStore.getState();
  const id = s.loadedHistoryId;
  if (s.replayReadOnly && s.replay?.id) {
    writeStudyCache(s.replay.id, {
      findings: s.findings,
      actionItems: s.actionItems,
      analyzed: s.analysisStatus === "done" && s.actionItemsStatus === "done",
      brief: s.brief,
      intel: s.intel,
      deliveryAssessment: s.deliveryAssessment,
      meetingType: s.meetingType,
    });
    log.info("history: study outputs cached (read-only entry)", { id: s.replay.id });
    return;
  }
  if (!isTauri() || !id) return;
  // An upload's initial save may still be compressing — wait so the entry exists.
  await Promise.resolve(uploadSaveInFlight).catch(() => {});
  const { meta } = await invoke<HistoryReadResult>("read_history_entry", { id });
  const updated: HistoryEntry = {
    ...meta,
    brief: s.brief ?? meta.brief ?? null,
    intel: s.intel ?? meta.intel ?? null,
    meetingType: s.meetingType,
    deliveryAssessment: s.deliveryAssessment ?? meta.deliveryAssessment ?? null,
  };
  await invoke("save_history_entry", {
    id,
    summaryJson: JSON.stringify(buildSummary(updated)),
    metaJson: JSON.stringify(updated),
    audioSourcePath: null, // leave the recording untouched
    compress: false,
  });
  pushToCloud(id);
  log.info("history: study outputs saved", {
    id,
    brief: !!updated.brief,
    intel: !!updated.intel,
    meetingType: updated.meetingType,
  });
}

/**
 * Persist the loaded entry's ACCOUNTS LINK (company/thread/attendees) — the
 * study report's after-the-fact "掛上公司/戰線". Same read-modify-write as
 * {@link persistStudyOutputs}: only the link fields are patched, so a
 * concurrently generating brief/intel can't be clobbered by a stale snapshot.
 * The rewritten summary.json carries the new companyId, which is what the
 * company page's meeting timeline and the library tree filter on. No-op for
 * read-only org recordings (someone else's entry) and when nothing is loaded.
 */
export async function persistEntryLink(): Promise<void> {
  const s = useStore.getState();
  const id = s.loadedHistoryId;
  if (!isTauri() || !id || s.replayReadOnly) return;
  // An upload's initial save may still be compressing — wait so the entry exists.
  await Promise.resolve(uploadSaveInFlight).catch(() => {});
  const { meta } = await invoke<HistoryReadResult>("read_history_entry", { id });
  const updated: HistoryEntry = {
    ...meta,
    companyId: s.meetingCompanyId,
    threadId: s.meetingThreadId,
    attendeePersonIds: s.meetingAttendeeIds,
    // The link decides the filing location too. Writing companyId alone is what
    // used to strand a recording: the company page listed it while the tree —
    // which counted folders — left it in 未歸戶 forever.
    folderId: folderForCompany(s.meetingCompanyId, meta.folderId ?? null),
  };
  await invoke("save_history_entry", {
    id,
    summaryJson: JSON.stringify(buildSummary(updated)),
    metaJson: JSON.stringify(updated),
    audioSourcePath: null, // leave the recording untouched
    compress: false,
  });
  useStore.getState().setReplayFolderId(updated.folderId ?? null);
  await emitHistoryUpdated(id); // library / company timeline re-list on the new companyId
  pushToCloud(id); // sync the new link (best-effort; gated by the sync toggle)
  log.info("history: entry link saved", {
    id,
    companyId: updated.companyId ?? null,
    folderId: updated.folderId ?? null,
  });
}

/**
 * Where a recording owned by `companyId` lives on disk: the company's paired
 * folder, created on demand. Unlinking drops it to the personal root — UNLESS
 * the current folder belongs to no company, in which case that folder is the
 * user's own filing and survives the unlink.
 */
function folderForCompany(companyId: string | null, currentFolderId: string | null): string | null {
  if (companyId) {
    const company = useAccounts.getState().companies.find((c) => c.id === companyId);
    return company ? ensureCompanyFolder(company) : currentFolderId;
  }
  const ownedByAnyCompany = useAccounts
    .getState()
    .companies.some((c) => c.folderId && c.folderId === currentFolderId);
  return ownedByAnyCompany ? null : currentFolderId;
}

/**
 * THE way a saved recording changes hands — used by every "歸給哪個客戶"
 * affordance (the library card menu, the study titlebar chip, the MCP move).
 *
 * companyId and folderId move together, always. Before #211 they were two
 * independent writes: linking wrote only the company, refiling wrote only the
 * folder, and whichever one the user reached for decided which HALF of the app
 * would know about it. There is no way to write one without the other now.
 */
export async function assignEntryCompany(id: string, companyId: string | null): Promise<void> {
  if (!isTauri()) return;
  const { meta } = await invoke<HistoryReadResult>("read_history_entry", { id });
  if ((meta.companyId ?? null) === companyId) return;
  const updated: HistoryEntry = {
    ...meta,
    companyId,
    // A thread and its attendees belong to the OLD customer — carrying them
    // across would file this call under a deal it was never part of.
    threadId: null,
    attendeePersonIds: [],
    folderId: folderForCompany(companyId, meta.folderId ?? null),
  };
  await invoke("save_history_entry", {
    id,
    summaryJson: JSON.stringify(buildSummary(updated)),
    metaJson: JSON.stringify(updated),
    audioSourcePath: null, // leave the recording untouched
    compress: false,
  });
  // The loaded recording is looking at this entry — keep its chips honest.
  const s = useStore.getState();
  if (s.loadedHistoryId === id) {
    s.setReplayFolderId(updated.folderId ?? null);
    s.setMeetingLink({ companyId, threadId: null, attendeeIds: [] });
  }
  await emitHistoryUpdated(id);
  pushToCloud(id); // best-effort; gated by the sync toggle
  log.info("history: entry company assigned", {
    id,
    companyId,
    folderId: updated.folderId ?? null,
  });
}

// ── List / read / delete ─────────────────────────────────────────────────────

/** All saved summaries, newest first. */
export async function listHistory(): Promise<HistoryEntrySummary[]> {
  if (!isTauri()) return [];
  const raw = await invoke<string[]>("list_history");
  const summaries: HistoryEntrySummary[] = [];
  for (const s of raw) {
    try {
      summaries.push(JSON.parse(s) as HistoryEntrySummary);
    } catch {
      // Skip a corrupt summary.json rather than failing the whole list.
    }
  }
  return summaries.sort((a, b) => b.createdAt - a.createdAt);
}

/** Rename an entry (patches the title in meta + summary). */
export async function renameHistoryEntry(id: string, title: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("rename_history_entry", { id, title: title.trim() });
  log.info("history: entry renamed", { id });
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
 * Move a personal entry into a folder (or to the personal root with folderId null).
 * Read-modify-writes the entry's meta + summary on disk so its folderId persists,
 * then best-effort syncs the new folderId to the cloud (gated by the sync toggle).
 * Only valid for entries that exist on local disk (a cloud-only card has no meta
 * here — the caller skips those).
 *
 * This is the DISK LOCATION only. If the destination is a company's folder, the
 * customer is changing — call {@link assignEntryCompany} instead, which writes
 * both halves. Legitimate callers: legacy (company-less) folders and the org
 * sync path.
 */
export async function setEntryFolder(id: string, folderId: string | null): Promise<void> {
  if (!isTauri()) return;
  const { meta } = await invoke<HistoryReadResult>("read_history_entry", { id });
  const updated: HistoryEntry = { ...meta, folderId };
  await invoke("save_history_entry", {
    id,
    summaryJson: JSON.stringify(buildSummary(updated)),
    metaJson: JSON.stringify(updated),
    audioSourcePath: null, // leave the recording untouched
    compress: false,
  });
  log.info("history: entry folder set", { id, folderId });
  pushToCloud(id); // sync the new folderId (best-effort; gated by the sync toggle)
}

/**
 * Upgrade dedupe (#211 follow-up): merge same-name personal folder twins.
 *
 * The plan comes from {@link planFolderDedupe} (see its comment for how the
 * twins came to exist). This applies it: repoint every recording filed in a
 * twin onto the survivor, delete the twins locally, and delete them in the
 * cloud so the mirror-down in reloadFolders doesn't resurrect them next
 * launch. When sync is off the cloud delete no-ops and the twins WILL come
 * back from the mirror after sign-in — which is fine, because this runs every
 * startup and converges the next time around.
 *
 * Runs after the company↔folder pairing (the survivor prefers the paired
 * folder) and before the owner backfill (which should see the merged mapping).
 * Like the backfill: idempotent, no flag, no cloud push of entries (a push
 * re-uploads audio).
 */
export async function migrateDuplicateFolders(): Promise<number> {
  if (!isTauri()) return 0;
  const merges = planFolderDedupe(listLocalFolders(), useAccounts.getState().companies);
  if (!merges.length) return 0;
  const survivorOf = new Map<string, string>();
  for (const m of merges) for (const twin of m.twinIds) survivorOf.set(twin, m.canonicalId);

  let moved = 0;
  try {
    for (const summary of await listHistory()) {
      const target = summary.folderId ? survivorOf.get(summary.folderId) : undefined;
      if (!target) continue;
      try {
        const { meta } = await invoke<HistoryReadResult>("read_history_entry", {
          id: summary.id,
        });
        const updated: HistoryEntry = { ...meta, folderId: target };
        await invoke("save_history_entry", {
          id: summary.id,
          summaryJson: JSON.stringify(buildSummary(updated)),
          metaJson: JSON.stringify(updated),
          audioSourcePath: null, // leave the recording untouched
          compress: false,
        });
        moved++;
      } catch (e) {
        log.warn("history: folder dedupe failed for entry", {
          id: summary.id,
          error: String(e),
        });
      }
    }
  } catch (e) {
    log.warn("history: folder dedupe sweep failed", { error: String(e) });
    return moved;
  }

  // Recordings are safely off the twins — now the twins can go.
  for (const [twin] of survivorOf) {
    deleteLocalFolder(twin);
    if (CLOUD_ENABLED) {
      deleteCloudFolder(twin).catch((e) =>
        log.warn("history: twin folder cloud delete failed", { twin, error: String(e) })
      );
    }
  }
  await emitFoldersUpdated().catch(() => {});
  if (moved) await emitHistoryUpdated();
  log.info("history: folder dedupe complete", {
    merged: merges.map((m) => ({ name: m.name, twins: m.twinIds.length })),
    movedRecordings: moved,
  });
  return moved;
}

/**
 * Upgrade backfill (#211): write `companyId` onto recordings that only the
 * folder fallback can place.
 *
 * Who this is for: everything saved before a recording could be linked to a
 * customer at all. Those entries sit in a folder that a company has since
 * adopted (accounts/folders.ensureCompanyFolder adopts a same-named folder), so
 * the tree already shows them under that customer — but the field is still
 * empty, and anything reading the record directly (the cloud summary row, an
 * MCP client, the post-meeting review) goes on seeing an unowned recording.
 *
 * Runs at startup, right after the company↔folder pairing. Deliberately NOT
 * flag-guarded: it is idempotent and self-limiting — once there are no
 * candidates it costs one `list_history` call, and a flag in localStorage would
 * be per-webview-origin anyway (see history/folders.ts on that exact trap).
 * Emits ONE history-updated at the end rather than one per entry.
 */
export async function migrateEntryOwners(): Promise<number> {
  if (!isTauri()) return 0;
  const { companies } = useAccounts.getState();
  if (!companies.length) return 0;
  const idx = buildOwnershipIndex(companies, listLocalFolders());
  let migrated = 0;
  try {
    for (const summary of await listHistory()) {
      const companyId = ownerBackfill(summary, idx);
      if (!companyId) continue;
      try {
        const { meta } = await invoke<HistoryReadResult>("read_history_entry", {
          id: summary.id,
        });
        // Re-check against the META: the summary can lag a link written by an
        // older build that didn't rewrite summary.json.
        if (meta.companyId) continue;
        const updated: HistoryEntry = { ...meta, companyId };
        await invoke("save_history_entry", {
          id: summary.id,
          summaryJson: JSON.stringify(buildSummary(updated)),
          metaJson: JSON.stringify(updated),
          audioSourcePath: null, // leave the recording untouched
          compress: false,
        });
        // Deliberately NOT pushed. A push re-uploads the entry's audio blob
        // (cloud/sync.pushLocalEntryNow), so a library with hundreds of old
        // recordings would re-upload all of them at launch — and the field
        // buys the cloud nothing today, because companies live in the local
        // accounts.json and never sync. The next real edit to the entry
        // carries it up.
        migrated++;
      } catch (e) {
        // One unreadable entry must not stop the sweep.
        log.warn("history: owner backfill failed for entry", {
          id: summary.id,
          error: String(e),
        });
      }
    }
  } catch (e) {
    log.warn("history: owner backfill sweep failed", { error: String(e) });
    return migrated;
  }
  if (migrated) {
    await emitHistoryUpdated();
    log.info("history: owner backfill complete", { migrated });
  }
  return migrated;
}

/** Delete one entry's folder. */
export async function deleteHistoryEntry(id: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("delete_history_entry", { id });
  log.info("history: entry deleted", { id });
}

/** Shape returned by the Rust `read_history_entry` command. */
interface HistoryReadResult {
  meta: HistoryEntry;
  audioPath: string | null;
}

/**
 * Read a saved entry and load it into the replay UI (restoring its analysis), then
 * focus the main window. Called by the main-window listener on `history://open`.
 */
export async function loadHistoryEntry(id: string): Promise<void> {
  const { meta, audioPath } = await invoke<HistoryReadResult>("read_history_entry", { id });
  const audioSrc = audioPath ? convertFileSrc(audioPath) : "";
  const session: ReplaySession = {
    id: meta.id,
    name: meta.title,
    audioPath: audioPath ?? "",
    audioSrc,
    durationMs: meta.durationMs,
    audioOffsetMs: 0,
    createdAt: meta.createdAt,
    segments: meta.segments,
    speakerNames: meta.speakerNames,
    speechRateHz: meta.speechRateHz ?? null,
  };
  useStore.getState().loadHistory(meta, session);
  log.info("history: entry loaded", { id, hasAudio: !!audioPath });
  if (isTauri()) {
    try {
      await getCurrentWindow().setFocus();
    } catch (e) {
      log.warn("history: focus main window failed", { error: String(e) });
    }
  }
}

/**
 * Load an ORG (cloud-shared) recording into replay WITHOUT persisting it to the
 * local history dir — org recordings must never pollute the personal list. The
 * full entry (transcript + analysis) comes over HTTP; the audio is streamed to a
 * temp cache file by Rust (`download_remote_audio`). Loaded read-only so the
 * re-analysis-persist subscription leaves someone else's shared recording alone.
 */
export async function loadOrgEntry(orgId: string, id: string): Promise<void> {
  const base = `/orgs/${encodeURIComponent(orgId)}/recordings/${encodeURIComponent(id)}`;
  const meta = (await (await cloudFetch(`${base}/meta`)).json()) as HistoryEntry;
  // Server meta shapes vary across versions — never trust the arrays to exist.
  meta.findings ??= [];
  meta.actionItems ??= [];
  // Fold locally-cached study outputs over the fetched meta (read-only entries
  // persist there instead of back to the org) so restored outputs load as
  // "done" and the pipeline doesn't re-spend a generation. The shared entry's
  // own saved GENERATED outputs win — the cache only fills what the org copy
  // lacks. The meeting TYPE is the opposite: it's the viewer's own study
  // choice, so their cached pick beats the owner's.
  const cached = readStudyCache(id);
  if (cached) {
    if (!meta.findings.length && cached.findings?.length) meta.findings = cached.findings;
    if (!meta.actionItems.length && cached.actionItems?.length) meta.actionItems = cached.actionItems;
    // The VIEWER's own completed pass also counts as analyzed — a clean-empty
    // result must restore as done here too, or every open re-spends it.
    if (cached.analyzed) meta.analyzed = true;
    meta.brief = meta.brief ?? cached.brief ?? null;
    meta.intel = meta.intel ?? cached.intel ?? null;
    meta.deliveryAssessment = meta.deliveryAssessment ?? cached.deliveryAssessment ?? null;
    meta.meetingType = cached.meetingType ?? meta.meetingType;
  }
  let audioPath = "";
  const t = cloudToken();
  if (meta.audio && t) {
    audioPath = await invoke<string>("download_remote_audio", {
      id,
      url: `${CLOUD_URL}${base}/audio`,
      token: t,
    });
  }
  const audioSrc = audioPath ? convertFileSrc(audioPath) : "";
  const session: ReplaySession = {
    id: meta.id,
    name: meta.title,
    audioPath,
    audioSrc,
    durationMs: meta.durationMs,
    audioOffsetMs: 0,
    createdAt: meta.createdAt,
    segments: meta.segments,
    speakerNames: meta.speakerNames,
    speechRateHz: meta.speechRateHz ?? null,
  };
  useStore.getState().loadHistory(meta, session, { readOnly: true });
  log.info("history: org entry loaded", { orgId, id, hasAudio: !!audioPath });
  if (isTauri()) {
    try {
      await getCurrentWindow().setFocus();
    } catch (e) {
      log.warn("history: focus main window failed", { error: String(e) });
    }
  }
}

// ── Cross-window events ─────────────────────────────────────────────────────
//
// The History window is gone (#195): the recordings library is a route in the
// main window, so opening an entry is a direct loadHistoryEntry / loadOrgEntry
// call and needs no `history://open` round trip. What remains here is the
// broadcast that a saved entry CHANGED, which several surfaces still listen to.

/** Main-window listener: auto-save the meeting once Rust finishes encoding it,
 *  and release the titlebar "finalizing" state when the save settles — or when
 *  Rust reports the recording was discarded (so the spinner can't hang forever). */
export async function listenForRecordingSaved(): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  const clearFinalizing = () => useStore.getState().setFinalizingMeeting(false);
  const unlistenSaved = await listen<{ path: string; durationMs: number }>(RECORDING_SAVED_EVENT, (e) => {
    saveLiveToHistory(e.payload.path, e.payload.durationMs)
      .catch((err) => log.error("history: live save failed", { error: String(err) }))
      .finally(clearFinalizing);
  });
  const unlistenDiscarded = await listen(RECORDING_DISCARDED_EVENT, clearFinalizing);
  return () => {
    unlistenSaved();
    unlistenDiscarded();
  };
}

/** Tell other windows (the History grid) that an entry's saved analysis changed. */
export async function emitHistoryUpdated(id?: string): Promise<void> {
  if (!isTauri()) return;
  await emit(HISTORY_UPDATED_EVENT, { id });
}

/** History-window listener: re-list after the main window overwrites an entry. */
export async function listenForHistoryUpdated(onUpdated: (id: string) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<{ id: string }>(HISTORY_UPDATED_EVENT, (e) => onUpdated(e.payload.id));
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
 *  - A plain OPEN restores statuses straight to "done" (never "running"), so
 *    `dirty` is set only by a real re-run → opening an entry never re-saves it.
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
