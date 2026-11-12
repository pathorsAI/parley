// The order of the sidebar's personal folder list.
//
// Pinned folders first, in the order they were pinned (oldest pin on top) —
// a pin is a promise that the folder stays exactly where you put it. Then the
// rest, most-used first, by frecency: every "use" of a folder counts for one
// point that halves every two weeks, so a folder you lived in last quarter
// sinks below the one you opened three times this week. A use is either
// opening the folder in the library or a recording filed in it (dated by the
// recording), weighed the same. Ties keep the old order: oldest folder first.
//
// The ranking itself is pure (rankFolders); the open log is a small
// localStorage record kept below it. The sidebar decides WHEN to re-rank —
// never while you are clicking around (see AppSidebar).

// Type-only: the registry module drags the IPC layer (and the store) in with
// it, and this file has to stay importable from a plain unit test.
import type { Folder } from "../history/folders";

const isPinned = (f: Folder) => typeof f.pinnedAt === "number";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A use loses half its weight every this many days. */
export const HALF_LIFE_DAYS = 14;

/** Opening a folder → its id, with every open's timestamp (epoch ms). */
export type FolderOpens = Readonly<Record<string, readonly number[]>>;

/** Frecency of a set of use timestamps at `now`: Σ 0.5^(ageDays / 14). A use
 *  stamped in the future (clock skew) counts as brand new, never as more. */
export function frecency(times: readonly number[], now: number): number {
  let score = 0;
  for (const at of times) {
    const ageDays = Math.max(0, now - at) / DAY_MS;
    score += Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
  }
  return score;
}

/** Recording timestamps grouped by the personal folder they are filed in. */
export function recordingTimesByFolder(
  summaries: readonly { folderId?: string | null; createdAt: number }[]
): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const s of summaries) {
    if (!s.folderId) continue;
    (out[s.folderId] ??= []).push(s.createdAt);
  }
  return out;
}

/**
 * Pinned folders (by pinnedAt ascending), then the rest by frecency descending,
 * ties by createdAt ascending. Does not filter — hand it the folders to show.
 */
export function rankFolders<F extends Folder>(
  folders: readonly F[],
  usage: Readonly<{
    opens: FolderOpens;
    recordingTimes: Readonly<Record<string, readonly number[]>>;
    now: number;
  }>
): F[] {
  const pinned = folders
    .filter(isPinned)
    .sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0) || a.createdAt - b.createdAt);
  const score = new Map<string, number>();
  const rest = folders.filter((f) => !isPinned(f));
  for (const f of rest) {
    score.set(
      f.id,
      frecency(usage.opens[f.id] ?? [], usage.now) +
        frecency(usage.recordingTimes[f.id] ?? [], usage.now)
    );
  }
  rest.sort(
    (a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) || a.createdAt - b.createdAt
  );
  return [...pinned, ...rest];
}

// ── The open logs ───────────────────────────────────────────────────────────
// Two of them, the same shape: personal folders by id, and org folders by
// `${orgId}:${folderId}` (an org folder's id is only unique within its org as
// far as this file is concerned, and its recordings are not local, so opens
// are all an org folder's ranking has to go on).

const OPENS_KEY = "parley:folder-opens";
const ORG_OPENS_KEY = "parley:org-folder-opens";
/** Older opens past this many per folder weigh next to nothing anyway. */
export const MAX_OPENS_PER_FOLDER = 50;

type OpensStorage = Pick<Storage, "getItem" | "setItem">;

export function safeStorage(): OpensStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** One log's entries. Empty on a missing or unreadable record — the ranking is
 *  a convenience, never a reason to fail. */
function readLog(key: string, storage: OpensStorage | null): Record<string, number[]> {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return {};
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, number[]> = {};
    for (const [id, times] of Object.entries(v as Record<string, unknown>)) {
      if (Array.isArray(times)) out[id] = times.filter((t): t is number => typeof t === "number");
    }
    return out;
  } catch {
    return {};
  }
}

/** Append one open to `entry`, keeping the newest {@link MAX_OPENS_PER_FOLDER},
 *  and drop every other entry `keep` says no to. */
function appendOpen(
  key: string,
  entry: string,
  keep: (entry: string) => boolean,
  now: number,
  storage: OpensStorage | null
): void {
  const next: Record<string, number[]> = {};
  for (const [k, times] of Object.entries(readLog(key, storage))) {
    if (k === entry || keep(k)) next[k] = times;
  }
  next[entry] = [...(next[entry] ?? []), now].slice(-MAX_OPENS_PER_FOLDER);
  try {
    storage?.setItem(key, JSON.stringify(next));
  } catch {
    /* storage full or unavailable — the ranking just learns less */
  }
}

/** Every personal folder's recorded opens. */
export function readFolderOpens(storage: OpensStorage | null = safeStorage()): FolderOpens {
  return readLog(OPENS_KEY, storage);
}

/**
 * Log one open of `folderId` at `now`, and drop folders no longer in
 * `knownIds` so a deleted folder's history does not live on forever. An empty
 * `knownIds` prunes nothing: that is a list that has not loaded yet, not a
 * registry with every folder deleted.
 */
export function recordFolderOpen(
  folderId: string,
  knownIds: readonly string[],
  now: number = Date.now(),
  storage: OpensStorage | null = safeStorage()
): void {
  const known = new Set(knownIds);
  appendOpen(OPENS_KEY, folderId, (id) => known.size === 0 || known.has(id), now, storage);
}

/** The org key both org logs (opens here, pins in orgFolderPins) use. */
export const orgFolderKey = (orgId: string, folderId: string) => `${orgId}:${folderId}`;

/** One org's folder opens, keyed by plain folder id (what rankFolders wants). */
export function readOrgFolderOpens(
  orgId: string,
  storage: OpensStorage | null = safeStorage()
): FolderOpens {
  const prefix = orgFolderKey(orgId, "");
  const out: Record<string, number[]> = {};
  for (const [k, times] of Object.entries(readLog(ORG_OPENS_KEY, storage))) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = times;
  }
  return out;
}

/**
 * Log one open of an org folder. Pruning is confined to THAT org, and skipped
 * when `knownIds` is empty: org folder lists load lazily, one org at a time,
 * so an org whose list is not in hand says nothing about which of its folders
 * still exist — and another org's history is never this call's business.
 */
export function recordOrgFolderOpen(
  orgId: string,
  folderId: string,
  knownIds: readonly string[],
  now: number = Date.now(),
  storage: OpensStorage | null = safeStorage()
): void {
  const known = new Set(knownIds);
  const prefix = orgFolderKey(orgId, "");
  appendOpen(
    ORG_OPENS_KEY,
    orgFolderKey(orgId, folderId),
    (k) => !k.startsWith(prefix) || known.size === 0 || known.has(k.slice(prefix.length)),
    now,
    storage
  );
}
