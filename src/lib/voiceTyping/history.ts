//! Voice-typing history: a lightweight JSONL log of past dictations (the final
//! Traditional-Chinese text + timestamp). The Rust side just appends/reads/writes
//! the file; filtering for delete/clear happens here.

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../tauriEvents";

export interface VoiceEntry {
  id: string;
  text: string;
  /** Epoch milliseconds. */
  ts: number;
}

/** Record one dictation (no-op for empty text / outside Tauri). */
export async function appendVoiceEntry(text: string): Promise<void> {
  if (!isTauri() || !text.trim()) return;
  const entry: VoiceEntry = { id: crypto.randomUUID(), text, ts: Date.now() };
  await invoke("append_voice_history", { line: JSON.stringify(entry) }).catch(() => {});
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

/** Remove one entry by id. */
export async function deleteVoiceEntry(id: string): Promise<void> {
  if (!isTauri()) return;
  const kept = (await listVoiceEntries()).filter((e) => e.id !== id);
  await writeAll(kept);
}

/** Remove everything. */
export async function clearVoiceEntries(): Promise<void> {
  if (!isTauri()) return;
  await invoke("write_voice_history", { content: "" }).catch(() => {});
}

/** Persist chronological (newest last) so future appends stay in order. */
async function writeAll(entries: VoiceEntry[]): Promise<void> {
  const content = [...entries]
    .sort((a, b) => a.ts - b.ts)
    .map((e) => JSON.stringify(e))
    .join("\n");
  await invoke("write_voice_history", { content: content ? `${content}\n` : "" }).catch(() => {});
}
