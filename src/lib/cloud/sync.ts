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
//
// Tombstones: the cloud list hides recordings deleted in the cloud (on another
// device, or moved into an org from here). A newer server reports their ids next
// to the list and answers 410 to a push of one; either way the id is flagged
// `cloudGone` and never pushed again — otherwise a recording deleted on the phone
// but still on this desktop would be re-uploaded, audio and all, on every sweep.
// What happens to the local copy depends on whether it was ever synced from here:
// a recording this device knew as synced follows the cloud and is deleted locally
// too (see cloudDeletionsToFollow); one that never was stays, because local is the
// truth for anything the cloud never had. An older server reports no tombstones,
// which leaves today's behaviour in place.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { isTauri } from "../tauriEvents";
import { log } from "../log";
import { CLOUD_URL, CloudError, cloudFetch, cloudToken, isAuthError, syncEnabled } from "./client";
import { buildSummary, listHistory, deleteHistoryEntry } from "../history/history";
import {
  clearCloudGone,
  isCloudGone,
  markCloudGone,
  pruneSyncMeta,
  readSyncIndex,
  setSynced,
  setSyncedMany,
  type SyncMeta,
} from "./syncState";
import { isSampleEntry } from "../onboarding/sample";
import { useStore } from "../store";
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

/** The personal cloud listing: the live rows plus the ids tombstoned there. */
export interface CloudLibrary {
  recordings: CloudRecordingSummary[];
  /** Ids of the account's personal recordings deleted in the cloud. Always empty
   *  from an older server that doesn't report them. */
  tombstones: string[];
}

/** List the signed-in account's recordings and tombstones. Empty when signed out. */
export async function listCloudLibrary(): Promise<CloudLibrary> {
  if (!cloudToken()) return { recordings: [], tombstones: [] };
  const res = await cloudFetch("/recordings");
  const data = (await res.json()) as {
    recordings?: CloudRecordingSummary[];
    tombstones?: unknown;
  };
  const tombstones = Array.isArray(data.tombstones)
    ? data.tombstones.filter((t): t is string => typeof t === "string")
    : [];
  return { recordings: data.recordings ?? [], tombstones };
}

/** List the signed-in account's recordings (the synced mirror). [] when signed out. */
export async function listCloudRecordings(): Promise<CloudRecordingSummary[]> {
  return (await listCloudLibrary()).recordings;
}

/** The server's "this id is tombstoned / not yours to write" answer to a push. */
function isGoneResponse(e: unknown): boolean {
  return e instanceof CloudError && e.status === 410;
}

/**
 * Thrown by an explicit action that needs the cloud copy (share / move into an
 * org) when the recording was deleted from the cloud and only this device still
 * has it. The UI maps it to a localized toast; the English message is for logs
 * and MCP callers.
 */
export class CloudGoneError extends Error {
  constructor(readonly id: string) {
    super(
      `recording ${id} was deleted from the cloud (on another device); it is kept on this device only and cannot be shared`,
    );
    this.name = "CloudGoneError";
  }
}

export function isCloudGoneError(e: unknown): e is CloudGoneError {
  return e instanceof CloudGoneError;
}

// Ids already logged as "not pushing: gone" this session — the save paths can try
// to push a gone entry on every edit, and one line per recording is enough.
const goneLogged = new Set<string>();

function logGoneOnce(id: string): void {
  if (goneLogged.has(id)) return;
  goneLogged.add(id);
  log.info("cloud: not pushing a recording deleted in the cloud (kept locally)", { id });
}

/**
 * Fold one cloud listing into the bookkeeping: local ids the cloud tombstoned are
 * flagged `cloudGone`; a flagged id the cloud lists as live again is unflagged
 * (the server is the judge). Non-local tombstones are ignored — there is nothing
 * here to stop pushing, and prune would drop them anyway. Decided against the
 * caller's snapshot so a no-op costs no extra parse; returns whether it wrote.
 */
function reconcileCloudGone(
  localIds: ReadonlySet<string>,
  cloud: CloudLibrary,
  syncIndex: Readonly<Record<string, SyncMeta>>,
): boolean {
  const tombstoned = new Set(cloud.tombstones);
  const gone = cloud.tombstones.filter((id) => localIds.has(id) && !syncIndex[id]?.cloudGone);
  const back = cloud.recordings
    .filter((c) => syncIndex[c.id]?.cloudGone && !tombstoned.has(c.id))
    .map((c) => c.id);
  if (back.length) {
    clearCloudGone(back);
    for (const id of back) goneLogged.delete(id);
    log.info("cloud: recordings listed live again; resuming sync", { ids: back });
  }
  if (gone.length) {
    markCloudGone(gone);
    for (const id of gone) goneLogged.add(id);
    log.info("cloud: stopped syncing recordings deleted in the cloud", {
      count: gone.length,
      ids: gone,
    });
  }
  return back.length > 0 || gone.length > 0;
}

/**
 * Which local entries a sweep pushes: everything the cloud is missing, plus
 * anything with an unconfirmed local change (dirty) — except the bundled sample
 * (never leaves the device) and anything the cloud tombstoned, whether the
 * current listing says so or an earlier one / a 410 did (`cloudGone`). A flagged
 * id the cloud lists as live again is treated like any other synced entry.
 */
export function entriesToPush<T extends { id: string }>(
  local: readonly T[],
  cloudIds: ReadonlySet<string>,
  tombstones: ReadonlySet<string>,
  syncIndex: Readonly<Record<string, SyncMeta>>,
): T[] {
  return local.filter((e) => {
    if (isSampleEntry(e) || tombstones.has(e.id)) return false;
    const meta = syncIndex[e.id];
    const inCloud = cloudIds.has(e.id);
    if (meta?.cloudGone && !inCloud) return false;
    return !inCloud || meta?.dirty === true;
  });
}

/**
 * Local recordings to delete because the cloud deleted them: tombstoned there AND
 * known to this device as synced (it holds a cloud version for the id, so the
 * copy here was a mirror of the cloud one, not a local original). Never the
 * sample, and never the recording open on screen — that one waits for a later
 * pass, after the user has moved on.
 */
export function cloudDeletionsToFollow<T extends { id: string }>(
  local: readonly T[],
  tombstones: ReadonlySet<string>,
  syncIndex: Readonly<Record<string, SyncMeta>>,
  openId: string | null,
): string[] {
  return local
    .filter(
      (e) =>
        tombstones.has(e.id) &&
        !isSampleEntry(e) &&
        e.id !== openId &&
        syncIndex[e.id]?.cloudUpdatedAt !== undefined,
    )
    .map((e) => e.id);
}

/**
 * A deletion pass this large is more likely a server fault than a user who
 * deleted most of their library on another device — and a local delete can't be
 * undone. Above this share of the synced local entries (and past a handful), the
 * pass is refused and logged instead; the entries stay flagged and unpushed.
 */
const MAX_FOLLOW_SHARE = 0.5;
const FOLLOW_ALWAYS_OK = 5;

/**
 * Apply {@link cloudDeletionsToFollow}: delete those local copies and return the
 * local list without them. Best-effort per entry — a failed delete just leaves
 * that entry for the next pass.
 */
async function followCloudDeletions<T extends { id: string }>(
  local: T[],
  tombstones: ReadonlySet<string>,
  syncIndex: Readonly<Record<string, SyncMeta>>,
): Promise<T[]> {
  if (!tombstones.size) return local;
  const ids = cloudDeletionsToFollow(local, tombstones, syncIndex, useStore.getState().loadedHistoryId);
  if (!ids.length) return local;
  const synced = local.filter((e) => syncIndex[e.id]?.cloudUpdatedAt !== undefined).length;
  if (ids.length > FOLLOW_ALWAYS_OK && ids.length > synced * MAX_FOLLOW_SHARE) {
    log.warn("cloud: refusing to delete most of the synced library on a tombstone list", {
      wouldDelete: ids.length,
      synced,
    });
    return local;
  }
  const deleted = new Set<string>();
  for (const id of ids) {
    try {
      await deleteHistoryEntry(id);
      deleted.add(id);
    } catch (e) {
      log.warn("cloud: local delete after cloud delete failed", { id, error: String(e) });
    }
  }
  if (deleted.size) {
    log.info("cloud: deleted local copies of recordings deleted in the cloud", {
      count: deleted.size,
      ids: [...deleted],
    });
  }
  return local.filter((e) => !deleted.has(e.id));
}

/** What one push did: uploaded, did nothing (signed out / sample), or found the
 *  id tombstoned in the cloud (now flagged, nothing written). */
export type PushOutcome = "pushed" | "skipped" | "gone";

// One in-flight push per id. Two pushes for the SAME entry must not race: each
// reads the current disk content and clears dirty on its own response, so an older
// push resolving last could record stale content as "synced". Chaining makes the
// later push read the latest disk content and have the final say.
const pushChains = new Map<string, Promise<unknown>>();

/** Push ONE local entry to the cloud (serialized per id). */
export async function pushLocalEntry(id: string): Promise<PushOutcome> {
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
    return await next;
  } finally {
    if (pushChains.get(id) === next) pushChains.delete(id);
  }
}

/** The actual push: summary + full entry JSON, with the audio uploaded first. */
async function pushLocalEntryNow(id: string): Promise<PushOutcome> {
  if (!isTauri() || !cloudToken()) return "skipped";
  // The bundled onboarding sample stays on this device: it is demo content, not
  // the user's recording, so it must never land in their cloud account. Every
  // push (inline save paths and the sweep) funnels through here.
  if (isSampleEntry({ id })) return "skipped";
  // Tombstoned in the cloud: checked before reading the multi-MB audio, since the
  // server would only throw it away.
  if (isCloudGone(id)) {
    logGoneOnce(id);
    return "gone";
  }
  const { meta, audioPath } = await invoke<{ meta: HistoryEntry; audioPath: string | null }>(
    "read_history_entry",
    { id }
  );
  let res: Response;
  try {
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
    res = await cloudFetch(`/recordings/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary, meta }),
    });
  } catch (e) {
    // 410 = tombstoned (or not this user's personal row): an expected answer, not
    // a failure. The server wrote nothing; flag it so no later push tries again.
    if (!isGoneResponse(e)) throw e;
    markCloudGone([id]);
    logGoneOnce(id);
    return "gone";
  }
  // Record the cloud version this local copy now matches (and clear dirty), so a
  // later NEWER cloud `updatedAt` (from another device) reads as stale.
  const { updatedAt } = (await res.json().catch(() => ({}))) as { updatedAt?: number };
  if (typeof updatedAt === "number") setSynced(id, updatedAt);
  log.info("cloud: pushed recording", { id, hasAudio: !!audioPath });
  return "pushed";
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
  // We just tombstoned it ourselves: if the local delete that follows fails (or a
  // move leaves the local copy behind), the sweep must not keep re-uploading it.
  // Needs no server support, so this holds against an older server too.
  markCloudGone([id]);
  goneLogged.add(id);
}

/**
 * Local ∪ cloud, deduped by id and newest-first. Falls back to local-only (every
 * card "local") when signed out or the cloud list fails, so the grid always renders.
 */
export async function listMergedHistory(): Promise<HistoryCardItem[]> {
  let local = await listHistory();
  // Sync off (or signed out / OSS edition) → show local only, every card "local".
  if (!syncEnabled()) return local.map((e) => ({ ...e, sync: "local" as const }));

  let library: CloudLibrary;
  try {
    library = await listCloudLibrary();
  } catch (e) {
    log.warn("cloud: list failed; showing local only", { error: String(e) });
    return local.map((e) => ({ ...e, sync: "local" as const }));
  }
  const cloud = library.recordings;
  local = await followCloudDeletions(local, new Set(library.tombstones), readSyncIndex());

  const cloudById = new Map(cloud.map((c) => [c.id, c]));
  const localIds = new Set(local.map((e) => e.id));
  // One parse of the bookkeeping for the whole list, one write for every new
  // baseline — see readSyncIndex for why this is not a per-entry lookup. Re-read
  // only when the tombstone reconcile actually changed it.
  const snapshot = readSyncIndex();
  const syncIndex = reconcileCloudGone(localIds, library, snapshot) ? readSyncIndex() : snapshot;
  const baselines: [string, number][] = [];
  const merged: HistoryCardItem[] = local.map((e) => {
    const meta = syncIndex[e.id] ?? {};
    // Deleted in the cloud: only this device has it now, so it is a local card —
    // never "synced"/"stale", and never a baseline (there is no cloud version).
    if (meta.cloudGone) return { ...e, sync: "local" as const };
    const c = cloudById.get(e.id);
    if (!c) return { ...e, sync: "local" as const }; // not backed up yet
    if (meta.cloudUpdatedAt === undefined) {
      // First sight of an already-synced entry → assume the local copy matches the
      // current cloud (it was pushed/pulled from this device) and record that, so
      // only a LATER cloud bump (another device) reads as stale. But NEVER record a
      // baseline while a local change is pending (dirty) — that would drop the
      // re-push the sweep still owes; leave dirty so the sweep pushes it.
      if (!meta.dirty) baselines.push([e.id, c.updatedAt]);
      return { ...e, sync: "synced", cloudUpdatedAt: c.updatedAt };
    }
    // Stale only when the cloud is strictly newer AND we have no unpushed local
    // change (a dirty local copy is the truer one — the sweep will push it).
    const stale = c.updatedAt > meta.cloudUpdatedAt && !meta.dirty;
    return { ...e, sync: stale ? "stale" : "synced", cloudUpdatedAt: c.updatedAt };
  });
  setSyncedMany(baselines);
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
  // Forget bookkeeping for ids that no longer exist anywhere. A cloudGone entry is
  // local, so its flag survives until the local copy is deleted too.
  pruneSyncMeta(new Set([...localIds, ...cloudById.keys()]));
  merged.sort((a, b) => b.createdAt - a.createdAt);
  return merged;
}

// The sweep in flight, if any. The library starts one every time the personal
// scope is (re)entered and never cancels it, so two can overlap; each would take
// its own snapshot and push the same entries again (the per-id pushChains only
// serialize them — the second still uploads). A second caller joins the first.
let sweepInFlight: Promise<number> | null = null;

/**
 * Background: push every local entry the cloud is MISSING, plus any whose local
 * content changed but never got a confirmed push (dirty — e.g. an inline push
 * failed offline), minus anything tombstoned in the cloud (see entriesToPush).
 * Local copies of recordings deleted in the cloud are deleted first (see
 * followCloudDeletions). Returns how many entries changed (pushed or deleted)
 * so the caller can refresh the grid. Bails on the
 * first auth failure rather than retrying every entry. Concurrent calls share one
 * run.
 */
export function pushUnsyncedToCloud(): Promise<number> {
  sweepInFlight ??= runSweep().finally(() => {
    sweepInFlight = null;
  });
  return sweepInFlight;
}

async function runSweep(): Promise<number> {
  if (!isTauri() || !syncEnabled()) return 0;
  // If the cloud list itself fails, skip the pass — don't treat "cloud empty" as
  // "push everything" (that would hammer the server on a transient outage).
  let library: CloudLibrary;
  try {
    library = await listCloudLibrary();
  } catch (e) {
    log.warn("cloud: sweep skipped (list failed)", { error: String(e) });
    return 0;
  }
  const tombstoneSet = new Set(library.tombstones);
  const listed = await listHistory();
  const local = await followCloudDeletions(listed, tombstoneSet, readSyncIndex());
  const removed = listed.length - local.length;
  const cloudIds = new Set(library.recordings.map((c) => c.id));
  // Decided up front from one snapshot (see readSyncIndex). An entry marked dirty
  // while the sweep runs is caught by the next one, like any other late change.
  const snapshot = readSyncIndex();
  const localIds = new Set(local.map((e) => e.id));
  const syncIndex = reconcileCloudGone(localIds, library, snapshot) ? readSyncIndex() : snapshot;
  const toPush = entriesToPush(local, cloudIds, tombstoneSet, syncIndex);
  let pushed = 0;
  let gone = 0;
  for (const e of toPush) {
    try {
      const outcome = await pushLocalEntry(e.id);
      if (outcome === "pushed") pushed++;
      else if (outcome === "gone") gone++;
    } catch (err) {
      if (isAuthError(err)) {
        log.warn("cloud: sweep aborted (auth)", { error: String(err) });
        break;
      }
      log.warn("cloud: push failed", { id: e.id, error: String(err) });
    }
  }
  if (pushed) log.info("cloud: pushed unsynced entries", { pushed });
  if (gone) log.info("cloud: sweep found recordings deleted in the cloud", { gone });
  // The caller refreshes the grid on a non-zero answer, and a deleted card is as
  // much a change as a pushed one.
  return pushed + removed;
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
  // Deleted from the cloud elsewhere → there is no source for the server to copy,
  // and a push can't bring it back. Say so instead of a confusing share failure.
  if (isCloudGone(id)) throw new CloudGoneError(id);
  await pushLocalEntrySafe(id); // ensure the source exists in the user keyspace
  if (isCloudGone(id)) throw new CloudGoneError(id); // that push just got a 410
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

/**
 * Save a COPY of an org-shared recording into the personal library: fetch the
 * full entry over HTTP and write it to local disk as an ordinary history entry
 * (audio streamed down by Rust, same as downloadCloudEntry). The org copy stays
 * put — the reverse of shareRecordingToOrg, and like it, an explicit copy rather
 * than a shared reference. The saved entry lands at the personal root (its org
 * folderId means nothing in the personal scope).
 */
export async function saveOrgRecordingToPersonal(orgId: string, id: string): Promise<void> {
  const base = `/orgs/${encodeURIComponent(orgId)}/recordings/${encodeURIComponent(id)}`;
  const meta = (await (await cloudFetch(`${base}/meta`)).json()) as HistoryEntry;
  const entry: HistoryEntry = { ...meta, folderId: null };
  const t = cloudToken();
  await invoke("save_remote_history_entry", {
    id: entry.id,
    summaryJson: JSON.stringify(buildSummary(entry)),
    metaJson: JSON.stringify(entry),
    audioUrl: meta.audio && t ? `${CLOUD_URL}${base}/audio` : null,
    token: t,
  });
  log.info("cloud: org recording saved to personal", { orgId, id });
}
