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

import { useStore, speakerKey } from "../store";
import { isTauri } from "../tauriEvents";
import { log } from "../log";
import { markDirty } from "../cloud/syncState";
import { CLOUD_URL, cloudFetch, cloudToken } from "../cloud/client";
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
    meetingBatna: s.meetingBatna,
    meetingTarget: s.meetingTarget,
    meetingFloor: s.meetingFloor,
  };
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
  void pushToCloud(entry.id);
}

/** Fire-and-forget cloud push (signed-in only); kept here so save paths stay simple. */
function pushToCloud(id: string): void {
  // Content changed → flag dirty; pushLocalEntry clears it on a confirmed push, so
  // if this best-effort push fails the background sweep re-pushes it later.
  markDirty(id);
  void import("../cloud/sync")
    .then((m) => m.pushLocalEntrySafe(id))
    .catch(() => {}); // a failed chunk import must not become an unhandled rejection
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
    log.info("history: live save skipped (no transcript)");
    return;
  }
  const s = useStore.getState();
  const createdAt = s.meetingStartedAt ?? Date.now();
  const dateLabel = new Date(createdAt).toLocaleString(localeOf());
  const entry: HistoryEntry = {
    id: crypto.randomUUID(),
    title: `${translate(s.settings.language, "history.liveTitle")} · ${dateLabel}`,
    source: "live",
    createdAt,
    durationMs,
    audio: "audio.ogg",
    ...snapshotAnalysis(),
  };
  await persist(entry, audioTempPath, /* compress */ false);
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
  const entry: HistoryEntry = {
    id,
    title: session.name,
    source: "upload",
    createdAt: session.createdAt,
    durationMs: session.durationMs,
    audio: "audio.ogg",
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
    void loadHistoryEntry(e.payload.id).catch((err) =>
      log.error("history: load failed", { id: e.payload.id, error: String(err) }),
    );
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
    void loadOrgEntry(e.payload.orgId, e.payload.id).catch((err) =>
      log.error("history: org load failed", { id: e.payload.id, error: String(err) }),
    );
  });
}

/** Main-window listener: auto-save the meeting once Rust finishes encoding it. */
export async function listenForRecordingSaved(): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<{ path: string; durationMs: number }>(RECORDING_SAVED_EVENT, (e) => {
    void saveLiveToHistory(e.payload.path, e.payload.durationMs).catch((err) =>
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
    void Promise.resolve(uploadSaveInFlight)
      .catch(() => {})
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
