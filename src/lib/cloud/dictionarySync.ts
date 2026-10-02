// Cloud sync for the phrase dictionary (../dictionary). A signed-in account with
// cloud sync on mirrors its dictionary to Parley Cloud, so the iPhone and every
// other desktop spell the same terms the same way. Everything goes over the
// public HTTP contract (`GET` / `PUT /v1/dictionary` on the parley-internal
// worker) — the OSS app never imports private code.
//
// Model: an entry's identity is its PHRASE (case-sensitive, like the local
// dictionary), not its id — two devices that add the same term independently
// end up with one cloud row, and this device adopts that row's id. Conflicts are
// last-write-wins per phrase on the entry's `updatedAt`; the server applies the
// rule and sends back the result, which is simply written into the local file.
//
// What changed locally is found by diffing the dictionary against a snapshot of
// what this device and the cloud last agreed on (`synced`, per account, in
// localStorage like ./syncState). That needs no dirty flags in the file, so an
// edit made by the MCP server or by hand is picked up the same way as one made
// in Settings. A phrase in the snapshot but no longer on disk was deleted here
// and goes up as a tombstone; the moment it was first noticed is pinned in
// `pendingDeletes`, so an offline device doesn't keep moving the deletion later.
//
// Triggers (initDictionarySync, main window only): launch, sign-in / turning
// sync on, ~5 s after a local change, and — at most every 15 minutes — window
// focus, so a term added on the phone shows up on a desktop that never quits.
// A failed run changes nothing locally and keeps the cursor: the next trigger
// simply tries again.
//
// Privacy: entries are user data. Logs carry counts and error codes, never a
// phrase or a variant.

import { log } from "../log";
import { useStore } from "../store";
import { CLOUD_ENABLED } from "../flags";
import { isTauri } from "../tauriEvents";
import {
  listEntries,
  listenForDictionaryUpdated,
  reloadDictionary,
  replaceEntries,
  whenDictionaryReady,
  type DictionaryEntry,
  type DictionarySource,
} from "../dictionary";
import { cloudFetch, syncEnabled } from "./client";

/** How the cloud labels where an entry came from (the iPhone shares these). */
export type CloudDictionarySource = "manual" | "learned" | "imported";

/** An entry as `GET` / `PUT /v1/dictionary` exchange it. */
export interface CloudDictionaryEntry {
  id: string;
  phrase: string;
  variants: string[];
  source: CloudDictionarySource;
  confirmed: boolean;
  /** Epoch ms of the last change — the last-write-wins clock. */
  updatedAt: number;
  /** Epoch ms of the deletion; null = live. */
  deletedAt: number | null;
}

/** One refused entry of a PUT; `index` is its position in that request. */
export interface CloudDictionaryRejection {
  index: number;
  id: string;
  error: string;
}

/** The server's per-request cap. */
export const PUSH_BATCH = 500;
/** Quiet period after a local edit before it goes up. */
export const SYNC_DEBOUNCE_MS = 5_000;
/** Focus re-syncs no more often than this. */
export const FOCUS_SYNC_INTERVAL_MS = 15 * 60 * 1000;
/** An empty dictionary where the snapshot remembers at least this many phrases
 *  is taken for a lost or reset file, not a deliberate wipe (see outgoingChanges). */
export const RESET_GUARD_MIN = 10;

/** Refusals that will go away by themselves; everything else means the cloud
 *  will never take this form of the entry (too long, too many variants…). */
const TRANSIENT_REJECTIONS = new Set(["conflict", "entry_limit"]);

const STATE_KEY = "parley:dictionarySync";
/** Kept apart from the state so the Settings window can watch it cheaply. */
export const STATUS_KEY = "parley:dictionarySyncStatus";
/** Same-window twin of the `storage` event (which only fires in OTHER windows). */
export const STATUS_EVENT = "parley:dictionary-sync-status";

/** What this device and the cloud last agreed a phrase looks like. */
interface SyncedEntry {
  id: string;
  variants: string[];
  source: DictionarySource;
}

export interface DictionarySyncState {
  /** The account the snapshot belongs to — another account starts from scratch. */
  userId: string | null;
  /** The previous successful GET's `now`; null = never synced. */
  cursor: number | null;
  /** phrase → its last agreed form. */
  synced: Record<string, SyncedEntry>;
  /** phrase → when this device first saw it deleted (not yet confirmed). */
  pendingDeletes: Record<string, number>;
  /** phrase → fingerprint of a local form the cloud refused for good; not
   *  offered again until the entry changes. */
  parked: Record<string, string>;
}

export type DictionarySyncStatus =
  | { state: "syncing"; lastSyncedAt: number | null }
  | { state: "ok"; lastSyncedAt: number }
  | { state: "error"; lastSyncedAt: number | null };

// ── Pure helpers (exported for the tests) ─────────────────────────────────────

export function toCloudSource(source: DictionarySource): CloudDictionarySource {
  if (source === "correction") return "learned";
  if (source === "mcp") return "imported";
  return "manual";
}

export function fromCloudSource(source: string): DictionarySource {
  if (source === "learned") return "correction";
  if (source === "imported") return "mcp";
  return "manual";
}

export function emptySyncState(userId: string | null): DictionarySyncState {
  return { userId, cursor: null, synced: {}, pendingDeletes: {}, parked: {} };
}

/** The entry's last-change time as a whole, non-negative ms value. */
function stamp(e: DictionaryEntry): number {
  const t = e.updatedAt ?? e.createdAt;
  return Number.isFinite(t) && t > 0 ? Math.floor(t) : 0;
}

/** Entries grouped by phrase. The local file can hold the same phrase twice (an
 *  MCP add doesn't merge); sync treats the group as one entry and collapses it. */
function byPhrase(entries: readonly DictionaryEntry[]): Map<string, DictionaryEntry[]> {
  const groups = new Map<string, DictionaryEntry[]>();
  for (const e of entries) {
    const phrase = e.phrase.trim();
    if (!phrase) continue;
    const list = groups.get(phrase);
    if (list) list.push(e);
    else groups.set(phrase, [e]);
  }
  return groups;
}

function fingerprint(list: readonly SyncedEntry[]): string {
  return JSON.stringify(list.map((e) => [e.id, e.variants, e.source]));
}

/** The fingerprint a phrase has when it matches the snapshot ("[]" = absent both). */
function syncedFingerprint(state: DictionarySyncState, phrase: string): string {
  const s = state.synced[phrase];
  return fingerprint(s ? [s] : []);
}

/** What has to go up, plus what it was built from (to recognise later edits). */
export interface Outgoing {
  entries: CloudDictionaryEntry[];
  /** phrase → fingerprint of the local group the outgoing entry was built from. */
  sentFrom: Map<string, string>;
  pendingDeletes: Record<string, number>;
  /** True when the empty-file guard kicked in and the snapshot was set aside. */
  reset: boolean;
}

/**
 * Diff the local dictionary against the snapshot: one outgoing entry per phrase
 * that is new or changed here, one tombstone per phrase deleted here.
 *
 * Guard: a dictionary that is suddenly EMPTY while the snapshot remembers
 * RESET_GUARD_MIN or more phrases is far more likely a lost or reset file than a
 * user who deleted that many rows, one by one, each within seconds of the last
 * (deletes inside one debounce window go up together). Pushing it as tombstones
 * would wipe the cloud and the phone, so the snapshot is set aside instead and
 * the merge brings the entries back.
 */
export function outgoingChanges(
  local: readonly DictionaryEntry[],
  state: DictionarySyncState,
  now: number,
): Outgoing {
  const groups = byPhrase(local);
  const reset = groups.size === 0 && Object.keys(state.synced).length >= RESET_GUARD_MIN;
  const entries: CloudDictionaryEntry[] = [];
  const sentFrom = new Map<string, string>();

  for (const [phrase, list] of groups) {
    const fp = fingerprint(list);
    if (fp === syncedFingerprint(state, phrase) || state.parked[phrase] === fp) continue;
    const knownId = state.synced[phrase]?.id;
    const primary =
      list.find((e) => e.id === knownId) ?? [...list].sort((a, b) => a.createdAt - b.createdAt)[0];
    const newest = list.reduce((a, b) => (stamp(b) > stamp(a) ? b : a));
    const variants: string[] = [];
    for (const e of list) for (const v of e.variants) if (!variants.includes(v)) variants.push(v);
    entries.push({
      id: primary.id,
      phrase,
      variants,
      source: toCloudSource(newest.source),
      confirmed: true,
      updatedAt: stamp(newest),
      deletedAt: null,
    });
    sentFrom.set(phrase, fp);
  }

  const pendingDeletes: Record<string, number> = {};
  if (!reset) {
    for (const [phrase, synced] of Object.entries(state.synced)) {
      if (groups.has(phrase)) continue;
      const at = state.pendingDeletes[phrase] ?? now;
      pendingDeletes[phrase] = at;
      entries.push({
        id: synced.id,
        phrase,
        variants: [],
        source: toCloudSource(synced.source),
        confirmed: true,
        updatedAt: at,
        deletedAt: at,
      });
      sentFrom.set(phrase, fingerprint([]));
    }
  }
  return { entries, sentFrom, pendingDeletes, reset };
}

/** The result of one exchange with the cloud, ready to be folded in. */
export interface SyncExchange {
  /** Rows from `GET ?since=` (other devices' changes, plus echoes of ours). */
  pulled: CloudDictionaryEntry[];
  /** The merged rows the PUTs answered with. */
  pushed: CloudDictionaryEntry[];
  /** Refusals, resolved back to the phrase they were for. */
  rejected: { phrase: string; error: string }[];
}

/**
 * Fold an exchange into the CURRENT local entries (re-read after the network
 * round trip) and the snapshot. Returns the new entry list, or null when the
 * file doesn't need rewriting.
 *
 * A pulled row is applied only to a phrase that is still untouched here (it
 * matches the snapshot); a pushed row only if the phrase still looks exactly as
 * it did when it was sent. Anything edited in the meantime is left alone and
 * goes up on the next run.
 */
export function applyExchange(
  local: readonly DictionaryEntry[],
  state: DictionarySyncState,
  outgoing: Outgoing,
  exchange: SyncExchange,
  newId: () => string = () => crypto.randomUUID(),
): { entries: DictionaryEntry[] | null; state: DictionarySyncState } {
  const groups = byPhrase(local);
  const groupFp = (phrase: string) => fingerprint(groups.get(phrase) ?? []);
  const next: DictionarySyncState = {
    ...state,
    synced: outgoing.reset ? {} : { ...state.synced },
    pendingDeletes: { ...outgoing.pendingDeletes },
    parked: { ...state.parked },
  };

  const rows = new Map<string, CloudDictionaryEntry>();
  for (const row of exchange.pulled) {
    if (outgoing.sentFrom.has(row.phrase)) continue;
    if (groupFp(row.phrase) !== syncedFingerprint(next, row.phrase)) continue;
    rows.set(row.phrase, row);
  }
  for (const row of exchange.pushed) {
    if (outgoing.sentFrom.get(row.phrase) !== groupFp(row.phrase)) continue;
    rows.set(row.phrase, row);
  }
  for (const { phrase, error } of exchange.rejected) {
    if (TRANSIENT_REJECTIONS.has(error)) continue;
    const fp = outgoing.sentFrom.get(phrase);
    if (fp === undefined || fp !== groupFp(phrase)) continue;
    if (groups.has(phrase)) next.parked[phrase] = fp;
    else {
      delete next.synced[phrase];
      delete next.pendingDeletes[phrase];
    }
  }

  if (rows.size === 0) return { entries: null, state: next };

  let entries = [...local];
  for (const [phrase, row] of rows) {
    const group = groups.get(phrase) ?? [];
    entries = entries.filter((e) => e.phrase.trim() !== phrase);
    delete next.pendingDeletes[phrase];
    delete next.parked[phrase];
    if (row.deletedAt !== null) {
      delete next.synced[phrase];
      continue;
    }
    // Ids are unique locally (Settings keys rows by them). Should an unrelated
    // local entry still hold this id — a term renamed here keeps its id — that
    // one takes a fresh id and is reconciled by phrase on the next run.
    entries = entries.map((e) => (e.id === row.id ? { ...e, id: newId() } : e));
    const base = group.find((e) => e.id === row.id) ?? group[0];
    const source = fromCloudSource(row.source);
    entries.push({
      id: row.id,
      phrase,
      variants: [...row.variants],
      createdAt: base?.createdAt ?? row.updatedAt,
      updatedAt: row.updatedAt,
      source,
    });
    next.synced[phrase] = { id: row.id, variants: [...row.variants], source };
  }
  return { entries, state: next };
}

// ── Persistence ───────────────────────────────────────────────────────────────

function loadState(userId: string): DictionarySyncState {
  try {
    const raw = JSON.parse(localStorage.getItem(STATE_KEY) ?? "null") as DictionarySyncState | null;
    if (raw && raw.userId === userId && raw.synced && typeof raw.synced === "object") {
      return {
        userId,
        cursor: typeof raw.cursor === "number" ? raw.cursor : null,
        synced: raw.synced,
        pendingDeletes: raw.pendingDeletes ?? {},
        parked: raw.parked ?? {},
      };
    }
  } catch {
    /* unreadable → start over; the first sync merges, it never deletes */
  }
  return emptySyncState(userId);
}

function saveState(state: DictionarySyncState): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    /* quota — the next run recomputes from scratch */
  }
}

export function readDictionarySyncStatus(): DictionarySyncStatus | null {
  try {
    return JSON.parse(localStorage.getItem(STATUS_KEY) ?? "null") as DictionarySyncStatus | null;
  } catch {
    return null;
  }
}

function setStatus(status: DictionarySyncStatus | null): void {
  try {
    if (status) localStorage.setItem(STATUS_KEY, JSON.stringify(status));
    else localStorage.removeItem(STATUS_KEY);
  } catch {
    /* best effort */
  }
  globalThis.dispatchEvent?.(new Event(STATUS_EVENT));
}

// ── Network ───────────────────────────────────────────────────────────────────

async function pull(cursor: number | null): Promise<{ entries: CloudDictionaryEntry[]; now: number }> {
  const query = cursor === null ? "" : `?since=${cursor}`;
  const res = await cloudFetch(`/v1/dictionary${query}`);
  const body = (await res.json()) as { entries?: CloudDictionaryEntry[]; now?: number };
  if (!Array.isArray(body.entries) || typeof body.now !== "number") {
    throw new Error("dictionary sync: malformed pull response");
  }
  return { entries: body.entries, now: body.now };
}

async function push(entries: CloudDictionaryEntry[]): Promise<Omit<SyncExchange, "pulled">> {
  const pushed: CloudDictionaryEntry[] = [];
  const rejected: SyncExchange["rejected"] = [];
  for (let i = 0; i < entries.length; i += PUSH_BATCH) {
    const batch = entries.slice(i, i + PUSH_BATCH);
    const res = await cloudFetch("/v1/dictionary", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: batch }),
    });
    const body = (await res.json()) as {
      entries?: CloudDictionaryEntry[];
      rejected?: CloudDictionaryRejection[];
    };
    pushed.push(...(body.entries ?? []));
    for (const r of body.rejected ?? []) {
      const phrase = batch[r.index]?.phrase;
      if (phrase !== undefined) rejected.push({ phrase, error: r.error });
    }
  }
  return { pushed, rejected };
}

// ── Runner ────────────────────────────────────────────────────────────────────

function currentUserId(): string | null {
  return syncEnabled() ? (useStore.getState().cloudAuth?.user.id ?? null) : null;
}

let running: Promise<void> | null = null;
let again = false;
let lastAttemptAt = 0;

async function runOnce(): Promise<void> {
  const userId = currentUserId();
  if (!userId) return;
  lastAttemptAt = Date.now();
  await whenDictionaryReady();
  await reloadDictionary();

  let state = loadState(userId);
  const previous = readDictionarySyncStatus();
  const lastSyncedAt = previous && previous.lastSyncedAt ? previous.lastSyncedAt : null;
  setStatus({ state: "syncing", lastSyncedAt });
  try {
    const outgoing = outgoingChanges(listEntries(), state, Date.now());
    if (outgoing.reset) {
      log.warn("dictionary sync: local dictionary is empty, merging from the cloud instead of deleting", {
        remembered: Object.keys(state.synced).length,
      });
    }
    // Pin the deletion times before going to the network, so a failed run
    // retries with the same ones.
    state = { ...state, pendingDeletes: outgoing.pendingDeletes };
    saveState(state);

    const pulled = await pull(outgoing.reset ? null : state.cursor);
    const { pushed, rejected } = await push(outgoing.entries);

    // Signed out or switched accounts mid-flight: this result is not theirs.
    if (currentUserId() !== userId) {
      setStatus(previous);
      return;
    }
    await reloadDictionary();
    const applied = applyExchange(listEntries(), state, outgoing, { pulled: pulled.entries, pushed, rejected });
    if (applied.entries) replaceEntries(applied.entries);
    saveState({ ...applied.state, cursor: pulled.now });
    setStatus({ state: "ok", lastSyncedAt: Date.now() });
    if (outgoing.entries.length || pulled.entries.length) {
      log.info("dictionary sync: done", {
        pulled: pulled.entries.length,
        pushed: outgoing.entries.length,
        refused: rejected.length,
        codes: [...new Set(rejected.map((r) => r.error))].join(","),
      });
    }
  } catch (error) {
    setStatus({ state: "error", lastSyncedAt });
    log.warn("dictionary sync: failed, will retry on the next trigger", { error: String(error) });
  }
}

/**
 * Sync now. Overlapping calls share one run; a call that arrives mid-run makes
 * it go round once more afterwards, so a change made during a sync is not lost.
 * No-op unless signed in with cloud sync on.
 */
export function syncDictionary(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await runOnce();
      } while (again);
    } finally {
      running = null;
    }
  })();
  return running;
}

/** True when the local dictionary differs from what was last synced. */
function hasLocalChanges(): boolean {
  const userId = currentUserId();
  if (!userId) return false;
  return outgoingChanges(listEntries(), loadState(userId), Date.now()).entries.length > 0;
}

/**
 * Wire up the triggers. Call once from the MAIN window — the one that is alive
 * for the whole session; the others only edit the file and broadcast. Returns
 * the cleanup.
 */
export function initDictionarySync(): () => void {
  if (!CLOUD_ENABLED || !isTauri()) return () => {};
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Launch.
  void syncDictionary();

  // Sign-in, sign-out → sign-in as someone else, or the sync toggle turned on.
  let enabledFor = currentUserId();
  const unsubscribe = useStore.subscribe(() => {
    const now = currentUserId();
    if (now === enabledFor) return;
    enabledFor = now;
    if (now) void syncDictionary();
  });

  // Any local edit — Settings, the correction bubble, an MCP tool (Rust
  // broadcasts after it writes) — once things have been quiet for a moment.
  // The broadcast our own sync triggers by writing the merge result diffs
  // clean, so it doesn't schedule another round.
  let unlisten: (() => void) | undefined;
  listenForDictionaryUpdated(() => {
    if (!active || !hasLocalChanges()) return;
    clearTimeout(timer);
    timer = setTimeout(() => void syncDictionary(), SYNC_DEBOUNCE_MS);
  })
    .then((fn) => {
      if (active) unlisten = fn;
      else fn();
    })
    .catch((error) => log.warn("dictionary sync: listener failed", { error: String(error) }));

  const onFocus = () => {
    if (Date.now() - lastAttemptAt >= FOCUS_SYNC_INTERVAL_MS) void syncDictionary();
  };
  window.addEventListener("focus", onFocus);

  return () => {
    active = false;
    clearTimeout(timer);
    unsubscribe();
    unlisten?.();
    window.removeEventListener("focus", onFocus);
  };
}
