// Cloud sync for the saved meeting drafts (../store/prep). A signed-in account
// with cloud sync on mirrors its drafts to Parley Cloud, so a meeting prepared
// on another desktop — or created by an AI assistant over the cloud MCP — shows
// up under 即將開始 here and reminds on time. Everything goes over the public
// HTTP contract (`GET` / `PUT /v1/drafts` on the parley-internal worker); the
// OSS app never imports private code.
//
// Model (the dictionary's, ./dictionarySync, keyed by the draft's id instead of
// a phrase): identity is the client-minted id. Conflicts are last-write-wins
// per id on the draft's `updatedAt`; the server applies the rule (tie → its
// copy) and answers with the result, which is written into the list.
//
// What changed locally is found by diffing the drafts against a snapshot of
// what this device and the cloud last agreed on (`synced`, per account, in
// localStorage). A draft in the snapshot but no longer in the list was deleted
// here (or taken to record) and goes up as a tombstone; the moment that was
// first noticed is pinned in `pendingDeletes`, so an offline device doesn't
// keep moving the deletion later.
//
// Only the LIST is ever written (the store's mergeCloudDrafts). The prep fields
// — the draft currently loaded for editing or recording — are left alone: if
// that draft changes remotely, the user's next save is a newer write and wins.
// `remindedFor` is per device and never leaves it.
//
// Triggers (initDraftSync, main window only): launch, sign-in / turning sync
// on, ~5 s after a local change, window focus at most every 2 minutes, and a
// 2-minute interval — drafts are time-sensitive, a meeting created over MCP may
// start soon. A failed run changes nothing locally and keeps the cursor.
//
// Privacy: drafts are user data. Logs carry ids, counts and error codes, never
// a title, a context or a checklist item.

import { log } from "../log";
import { useStore } from "../store";
import { subscribeSelected } from "../store/subscribe";
import { createDebouncer } from "../debounce";
import { CLOUD_ENABLED } from "../flags";
import { isTauri } from "../tauriEvents";
import { DEFAULT_REMINDER_LEAD_MIN, type MeetingDraft } from "../store/prep";
import type { MeetingShare } from "../history/history";
import type { TodoItem } from "../types";
import { cloudFetch, syncEnabled } from "./client";

/** The org-share choice as the cloud stores it: the desktop's MeetingShare,
 *  passed through unchanged (an object always has a string `orgId`; `mode` and
 *  any other key ride along). */
export type CloudDraftShare = null | "off" | ({ orgId: string; folderId: string | null } & Record<string, unknown>);

/** A draft as `GET` / `PUT /v1/drafts` exchange it. */
export interface CloudMeetingDraft {
  id: string;
  title: string;
  meetingAt: number | null;
  meetingEndAt: number | null;
  reminderLeadMin: number;
  meetingContext: string;
  meetingBatna: string;
  meetingTarget: string;
  meetingFloor: string;
  todos: TodoItem[];
  meetingFolderId: string | null;
  meetingOrgShare: CloudDraftShare;
  /** Client epoch ms of the last change — the last-write-wins clock. */
  updatedAt: number;
  /** Client epoch ms of the deletion; null = live. */
  deletedAt: number | null;
}

/** One refused draft of a PUT; `index` is its position in that request. */
export interface CloudDraftRejection {
  index: number;
  id: string;
  error: string;
}

/** The server's per-request cap. */
export const PUSH_BATCH = 200;
/** Request bodies stay under this (the server refuses more than 1 MB). */
export const PUSH_MAX_BYTES = 900_000;
/** Quiet period after a local edit before it goes up. */
export const SYNC_DEBOUNCE_MS = 5_000;
/** Focus re-syncs no more often than this. */
export const FOCUS_SYNC_INTERVAL_MS = 2 * 60 * 1000;
/** And the main window re-syncs this often while it is open. */
export const PERIODIC_SYNC_MS = 2 * 60 * 1000;
/** An empty list where the snapshot remembers at least this many drafts is
 *  taken for lost app state, not a deliberate wipe (see outgoingChanges). */
export const RESET_GUARD_MIN = 5;

/** Refusals that go away by themselves; anything else (`invalid`) means the
 *  cloud will never take this form of the draft. */
const TRANSIENT_REJECTIONS = new Set(["conflict", "draft_limit"]);

const STATE_KEY = "parley:draftSync";

export interface DraftSyncState {
  /** The account the snapshot belongs to — another account starts from scratch. */
  userId: string | null;
  /** The previous successful GET's `now`; null = never synced. */
  cursor: number | null;
  /** id → fingerprint of the draft's last agreed form. */
  synced: Record<string, string>;
  /** id → when this device first saw it gone (not yet confirmed). */
  pendingDeletes: Record<string, number>;
  /** id → fingerprint of a local form the cloud refused for good; not offered
   *  again until the draft changes. */
  parked: Record<string, string>;
}

// ── Pure helpers (exported for the tests) ─────────────────────────────────────

export function emptySyncState(userId: string | null): DraftSyncState {
  return { userId, cursor: null, synced: {}, pendingDeletes: {}, parked: {} };
}

/** A share object with its keys in a fixed order, so equal choices fingerprint
 *  equal whichever order they were built in. */
function canonicalShare(share: unknown): CloudDraftShare {
  if (share === "off") return "off";
  if (!share || typeof share !== "object" || typeof (share as { orgId?: unknown }).orgId !== "string") return null;
  const src = share as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src).sort()) out[k] = src[k];
  if (!("folderId" in out)) out.folderId = null;
  return out as CloudDraftShare;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function msOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function todosOf(v: unknown): TodoItem[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((t): t is TodoItem => !!t && typeof t === "object" && typeof (t as TodoItem).id === "string")
    .map((t) => ({ id: t.id, text: str(t.text), done: t.done === true }));
}

/** A local draft in the cloud's shape (`remindedFor` stays home). */
export function toCloudDraft(d: MeetingDraft): CloudMeetingDraft {
  return {
    id: d.id,
    title: d.title,
    meetingAt: d.meetingAt,
    meetingEndAt: d.meetingEndAt,
    reminderLeadMin: d.reminderLeadMin,
    meetingContext: d.meetingContext,
    meetingBatna: d.meetingBatna,
    meetingTarget: d.meetingTarget,
    meetingFloor: d.meetingFloor,
    todos: todosOf(d.todos),
    meetingFolderId: d.meetingFolderId,
    meetingOrgShare: canonicalShare(d.meetingOrgShare),
    updatedAt: Number.isFinite(d.updatedAt) && d.updatedAt > 0 ? Math.floor(d.updatedAt) : 0,
    deletedAt: null,
  };
}

/** A live cloud row as a local draft, read defensively (whatever is malformed
 *  falls back to empty). `remindedFor` is this device's, given by the caller. */
export function fromCloudDraft(row: CloudMeetingDraft, remindedFor: number | null): MeetingDraft {
  const lead = row.reminderLeadMin;
  return {
    id: row.id,
    title: str(row.title),
    meetingAt: msOrNull(row.meetingAt),
    meetingEndAt: msOrNull(row.meetingEndAt),
    reminderLeadMin: typeof lead === "number" && Number.isFinite(lead) && lead >= 0 ? lead : DEFAULT_REMINDER_LEAD_MIN,
    remindedFor,
    meetingContext: str(row.meetingContext),
    meetingBatna: str(row.meetingBatna),
    meetingTarget: str(row.meetingTarget),
    meetingFloor: str(row.meetingFloor),
    todos: todosOf(row.todos),
    meetingFolderId: typeof row.meetingFolderId === "string" ? row.meetingFolderId : null,
    // A share made in the cloud may lack `mode`; the desktop reads a missing
    // mode as a copy (only "move" is special), so it is kept as sent.
    meetingOrgShare: canonicalShare(row.meetingOrgShare) as MeetingShare,
    updatedAt: msOrNull(row.updatedAt) ?? 0,
  };
}

/** The fingerprint of a draft's synced content (incl. its clock). "" = absent. */
export function fingerprint(d: MeetingDraft | undefined): string {
  if (!d) return "";
  const { deletedAt: _deleted, ...rest } = toCloudDraft(d);
  return JSON.stringify(rest);
}

function tombstone(id: string, at: number): CloudMeetingDraft {
  return {
    id,
    title: "",
    meetingAt: null,
    meetingEndAt: null,
    reminderLeadMin: DEFAULT_REMINDER_LEAD_MIN,
    meetingContext: "",
    meetingBatna: "",
    meetingTarget: "",
    meetingFloor: "",
    todos: [],
    meetingFolderId: null,
    meetingOrgShare: null,
    updatedAt: at,
    deletedAt: at,
  };
}

/** What has to go up, plus what it was built from (to recognise later edits). */
export interface Outgoing {
  drafts: CloudMeetingDraft[];
  /** id → fingerprint of the local draft the outgoing row was built from. */
  sentFrom: Map<string, string>;
  pendingDeletes: Record<string, number>;
  /** True when the empty-list guard kicked in and the snapshot was set aside. */
  reset: boolean;
}

/**
 * Diff the local drafts against the snapshot: one outgoing row per draft that
 * is new or changed here (by content or `updatedAt`), one tombstone per draft
 * gone from the list.
 *
 * Guard: a list that is suddenly EMPTY while the snapshot remembers
 * RESET_GUARD_MIN or more drafts is far more likely lost app state than a user
 * who deleted that many inside one debounce window. Tombstoning them would wipe
 * every other device, so the snapshot is set aside and the merge brings the
 * drafts back instead.
 */
export function outgoingChanges(local: readonly MeetingDraft[], state: DraftSyncState, now: number): Outgoing {
  const reset = local.length === 0 && Object.keys(state.synced).length >= RESET_GUARD_MIN;
  const drafts: CloudMeetingDraft[] = [];
  const sentFrom = new Map<string, string>();
  const present = new Set<string>();

  for (const d of local) {
    present.add(d.id);
    const fp = fingerprint(d);
    if (fp === (state.synced[d.id] ?? "") || state.parked[d.id] === fp) continue;
    drafts.push(toCloudDraft(d));
    sentFrom.set(d.id, fp);
  }

  const pendingDeletes: Record<string, number> = {};
  if (!reset) {
    for (const id of Object.keys(state.synced)) {
      if (present.has(id)) continue;
      const at = state.pendingDeletes[id] ?? now;
      pendingDeletes[id] = at;
      drafts.push(tombstone(id, at));
      sentFrom.set(id, "");
    }
  }
  return { drafts, sentFrom, pendingDeletes, reset };
}

/** The result of one exchange with the cloud, ready to be folded in. */
export interface SyncExchange {
  /** Rows from `GET ?since=` (other devices' changes, plus echoes of ours). */
  pulled: CloudMeetingDraft[];
  /** The merged rows the PUTs answered with. */
  pushed: CloudMeetingDraft[];
  /** Refusals, resolved back to the id they were for. */
  rejected: { id: string; error: string }[];
}

/** What to do to the store's list: the result of {@link applyExchange}. */
export interface DraftChanges {
  /** Drafts to write over (or add to) the list; `remindedFor` is filled in by
   *  the store from the local copy. */
  upserts: MeetingDraft[];
  /** Ids to take off the list. */
  removed: string[];
}

/**
 * Fold an exchange into the CURRENT local drafts (re-read after the network
 * round trip) and the snapshot.
 *
 * A pulled row is applied only to a draft untouched here (it still matches the
 * snapshot — a draft that's new on both sides counts: absent = absent); a
 * pushed row only if the draft still looks exactly as it did when sent. Either
 * way the row is the server's last-write-wins result, so applying it is "newer
 * wins": a pushed answer that differs from what was sent means another device's
 * newer write beat ours. Anything edited in the meantime is left alone and goes
 * up next run, where the server compares clocks again.
 */
export function applyExchange(
  local: readonly MeetingDraft[],
  state: DraftSyncState,
  outgoing: Outgoing,
  exchange: SyncExchange,
): { changes: DraftChanges; state: DraftSyncState } {
  const byId = new Map(local.map((d) => [d.id, d]));
  const localFp = (id: string) => fingerprint(byId.get(id));
  const next: DraftSyncState = {
    ...state,
    synced: outgoing.reset ? {} : { ...state.synced },
    pendingDeletes: { ...outgoing.pendingDeletes },
    parked: { ...state.parked },
  };

  const rows = new Map<string, CloudMeetingDraft>();
  for (const row of exchange.pulled) {
    if (typeof row?.id !== "string" || outgoing.sentFrom.has(row.id)) continue;
    const fp = localFp(row.id);
    const untouched = fp === (next.synced[row.id] ?? "");
    // A form parked here loses to a newer write from elsewhere.
    const parkedAndOlder =
      next.parked[row.id] === fp && (byId.get(row.id)?.updatedAt ?? 0) < (row.updatedAt ?? 0);
    if (untouched || parkedAndOlder) rows.set(row.id, row);
  }
  for (const row of exchange.pushed) {
    if (typeof row?.id !== "string") continue;
    if (outgoing.sentFrom.has(row.id) && outgoing.sentFrom.get(row.id) === localFp(row.id)) rows.set(row.id, row);
  }

  recordRejections(exchange.rejected, outgoing, next, byId, localFp);

  const changes: DraftChanges = { upserts: [], removed: [] };
  for (const [id, row] of rows) {
    delete next.pendingDeletes[id];
    delete next.parked[id];
    const current = byId.get(id);
    if (row.deletedAt !== null) {
      delete next.synced[id];
      if (current) changes.removed.push(id);
      continue;
    }
    const draft = fromCloudDraft(row, current?.remindedFor ?? null);
    const fp = fingerprint(draft);
    next.synced[id] = fp;
    if (fp !== localFp(id)) changes.upserts.push(draft);
  }
  return { changes, state: next };
}

/** Permanent refusals: park a local form so it isn't offered again, or drop a
 *  deletion the cloud has no use for. Transient ones are simply retried. */
function recordRejections(
  rejected: SyncExchange["rejected"],
  outgoing: Outgoing,
  state: DraftSyncState,
  byId: Map<string, MeetingDraft>,
  localFp: (id: string) => string,
): void {
  for (const { id, error } of rejected) {
    if (TRANSIENT_REJECTIONS.has(error)) continue;
    const fp = outgoing.sentFrom.get(id);
    if (fp === undefined || fp !== localFp(id)) continue;
    if (byId.has(id)) {
      state.parked[id] = fp;
    } else {
      delete state.synced[id];
      delete state.pendingDeletes[id];
    }
  }
}

/** Split rows into PUT bodies within the server's count and size caps. */
export function batches(drafts: readonly CloudMeetingDraft[]): CloudMeetingDraft[][] {
  const out: CloudMeetingDraft[][] = [];
  const enc = new TextEncoder();
  let cur: CloudMeetingDraft[] = [];
  let bytes = 0;
  for (const d of drafts) {
    const size = enc.encode(JSON.stringify(d)).length + 1;
    if (cur.length > 0 && (cur.length >= PUSH_BATCH || bytes + size > PUSH_MAX_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(d);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ── Persistence ───────────────────────────────────────────────────────────────

function loadState(userId: string): DraftSyncState {
  try {
    const raw = JSON.parse(localStorage.getItem(STATE_KEY) ?? "null") as DraftSyncState | null;
    if (raw?.userId === userId && raw.synced && typeof raw.synced === "object") {
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

function saveState(state: DraftSyncState): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    /* quota — the next run recomputes from scratch */
  }
}

// ── Network ───────────────────────────────────────────────────────────────────

async function pull(cursor: number | null): Promise<{ drafts: CloudMeetingDraft[]; now: number }> {
  const query = cursor === null ? "" : `?since=${cursor}`;
  const res = await cloudFetch(`/v1/drafts${query}`);
  const body = (await res.json()) as { drafts?: CloudMeetingDraft[]; now?: number };
  if (!Array.isArray(body.drafts) || typeof body.now !== "number") {
    throw new TypeError("draft sync: malformed pull response");
  }
  return { drafts: body.drafts, now: body.now };
}

async function push(drafts: CloudMeetingDraft[]): Promise<Omit<SyncExchange, "pulled">> {
  const pushed: CloudMeetingDraft[] = [];
  const rejected: SyncExchange["rejected"] = [];
  for (const batch of batches(drafts)) {
    const res = await cloudFetch("/v1/drafts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drafts: batch }),
    });
    const body = (await res.json()) as { drafts?: CloudMeetingDraft[]; rejected?: CloudDraftRejection[] };
    pushed.push(...(body.drafts ?? []));
    for (const r of body.rejected ?? []) {
      const id = batch[r.index]?.id ?? r.id;
      if (typeof id === "string") rejected.push({ id, error: r.error });
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
/** True while the sync writes its own merge into the store, so the change
 *  subscription doesn't take it for a local edit. */
let applying = false;

async function runOnce(): Promise<void> {
  const userId = currentUserId();
  if (!userId) return;
  lastAttemptAt = Date.now();

  let state = loadState(userId);
  try {
    const outgoing = outgoingChanges(useStore.getState().drafts, state, Date.now());
    if (outgoing.reset) {
      log.warn("draft sync: no local drafts, merging from the cloud instead of deleting", {
        remembered: Object.keys(state.synced).length,
      });
    }
    // Pin the deletion times before going to the network, so a failed run
    // retries with the same ones.
    state = { ...state, pendingDeletes: outgoing.pendingDeletes };
    saveState(state);

    const pulled = await pull(outgoing.reset ? null : state.cursor);
    const { pushed, rejected } = await push(outgoing.drafts);

    // Signed out or switched accounts mid-flight: this result is not theirs.
    if (currentUserId() !== userId) return;

    const applied = applyExchange(useStore.getState().drafts, state, outgoing, {
      pulled: pulled.drafts,
      pushed,
      rejected,
    });
    // The snapshot first: the store write below notifies synchronously, and the
    // change trigger must already see the merge as agreed.
    saveState({ ...applied.state, cursor: pulled.now });
    const { upserts, removed } = applied.changes;
    if (upserts.length || removed.length) {
      applying = true;
      try {
        useStore.getState().mergeCloudDrafts(upserts, removed);
      } finally {
        applying = false;
      }
    }
    if (outgoing.drafts.length || pulled.drafts.length) {
      log.info("draft sync: done", {
        pulled: pulled.drafts.length,
        pushed: outgoing.drafts.length,
        updated: upserts.length,
        removed: removed.length,
        refused: rejected.length,
        codes: [...new Set(rejected.map((r) => r.error))].join(","),
      });
    }
  } catch (error) {
    log.warn("draft sync: failed, will retry on the next trigger", { error: String(error) });
  }
}

/**
 * Sync now. Overlapping calls share one run; a call that arrives mid-run makes
 * it go round once more afterwards, so a change made during a sync is not lost.
 * No-op unless signed in with cloud sync on.
 */
export function syncDrafts(): Promise<void> {
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

/** {@link syncDrafts} from a trigger nothing awaits. */
function syncInBackground(): void {
  syncDrafts().catch((error) => log.warn("draft sync: run failed", { error: String(error) }));
}

/** True when the local drafts differ from what was last synced. */
function hasLocalChanges(): boolean {
  const userId = currentUserId();
  if (!userId) return false;
  return outgoingChanges(useStore.getState().drafts, loadState(userId), Date.now()).drafts.length > 0;
}

/**
 * Wire up the triggers. Call once from the MAIN window — the one that owns the
 * drafts and is alive for the whole session. Returns the cleanup.
 */
export function initDraftSync(): () => void {
  if (!CLOUD_ENABLED || !isTauri()) return () => {};
  const debounce = createDebouncer(SYNC_DEBOUNCE_MS);

  // Launch.
  syncInBackground();

  // Sign-in, sign-out → sign-in as someone else, or the sync toggle turned on.
  const unAccount = subscribeSelected(
    () => currentUserId(),
    (now) => {
      if (now) syncInBackground();
    },
  );

  // A local edit — the draft sheet, an MCP create, a delete, taking one to
  // record — once things have been quiet for a moment. The sync's own merge is
  // skipped, and a reminder firing (remindedFor) diffs clean, so neither
  // schedules another round.
  const unDrafts = subscribeSelected(
    (s) => s.drafts,
    () => {
      if (hasLocalChanges()) debounce.schedule(syncInBackground);
    },
    { skip: () => applying },
  );

  const onFocus = () => {
    if (Date.now() - lastAttemptAt >= FOCUS_SYNC_INTERVAL_MS) syncInBackground();
  };
  window.addEventListener("focus", onFocus);
  const interval = setInterval(syncInBackground, PERIODIC_SYNC_MS);

  return () => {
    debounce.cancel();
    unAccount();
    unDrafts();
    window.removeEventListener("focus", onFocus);
    clearInterval(interval);
  };
}
