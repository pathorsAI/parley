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
import { log } from "../log";
import { CLOUD_URL, cloudFetch, cloudToken, isAuthError, syncEnabled } from "./client";
import { buildSummary, listHistory, deleteHistoryEntry } from "../history/history";
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

// `cloudFetch`, `cloudToken`, and `isAuthError` now live in ./client — one shared
// bearer-fetch seam for sync + orgs + the org-replay download.

/** List the signed-in account's recordings (the synced mirror). [] when signed out. */
export async function listCloudRecordings(): Promise<CloudRecordingSummary[]> {
  if (!cloudToken()) return [];
  const res = await cloudFetch("/recordings");
  const data = (await res.json()) as { recordings?: CloudRecordingSummary[] };
  return data.recordings ?? [];
}

// One in-flight push per id. Two pushes for the SAME entry must not race: each
// reads the current disk content and clears dirty on its own response, so an older
// push resolving last could record stale content as "synced". Chaining makes the
// later push read the latest disk content and have the final say.
const pushChains = new Map<string, Promise<unknown>>();

/** Push ONE local entry to the cloud (serialized per id). */
export async function pushLocalEntry(id: string): Promise<void> {
  const prev = pushChains.get(id) ?? Promise.resolve();
  const next = prev
    .catch((error) =>
      log.warn("cloud sync: previous push failed before queued retry", {
        id,
        error: String(error),
      }),
    )
    .then(() => pushLocalEntryNow(id));
  pushChains.set(id, next);
  try {
    await next;
  } finally {
    if (pushChains.get(id) === next) pushChains.delete(id);
  }
}

/** The actual push: summary + full entry JSON, with the audio uploaded first. */
async function pushLocalEntryNow(id: string): Promise<void> {
  if (!isTauri() || !cloudToken()) return;
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
  if (!cloudToken()) return;
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
  const t = cloudToken();
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
  if (!cloudToken()) return;
  await cloudFetch(`/recordings/${id}`, { method: "DELETE" });
}

/**
 * Local ∪ cloud, deduped by id and newest-first. Falls back to local-only (every
 * card "local") when signed out or the cloud list fails, so the grid always renders.
 */
export async function listMergedHistory(): Promise<HistoryCardItem[]> {
  const local = await listHistory();
  // Sync off (or signed out / OSS edition) → show local only, every card "local".
  if (!syncEnabled()) return local.map((e) => ({ ...e, sync: "local" as const }));

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
      // only a LATER cloud bump (another device) reads as stale. But NEVER record a
      // baseline while a local change is pending (dirty) — that would drop the
      // re-push the sweep still owes; leave dirty so the sweep pushes it.
      if (!meta.dirty) setSynced(e.id, c.updatedAt);
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
      folderId: c.folderId ?? null,
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
  if (!isTauri() || !syncEnabled()) return 0;
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

// ── Org-shared recordings ─────────────────────────────────────────────────────
// An org is a shared space: members see what others shared INTO it. Sharing is an
// explicit COPY (the personal original stays put), so nothing personal ever leaks
// into an org unless the user deliberately puts it there.

/** List the recordings shared into an org the signed-in user belongs to. */
export async function listOrgRecordings(orgId: string): Promise<CloudRecordingSummary[]> {
  if (!cloudToken()) return [];
  const res = await cloudFetch(`/orgs/${encodeURIComponent(orgId)}/recordings`);
  const data = (await res.json()) as { recordings?: CloudRecordingSummary[] };
  return data.recordings ?? [];
}

/**
 * Share a recording into an org as an independent COPY, optionally into a specific
 * org folder. The server copies from the user's own cloud keyspace, so the source
 * must be in the cloud first: force a push (gated only on a valid session, NOT the
 * sync toggle — sharing is an explicit move into a shared cloud space). Returns the
 * new org-side summary.
 */
export async function shareRecordingToOrg(
  id: string,
  orgId: string,
  folderId: string | null = null,
): Promise<CloudRecordingSummary> {
  await pushLocalEntrySafe(id); // ensure the source exists in the user keyspace
  const res = await cloudFetch(`/recordings/${encodeURIComponent(id)}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orgId, folderId }),
  });
  const data = (await res.json()) as { recording: CloudRecordingSummary };
  log.info("cloud: shared recording to org", { id, orgId, folderId, newId: data.recording?.id });
  return data.recording;
}

/**
 * MOVE a personal recording into an org folder: copy it in (share), then remove the
 * personal original. Client-orchestrated rather than a server flag because the
 * desktop's source of truth is on local disk (a server "move" couldn't delete it,
 * and the sweep would re-upload it). Order is the safe one: copy first, and only on
 * success delete the personal copy (cloud first, then local) — a mid-way failure
 * leaves the personal original intact. Returns the new org-side summary.
 */
export async function moveRecordingToOrg(
  id: string,
  orgId: string,
  folderId: string | null = null,
): Promise<CloudRecordingSummary> {
  const shared = await shareRecordingToOrg(id, orgId, folderId);
  // Copy succeeded → drop the personal original. Cloud first (so a failure aborts
  // before we destroy the recoverable local copy); a tombstoned id is never
  // resurrected by the sweep, so a leftover cloud row (if local delete then failed)
  // is at worst a deletable cloud-only card.
  await deleteCloudRecording(id);
  await deleteHistoryEntry(id);
  log.info("cloud: moved recording to org", { id, orgId, folderId, newId: shared.id });
  return shared;
}

/** Remove a shared recording from an org (uploader or org admin/owner only). */
export async function deleteOrgRecording(orgId: string, id: string): Promise<void> {
  if (!cloudToken()) return;
  await cloudFetch(
    `/orgs/${encodeURIComponent(orgId)}/recordings/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}
