//! Voice-typing history: a lightweight JSONL log of past dictations (the final
//! Traditional-Chinese text + timestamp). The Rust side just appends/reads/writes
//! the file; filtering for delete/clear happens here.

import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "../tauriEvents";
import { log } from "../log";

export interface VoiceEntry {
  id: string;
  text: string;
  /** Epoch milliseconds. */
  ts: number;
  /** Bundle id of the app the text was pasted into ("com.apple.Notes"), when
   *  the paste reported one. Older lines predate the field. */
  appBundleId?: string | null;
}

/**
 * Broadcast after every successful write to the history file, so an open list
 * re-reads instead of showing what it saw when it mounted. The voice-typing
 * host appends from the MAIN window while the list may be on screen in that
 * same window — Tauri delivers a JS `emit` to the emitting webview's own
 * listeners too (the library already relies on that for `history://updated`).
 * Sent only once the Rust command has returned, i.e. after the line is on disk,
 * so the read it triggers is guaranteed to see the change.
 */
export const VOICE_HISTORY_CHANGED_EVENT = "voicetyping://history-changed";

export interface VoiceHistoryChangedPayload {
  kind: "append" | "update" | "delete" | "clear";
  /** The entry that changed; absent for "clear". */
  id?: string;
}

/** Never rejects: the write itself already succeeded, and a caller such as the
 *  host's fire-and-forget append must not report a missed broadcast as a
 *  failed save. */
async function emitVoiceHistoryChanged(payload: VoiceHistoryChangedPayload): Promise<void> {
  await emit(VOICE_HISTORY_CHANGED_EVENT, payload).catch((error) =>
    log.warn("voice typing history: change broadcast failed", {
      kind: payload.kind,
      error: String(error),
    }),
  );
}

/** History-list listener: re-read after a dictation is recorded, edited,
 *  deleted or cleared. A no-op outside Tauri. */
export async function listenForVoiceHistoryChanged(
  onChanged: (payload: VoiceHistoryChangedPayload) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<VoiceHistoryChangedPayload>(VOICE_HISTORY_CHANGED_EVENT, (e) => onChanged(e.payload));
}

/** Record one dictation (no-op for empty text / outside Tauri). */
export async function appendVoiceEntry(
  text: string,
  appBundleId?: string | null,
): Promise<void> {
  if (!isTauri() || !text.trim()) return;
  const entry: VoiceEntry = { id: crypto.randomUUID(), text, ts: Date.now() };
  // Only carry the key when we actually know the target app, so lines written
  // by an older build and lines from a blocked paste look the same.
  if (appBundleId) entry.appBundleId = appBundleId;
  try {
    await invoke("append_voice_history", { line: JSON.stringify(entry) });
  } catch (error) {
    log.warn("voice typing history: append failed", { id: entry.id, error: String(error) });
    return;
  }
  await emitVoiceHistoryChanged({ kind: "append", id: entry.id });
}

/** All entries, newest first. */
export async function listVoiceEntries(): Promise<VoiceEntry[]> {
  if (!isTauri()) return [];
  try {
    const raw = await invoke<string>("read_voice_history");
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as VoiceEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is VoiceEntry => !!e && typeof e.text === "string" && typeof e.ts === "number")
      .sort((a, b) => b.ts - a.ts);
  } catch {
    return [];
  }
}

/** Replace one entry's text, keeping its id, timestamp and app label — the
 *  "correct & learn" edit in the history list. */
export async function updateVoiceEntryText(id: string, text: string): Promise<void> {
  if (!isTauri()) return;
  const entries = await listVoiceEntries();
  if (!entries.some((e) => e.id === id)) return;
  if (await writeAll(entries.map((e) => (e.id === id ? { ...e, text } : e)))) {
    await emitVoiceHistoryChanged({ kind: "update", id });
  }
}

/** Remove one entry by id. */
export async function deleteVoiceEntry(id: string): Promise<void> {
  if (!isTauri()) return;
  const entries = await listVoiceEntries();
  // Same guard as the edit: an id that isn't there (already gone, or a read
  // that failed and came back as []) must not rewrite the file — writing back
  // that empty read would erase every other dictation.
  if (!entries.some((e) => e.id === id)) return;
  if (await writeAll(entries.filter((e) => e.id !== id))) {
    await emitVoiceHistoryChanged({ kind: "delete", id });
  }
}

/** Remove everything. */
export async function clearVoiceEntries(): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("write_voice_history", { content: "" });
  } catch (error) {
    log.warn("voice typing history: clear failed", { error: String(error) });
    return;
  }
  await emitVoiceHistoryChanged({ kind: "clear" });
}

/** Persist chronological (newest last) so future appends stay in order.
 *  Resolves false when the write failed (already logged), so the callers only
 *  broadcast a change that actually reached the disk. */
async function writeAll(entries: VoiceEntry[]): Promise<boolean> {
  const content = [...entries]
    .sort((a, b) => a.ts - b.ts)
    .map((e) => JSON.stringify(e))
    .join("\n");
  try {
    await invoke("write_voice_history", { content: content ? `${content}\n` : "" });
    return true;
  } catch (error) {
    log.warn("voice typing history: write failed", {
      count: entries.length,
      error: String(error),
    });
    return false;
  }
}
