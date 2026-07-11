// Local meeting history: persist a finished session (recording + analysis) to
// disk and reload it into the replay UI later.
//
// Rust owns the files (see src-tauri/src/history.rs); this module owns the JSON
// shapes, builds entries from the live store, and drives the cross-window flow:
// the History window lists summaries and emits `history://open <id>`; the main
// window listens, reads the entry, and loads it into replay.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { toast } from "sonner";
import { useStore, speakerKey } from "../store";
import { isTauri } from "../tauriEvents";
import { log } from "../log";
import { CLOUD_ENABLED } from "../flags";
import { markDirty } from "../cloud/syncState";
import { CLOUD_URL, cloudFetch, cloudToken, syncEnabled } from "../cloud/client";
import { listLocalFolders } from "./folders";
import { rediarizeSegments } from "../speakers/postDiarize";
import { translate } from "../../i18n/messages";
import type { ReplaySession } from "../replay/types";
import type { HistoryEntry, HistoryEntrySummary } from "./types";

const HISTORY_OPEN_EVENT = "history://open";
const HISTORY_OPEN_ORG_EVENT = "history://open-org";
const HISTORY_UPDATED_EVENT = "history://updated";
const RECORDING_SAVED_EVENT = "meeting://recording-saved";

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
  return useStore.getState().segments.some((s) => s.isFinal && s.text.trim());
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

// ── Default save location ─────────────────────────────────────────────────────

/**
 * Resolve where a finished meeting should be saved, per the user's default-save
 * setting + the org-default guard. The LOCAL entry always lands in a personal
 * folder (or the personal root): when the default targets an org, the local copy
 * stays at the personal root and the org gets an auto-shared COPY afterward (so the
 * user never loses their own recording). On any guard miss (org default but signed
 * out / sync off / not the cloud edition) we fall back to the personal root and
 * report it so the caller can surface a toast.
 */
function resolveDefaultSave(): {
  folderId: string | null;
  autoShare: { orgId: string; folderId: string | null } | null;
  fallback: "syncOff" | null;
} {
  const loc = useStore.getState().settings.defaultSaveLocation;
  if (!loc || loc.scope === "personal") {
    const fid = loc?.folderId ?? null;
    // A personal folder deleted since it was chosen → save at the root (orphan→root).
    if (fid && !listLocalFolders().some((f) => f.id === fid)) {
      return { folderId: null, autoShare: null, fallback: null };
    }
    return { folderId: fid, autoShare: null, fallback: null };
  }
  // scope === "org": needs the cloud edition, signed in, sync on.
  if (!CLOUD_ENABLED || !loc.orgId || !syncEnabled()) {
    return { folderId: null, autoShare: null, fallback: loc.orgId ? "syncOff" : null };
  }
  return { folderId: null, autoShare: { orgId: loc.orgId, folderId: loc.folderId ?? null }, fallback: null };
}

/** After a save, auto-share into the default org folder — or toast why it fell back. */
async function applyDefaultOrgShare(
  id: string,
  res: ReturnType<typeof resolveDefaultSave>,
): Promise<void> {
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
  const save = resolveDefaultSave();
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
  // the study tense (landing on 重點), unless the user already started another
  // meeting or opened a different recording in the meantime.
  const now = useStore.getState();
  if (now.meetingStatus !== "recording" && now.appMode === "live") {
    now.setStudyTab("brief");
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
  const save = resolveDefaultSave();
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
}

/**
 * Move a personal entry into a folder (or to the personal root with folderId null).
 * Read-modify-writes the entry's meta + summary on disk so its folderId persists,
 * then best-effort syncs the new folderId to the cloud (gated by the sync toggle).
 * Only valid for entries that exist on local disk (a cloud-only card has no meta
 * here — the caller skips those).
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

// ── History window + cross-window events ─────────────────────────────────────

/** Open (or focus) the dedicated History window (`#history` route). */
export async function openHistoryWindow(): Promise<void> {
  if (!isTauri()) {
    window.location.hash = "history";
    return;
  }
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel("history");
  log.info("history: open window", { existing: !!existing });
  if (existing) {
    await existing.setFocus();
    return;
  }
  const win = new WebviewWindow("history", {
    url: "index.html#history",
    title: "Parley History",
    width: 960,
    height: 680,
    minWidth: 720,
    minHeight: 480,
    resizable: true,
    // The folder sidebar uses HTML5 drag-and-drop (drag a card onto a folder). Tauri's
    // native OS drag-drop handler is ON by default and SWALLOWS the webview's dragover/
    // drop events, so without this the drop zones never highlight and nothing moves.
    // This window has no OS file-drop needs (uploads happen in the main window), so it's
    // safe to hand drag-drop to the webview.
    dragDropEnabled: false,
  });
  win.once("tauri://error", (e) => log.error("history: window error", { error: String(e) }));
}

/** From the History window: ask the main window to load an entry. */
export async function emitHistoryOpen(id: string): Promise<void> {
  if (!isTauri()) return;
  await emit(HISTORY_OPEN_EVENT, { id });
}

/** Main-window listener: load the entry requested by the History window. */
export async function listenForHistoryOpen(): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<{ id: string }>(HISTORY_OPEN_EVENT, (e) => {
    loadHistoryEntry(e.payload.id).catch((err) =>
      log.error("history: load failed", { id: e.payload.id, error: String(err) }),
    );
  });
}

const HISTORY_IMPORT_EVENT = "history://import";

/** From the History window: hand a picked audio file to the main window's ingest wizard. */
export async function emitHistoryImport(path: string): Promise<void> {
  if (!isTauri()) return;
  await emit(HISTORY_IMPORT_EVENT, { path });
}

/** Main-window listener: open the ingest wizard for a file picked in History. */
export async function listenForHistoryImport(): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<{ path: string }>(HISTORY_IMPORT_EVENT, (e) => {
    if (useStore.getState().meetingStatus === "recording") return;
    useStore.getState().openIngestWizard(e.payload.path);
    import("@tauri-apps/api/webviewWindow")
      .then(({ WebviewWindow }) => WebviewWindow.getByLabel("main"))
      .then((w) => w?.setFocus())
      .catch(() => {});
  });
}

/** From the History window: ask the main window to load an ORG recording. */
export async function emitHistoryOpenOrg(orgId: string, id: string): Promise<void> {
  if (!isTauri()) return;
  await emit(HISTORY_OPEN_ORG_EVENT, { orgId, id });
}

/** Main-window listener: load the org recording requested by the History window. */
export async function listenForHistoryOpenOrg(): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<{ orgId: string; id: string }>(HISTORY_OPEN_ORG_EVENT, (e) => {
    loadOrgEntry(e.payload.orgId, e.payload.id).catch((err) =>
      log.error("history: org load failed", { id: e.payload.id, error: String(err) }),
    );
  });
}

/** Main-window listener: auto-save the meeting once Rust finishes encoding it. */
export async function listenForRecordingSaved(): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<{ path: string; durationMs: number }>(RECORDING_SAVED_EVENT, (e) => {
    saveLiveToHistory(e.payload.path, e.payload.durationMs).catch((err) =>
      log.error("history: live save failed", { error: String(err) }),
    );
  });
}

/** Tell other windows (the History grid) that an entry's saved analysis changed. */
async function emitHistoryUpdated(id: string): Promise<void> {
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
