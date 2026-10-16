// Storage access for saved history entries: the one place that talks to the
// Rust history store (src-tauri/src/history.rs) — reading an entry, writing
// its meta + summary (+ audio), the per-entry write chain every
// read-modify-write goes through, listing, renaming, deleting, and the
// "an entry changed" broadcast. The flows that decide WHAT to write live in
// history.ts.

import { speakerKey } from "../speakers/labels";
import { isTauri } from "../tauriEvents";
import { log } from "../log";
import * as ipc from "../ipc/commands";
import { emitEvent, listenEvent, type UnlistenFn } from "../ipc/events";
import type { HistoryEntry, HistoryEntrySummary } from "./types";

const HISTORY_UPDATED_EVENT = "history://updated";

// ── Summary card ────────────────────────────────────────────────────────────

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
    analyzed: entry.analyzed,
    snippet: snippetOf(entry),
    folderId: entry.folderId ?? null,
  };
}

// ── The save_history_entry payload ──────────────────────────────────────────

/** Where an entry's recording comes from on a save. */
export interface EntryAudio {
  /** A file to place into the entry folder; null leaves the recording untouched. */
  audioSourcePath: string | null;
  /** Opus-compress that file on the way in (uploads). */
  compress: boolean;
}

/** An in-place update: the recording on disk stays as it is. */
const KEEP_AUDIO: EntryAudio = { audioSourcePath: null, compress: false };

/**
 * THE `save_history_entry` argument object: meta + its summary card, keyed by
 * `id`, plus what happens to the audio. Every write of an entry builds it here.
 * Pure + exported for testing.
 */
export function saveEntryArgs(id: string, entry: HistoryEntry, audio: EntryAudio = KEEP_AUDIO) {
  return {
    id,
    summaryJson: JSON.stringify(buildSummary(entry)),
    metaJson: JSON.stringify(entry),
    audioSourcePath: audio.audioSourcePath,
    compress: audio.compress,
  };
}

/** Write an entry's meta + summary (and place its audio, when given). */
export async function writeEntry(entry: HistoryEntry, audio: EntryAudio = KEEP_AUDIO): Promise<void> {
  await ipc.saveHistoryEntry(saveEntryArgs(entry.id, entry, audio));
}

/** Read one saved entry: its meta and the local path of its recording, if any. */
export function readEntry(id: string) {
  return ipc.readHistoryEntry({ id });
}

// ── Per-entry write serialization ───────────────────────────────────────────
//
// Every in-place update is a read-modify-write of meta.json. Two of them for
// the same entry must not interleave — the later save would write back the
// meta it read BEFORE the earlier one landed, silently undoing it. That used to
// be rare (one stage persisting at a time, while the recording was on screen);
// now a stage can finish after the user left and write while they refile or
// rename the same recording, so every RMW goes through this chain.
const entryWrites = new Map<string, Promise<unknown>>();

export function withEntryWrite<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = entryWrites.get(id) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  entryWrites.set(id, next);
  const clear = () => {
    if (entryWrites.get(id) === next) entryWrites.delete(id);
  };
  next.then(clear, clear);
  return next;
}

/** Resolves once every queued write for this entry has landed (or failed). */
export function entryWritesSettled(id: string): Promise<void> {
  const pending = entryWrites.get(id);
  return pending ? pending.then(() => {}, () => {}) : Promise.resolve();
}

/**
 * Read the entry, let `change` derive its next meta, write it back (recording
 * untouched). `change` returning null writes nothing. Resolves to what was
 * written, or null. NOT serialized — see {@link rewriteEntry}.
 */
export function rewriteEntryNow(id: string, change: (meta: HistoryEntry) => HistoryEntry): Promise<HistoryEntry>;
export function rewriteEntryNow(
  id: string,
  change: (meta: HistoryEntry) => HistoryEntry | null,
): Promise<HistoryEntry | null>;
export async function rewriteEntryNow(
  id: string,
  change: (meta: HistoryEntry) => HistoryEntry | null,
): Promise<HistoryEntry | null> {
  const { meta } = await readEntry(id);
  const next = change(meta);
  if (!next) return null;
  await ipc.saveHistoryEntry(saveEntryArgs(id, next));
  return next;
}

/** {@link rewriteEntryNow} inside the entry's write chain. */
export function rewriteEntry(id: string, change: (meta: HistoryEntry) => HistoryEntry): Promise<HistoryEntry>;
export function rewriteEntry(
  id: string,
  change: (meta: HistoryEntry) => HistoryEntry | null,
): Promise<HistoryEntry | null>;
export function rewriteEntry(
  id: string,
  change: (meta: HistoryEntry) => HistoryEntry | null,
): Promise<HistoryEntry | null> {
  return withEntryWrite(id, () => rewriteEntryNow(id, change));
}

/** Rename an entry's files (Rust patches meta + summary), inside its write chain. */
export function renameEntryFiles(id: string, title: string): Promise<void> {
  return withEntryWrite(id, () => ipc.renameHistoryEntry({ id, title }));
}

// ── List / delete ────────────────────────────────────────────────────────────

/** All saved summaries, newest first. */
export async function listHistory(): Promise<HistoryEntrySummary[]> {
  if (!isTauri()) return [];
  const raw = await ipc.listHistory();
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

/** Delete one entry's folder. */
export async function deleteHistoryEntry(id: string): Promise<void> {
  if (!isTauri()) return;
  await ipc.deleteHistoryEntry({ id });
  log.info("history: entry deleted", { id });
}

// ── "An entry changed" ──────────────────────────────────────────────────────

/** Tell other windows (the History grid) that an entry's saved analysis changed. */
export async function emitHistoryUpdated(id?: string): Promise<void> {
  if (!isTauri()) return;
  await emitEvent(HISTORY_UPDATED_EVENT, { id });
}

/** History-window listener: re-list after the main window overwrites an entry. */
export async function listenForHistoryUpdated(onUpdated: (id: string) => void): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listenEvent<{ id: string }>(HISTORY_UPDATED_EVENT, (e) => onUpdated(e.payload.id));
}
