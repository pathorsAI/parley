// Cloud sync for meeting history. The desktop keeps the source of truth on disk
// (src/lib/history); this module mirrors a signed-in account's entries to Parley
// Cloud so the same account sees them on any device. Everything speaks the public
// HTTP contract (see ../cloud/client + the parley-internal worker) — the OSS app
// never imports private code.
//
// Model: an entry's UUID is its global id, so a push is an idempotent upsert. The
// History grid shows local ∪ cloud (deduped by id): entries in both are "synced",
// or "stale" when the cloud copy is newer (another device re-analyzed it);
// local-only are "local" (not backed up yet); cloud-only are "cloud" (on another
// device, lazily downloaded on click). See ./syncState for the version bookkeeping.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { isTauri } from "../tauriEvents";
import { useStore } from "../store";
import { log } from "../log";
import { CLOUD_URL } from "./client";
import { buildSummary, listHistory } from "../history/history";
import { getSyncMeta, pruneSyncMeta, setSynced } from "./syncState";
import type { HistoryEntry, HistoryEntrySummary } from "../history/types";
import type { CloudRecordingSummary } from "./types";

/**
 * Where a card lives. "stale" = present both places but the cloud copy is newer
 * than the local one (re-pulled on open).
 */
export type HistorySyncState = "local" | "synced" | "stale" | "cloud";

/** A history card plus where it lives — what the grid renders. */
export interface HistoryCardItem extends HistoryEntrySummary {
  sync: HistorySyncState;
  /** Cloud `updatedAt` for this id (when it exists in the cloud) — for re-pull bookkeeping. */
  cloudUpdatedAt?: number;
}

function token(): string | null {
  return useStore.getState().cloudAuth?.token ?? null;
}

/** A thrown cloud-auth failure (cleared session) — used to short-circuit the sweep. */
function isAuthError(e: unknown): boolean {
  return e instanceof Error && /\bauth\b/.test(e.message);
}

/** Bearer-authenticated fetch against the cloud; throws on a non-2xx response. */
async function cloudFetch(path: string, init?: RequestInit): Promise<Response> {
  const t = token();
  if (!t) throw new Error("not signed in");
  const res = await fetch(`${CLOUD_URL}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${t}` },
  });
  if (res.status === 401 || res.status === 403) {
    // The session is dead — clear it so the UI reflects signed-out consistently
    // (badges go local, account card shows signed-out) instead of a misleading
    // "everything is local" while still appearing signed in.
    useStore.getState().setCloudAuth(null);
    throw new Error(`cloud auth ${res.status}`);
  }
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
  const res = await cloudFetch(`/recordings/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summary, meta }),
  });
  // Record the cloud version this local copy now matches (and clear dirty), so a
  // later NEWER cloud `updatedAt` (from another device) reads as stale.
  const { updatedAt } = (await res.json().catch(() => ({}))) as { updatedAt?: number };
  if (typeof updatedAt === "number") setSynced(id, updatedAt);
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

/**
 * Download a cloud entry to local disk so it loads into replay like any other.
 * Used both for cloud-only cards and to refresh a "stale" local copy. The audio
 * is streamed straight to disk by Rust (via reqwest) — we never ship the multi-MB
 * blob across the Tauri IPC as a JSON number[].
 */
export async function downloadCloudEntry(rec: {
  id: string;
  hasAudio: boolean;
  cloudUpdatedAt?: number;
}): Promise<void> {
  const t = token();
  if (!isTauri() || !t) throw new Error("not signed in");
  const meta = (await (await cloudFetch(`/recordings/${rec.id}/meta`)).json()) as HistoryEntry;
  await invoke("save_remote_history_entry", {
    id: rec.id,
    summaryJson: JSON.stringify(buildSummary(meta)),
    metaJson: JSON.stringify(meta),
    // Hand Rust the URL + token so it fetches + writes the audio itself.
    audioUrl: rec.hasAudio ? `${CLOUD_URL}/recordings/${rec.id}/audio` : null,
    token: rec.hasAudio ? t : null,
  });
  // The local copy now matches this cloud version (clears any stale flag).
  if (typeof rec.cloudUpdatedAt === "number") setSynced(rec.id, rec.cloudUpdatedAt);
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

  const cloudById = new Map(cloud.map((c) => [c.id, c]));
  const localIds = new Set(local.map((e) => e.id));
  const merged: HistoryCardItem[] = local.map((e) => {
    const c = cloudById.get(e.id);
    if (!c) return { ...e, sync: "local" as const }; // not backed up yet
    const meta = getSyncMeta(e.id);
    if (meta.cloudUpdatedAt === undefined) {
      // First sight of an already-synced entry → assume the local copy matches the
      // current cloud (it was pushed/pulled from this device) and record that, so
      // only a LATER cloud bump (another device) reads as stale.
      setSynced(e.id, c.updatedAt);
      return { ...e, sync: "synced", cloudUpdatedAt: c.updatedAt };
    }
    // Stale only when the cloud is strictly newer AND we have no unpushed local
    // change (a dirty local copy is the truer one — the sweep will push it).
    const stale = c.updatedAt > meta.cloudUpdatedAt && !meta.dirty;
    return { ...e, sync: stale ? "stale" : "synced", cloudUpdatedAt: c.updatedAt };
  });
  for (const c of cloud) {
    if (localIds.has(c.id)) continue; // already a local card above
    merged.push({
      id: c.id,
      title: c.title,
      source: c.source,
      createdAt: c.createdAt,
      durationMs: c.durationMs,
      speakerCount: c.speakerCount,
      findingsCount: c.findingsCount,
      actionItemsCount: c.actionItemsCount,
      hasAudio: c.hasAudio,
      snippet: c.snippet,
      sync: "cloud",
      cloudUpdatedAt: c.updatedAt,
    });
  }
  // Forget bookkeeping for ids that no longer exist anywhere.
  pruneSyncMeta(new Set([...localIds, ...cloudById.keys()]));
  merged.sort((a, b) => b.createdAt - a.createdAt);
  return merged;
}

/**
 * Background: push every local entry the cloud is MISSING, plus any whose local
 * content changed but never got a confirmed push (dirty — e.g. an inline push
 * failed offline). Returns how many were pushed so the caller can refresh the
 * grid. Bails on the first auth failure rather than retrying every entry.
 */
export async function pushUnsyncedToCloud(): Promise<number> {
  if (!isTauri() || !token()) return 0;
  // If the cloud list itself fails, skip the pass — don't treat "cloud empty" as
  // "push everything" (that would hammer the server on a transient outage).
  let cloud: CloudRecordingSummary[];
  try {
    cloud = await listCloudRecordings();
  } catch (e) {
    log.warn("cloud: sweep skipped (list failed)", { error: String(e) });
    return 0;
  }
  const local = await listHistory();
  const cloudIds = new Set(cloud.map((c) => c.id));
  let pushed = 0;
  for (const e of local) {
    const needsPush = !cloudIds.has(e.id) || getSyncMeta(e.id).dirty === true;
    if (!needsPush) continue;
    try {
      await pushLocalEntry(e.id);
      pushed++;
    } catch (err) {
      if (isAuthError(err)) {
        log.warn("cloud: sweep aborted (auth)", { error: String(err) });
        break;
      }
      log.warn("cloud: push failed", { id: e.id, error: String(err) });
    }
  }
  if (pushed) log.info("cloud: pushed unsynced entries", { pushed });
  return pushed;
}
