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
import { translate } from "../../i18n/messages";
import type { ReplaySession } from "../replay/types";
import type { HistoryEntry, HistoryEntrySummary } from "./types";

const HISTORY_OPEN_EVENT = "history://open";
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
}

// ── Save paths ──────────────────────────────────────────────────────────────

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
 */
export async function saveUploadToHistory(session: ReplaySession): Promise<void> {
  if (!isTauri()) return;
  const entry: HistoryEntry = {
    id: crypto.randomUUID(),
    title: session.name,
    source: "upload",
    createdAt: session.createdAt,
    durationMs: session.durationMs,
    audio: "audio.ogg",
    ...snapshotAnalysis(),
  };
  await persist(entry, session.audioPath, /* compress */ true);
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

/** Main-window listener: auto-save the meeting once Rust finishes encoding it. */
export async function listenForRecordingSaved(): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<{ path: string; durationMs: number }>(RECORDING_SAVED_EVENT, (e) => {
    void saveLiveToHistory(e.payload.path, e.payload.durationMs).catch((err) =>
      log.error("history: live save failed", { error: String(err) }),
    );
  });
}

/** Map the UI language to a `toLocaleString` locale tag. */
function localeOf(): string {
  return useStore.getState().settings.language === "en" ? "en-US" : "zh-TW";
}
