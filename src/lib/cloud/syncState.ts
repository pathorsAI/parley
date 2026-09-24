// Per-entry cloud-sync bookkeeping, kept in localStorage (shared across the app's
// same-origin webview windows, like the settings/cloudAuth sync). Two facts per
// entry:
//   - cloudUpdatedAt: the cloud `updatedAt` the LOCAL copy is known to match. If
//     the cloud later reports a HIGHER value, another device pushed a newer
//     version → the local copy is stale and should be re-pulled.
//   - dirty: local content changed but the cloud push hasn't confirmed yet (e.g.
//     the inline push failed offline) → the background sweep must re-push it.
//
// Deliberately a side-channel (not in the on-disk entry) so it needs no Rust and
// doesn't entangle buildSummary; a prune keeps it bounded. Cross-window races on
// this metadata are benign (worst case: one missed re-push or stale-detection,
// self-healing on the next pass), so no locking.

const KEY = "parley:cloudSync";

export interface SyncMeta {
  cloudUpdatedAt?: number;
  dirty?: boolean;
}

type SyncIndex = Record<string, SyncMeta>;

function read(): SyncIndex {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as SyncIndex;
  } catch {
    return {};
  }
}

function write(idx: SyncIndex): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(idx));
  } catch {
    /* quota / serialization — best effort */
  }
}

/**
 * The whole index, parsed once. Anything that walks every recording reads this
 * instead of looking entries up one by one: each lookup re-parses the entire
 * index, so a per-entry loop is quadratic — about 0.4 s of blocked UI per
 * listing at 1,000 recordings, and seconds at a few thousand.
 */
export function readSyncIndex(): Readonly<Record<string, SyncMeta>> {
  return read();
}

/** Record that the local copy now matches cloud `updatedAt` (and clears dirty). */
export function setSynced(id: string, cloudUpdatedAt: number): void {
  setSyncedMany([[id, cloudUpdatedAt]]);
}

/** {@link setSynced} for many entries in one read and one write. */
export function setSyncedMany(
  entries: ReadonlyArray<readonly [string, number]>,
): void {
  if (!entries.length) return;
  const idx = read();
  for (const [id, cloudUpdatedAt] of entries)
    idx[id] = { cloudUpdatedAt, dirty: false };
  write(idx);
}

/** Mark local content as changed, pending a confirmed push. */
export function markDirty(id: string): void {
  const idx = read();
  idx[id] = { ...idx[id], dirty: true };
  write(idx);
}

/** Drop metadata for ids that no longer exist locally or in the cloud (also how a
 *  deleted entry's bookkeeping gets cleaned up — it falls out of both lists). */
export function pruneSyncMeta(keepIds: Set<string>): void {
  const idx = read();
  let changed = false;
  for (const id of Object.keys(idx)) {
    if (!keepIds.has(id)) {
      delete idx[id];
      changed = true;
    }
  }
  if (changed) write(idx);
}
