// Cloud sync for meeting history. The desktop keeps the source of truth on disk
// (src/lib/history); this module mirrors a signed-in account's entries to Parley
// Cloud so the same account sees them on any device. Everything speaks the public
// HTTP contract (see ../cloud/client + the parley-internal worker) — the OSS app
// never imports private code.
//
// Model: an entry's UUID is its global id, so a push is an idempotent upsert. The
// History grid shows local ∪ cloud (deduped by id): entries in both are "synced",
// local-only are "local" (not backed up yet), cloud-only are "cloud" (on another
// device, lazily downloaded on click).

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { isTauri } from "../tauriEvents";
import { useStore } from "../store";
import { log } from "../log";
import { CLOUD_URL } from "./client";
import { buildSummary, listHistory } from "../history/history";
import type { HistoryEntry, HistoryEntrySummary } from "../history/types";
import type { CloudRecordingSummary } from "./types";

/** Whether a card is on this device, the cloud, or both. */
export type HistorySyncState = "local" | "synced" | "cloud";

/** A history card plus where it lives — what the grid renders. */
export interface HistoryCardItem extends HistoryEntrySummary {
  sync: HistorySyncState;
}

function token(): string | null {
  return useStore.getState().cloudAuth?.token ?? null;
}

/** Bearer-authenticated fetch against the cloud; throws on a non-2xx response. */
async function cloudFetch(path: string, init?: RequestInit): Promise<Response> {
  const t = token();
  if (!t) throw new Error("not signed in");
  const res = await fetch(`${CLOUD_URL}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${t}` },
  });
  if (!res.ok) throw new Error(`cloud ${init?.method ?? "GET"} ${path} → ${res.status}`);
  return res;
}

/** List the signed-in account's recordings (the synced mirror). [] when signed out. */
export async function listCloudRecordings(): Promise<CloudRecordingSummary[]> {
  if (!token()) return [];
  const res = await cloudFetch("/recordings");
  const data = (await res.json()) as { recordings?: CloudRecordingSummary[] };
  return data.recordings ?? [];
}

/** Push ONE local entry to the cloud: summary + full entry JSON, then the audio. */
export async function pushLocalEntry(id: string): Promise<void> {
  if (!isTauri() || !token()) return;
  const { meta, audioPath } = await invoke<{ meta: HistoryEntry; audioPath: string | null }>(
    "read_history_entry",
    { id }
  );
  // Upload the audio FIRST, then commit the summary row — so a row never claims
  // hasAudio before its blob exists (which would 404 a download on another device).
  if (audioPath) {
    // Read the local recording through the webview's asset channel, then upload it.
    const buf = await (await fetch(convertFileSrc(audioPath))).arrayBuffer();
    await cloudFetch(`/recordings/${id}/audio`, {
      method: "PUT",
      headers: { "Content-Type": "audio/ogg" },
      body: buf,
    });
  }
  const summary = buildSummary(meta);
  await cloudFetch(`/recordings/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summary, meta }),
  });
  log.info("cloud: pushed recording", { id, hasAudio: !!audioPath });
}

/** Best-effort push of one entry — never throws (used from save paths). */
export async function pushLocalEntrySafe(id: string): Promise<void> {
  if (!token()) return;
  try {
    await pushLocalEntry(id);
  } catch (e) {
    log.warn("cloud: push failed", { id, error: String(e) });
  }
}

/** Download a cloud-only entry to local disk so it loads into replay like any other. */
export async function downloadCloudEntry(rec: { id: string; hasAudio: boolean }): Promise<void> {
  if (!isTauri() || !token()) throw new Error("not signed in");
  const meta = (await (await cloudFetch(`/recordings/${rec.id}/meta`)).json()) as HistoryEntry;
  let audio: number[] | null = null;
  if (rec.hasAudio) {
    const buf = await (await cloudFetch(`/recordings/${rec.id}/audio`)).arrayBuffer();
    audio = Array.from(new Uint8Array(buf));
  }
  await invoke("save_remote_history_entry", {
    id: rec.id,
    summaryJson: JSON.stringify(buildSummary(meta)),
    metaJson: JSON.stringify(meta),
    audio,
  });
  log.info("cloud: downloaded recording", { id: rec.id, hasAudio: rec.hasAudio });
}

/** Remove a recording from the cloud (tombstone + drop its blobs). */
export async function deleteCloudRecording(id: string): Promise<void> {
  if (!token()) return;
  await cloudFetch(`/recordings/${id}`, { method: "DELETE" });
}

/**
 * Local ∪ cloud, deduped by id and newest-first. Falls back to local-only (every
 * card "local") when signed out or the cloud list fails, so the grid always renders.
 */
export async function listMergedHistory(): Promise<HistoryCardItem[]> {
  const local = await listHistory();
  if (!token()) return local.map((e) => ({ ...e, sync: "local" as const }));

  let cloud: CloudRecordingSummary[];
  try {
    cloud = await listCloudRecordings();
  } catch (e) {
    log.warn("cloud: list failed; showing local only", { error: String(e) });
    return local.map((e) => ({ ...e, sync: "local" as const }));
  }

  const cloudIds = new Set(cloud.map((c) => c.id));
  const localIds = new Set(local.map((e) => e.id));
  const merged: HistoryCardItem[] = local.map((e) => ({
    ...e,
    sync: cloudIds.has(e.id) ? "synced" : "local",
  }));
  for (const c of cloud) {
    if (localIds.has(c.id)) continue; // already a local card, marked "synced" above
    merged.push({
      id: c.id,
      title: c.title,
      source: c.source,
      createdAt: c.createdAt,
      durationMs: c.durationMs,
      speakerCount: c.speakerCount,
      findingsCount: c.findingsCount,
      hasAudio: c.hasAudio,
      snippet: c.snippet,
      sync: "cloud",
    });
  }
  merged.sort((a, b) => b.createdAt - a.createdAt);
  return merged;
}

/**
 * Background: push every local entry the cloud is missing. Returns how many were
 * pushed so the caller can refresh the grid (badges flip local → synced).
 */
export async function pushUnsyncedToCloud(): Promise<number> {
  if (!isTauri() || !token()) return 0;
  const [local, cloud] = await Promise.all([
    listHistory(),
    listCloudRecordings().catch(() => [] as CloudRecordingSummary[]),
  ]);
  const cloudIds = new Set(cloud.map((c) => c.id));
  let pushed = 0;
  for (const e of local) {
    if (cloudIds.has(e.id)) continue;
    try {
      await pushLocalEntry(e.id);
      pushed++;
    } catch (err) {
      log.warn("cloud: push failed", { id: e.id, error: String(err) });
    }
  }
  if (pushed) log.info("cloud: pushed unsynced entries", { pushed });
  return pushed;
}
