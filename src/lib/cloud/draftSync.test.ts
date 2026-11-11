import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeetingDraft } from "../store/prep";
import type { CloudMeetingDraft, DraftSyncState } from "./draftSync";

// Meeting-draft cloud sync: the pure diff/merge, then the runner end to end
// against a fake cloud over the REAL store (so the prep slice's merge action,
// remindedFor and the loaded draft's prep fields are exercised for real). The
// network is stubbed; the snapshot bookkeeping runs over a Map-backed
// localStorage.

const backing = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, v),
  removeItem: (k: string) => void backing.delete(k),
});

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../flags", async (importOriginal) => ({ ...(await importOriginal<object>()), CLOUD_ENABLED: true }));
let tauri = false;
vi.mock("../tauriEvents", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauri: () => tauri,
}));

type Call = { path: string; method: string; body?: { drafts: CloudMeetingDraft[] } };
let calls: Call[] = [];
let cloud: (call: Call) => unknown = () => ({});
vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  syncEnabled: () => true,
  cloudFetch: vi.fn(async (path: string, init?: RequestInit) => {
    const call: Call = {
      path,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const body = cloud(call);
    return { json: async () => body };
  }),
}));

// The store first: prep.ts reaches it through ./meeting.
const { useStore } = await import("../store");
const { CLEARED_PREP_SLICE } = await import("../store/prep");
const {
  applyExchange,
  batches,
  emptySyncState,
  fingerprint,
  fromCloudDraft,
  initDraftSync,
  outgoingChanges,
  syncDrafts,
  toCloudDraft,
  PUSH_BATCH,
  RESET_GUARD_MIN,
  SYNC_DEBOUNCE_MS,
  PERIODIC_SYNC_MS,
} = await import("./draftSync");

const NOW = 1_790_000_000_000;

const draft = (over: Partial<MeetingDraft> = {}): MeetingDraft => ({
  id: "d1",
  title: "Pricing call",
  meetingAt: NOW + 3_600_000,
  meetingEndAt: NOW + 7_200_000,
  reminderLeadMin: 5,
  remindedFor: null,
  meetingContext: "Dana, CFO",
  meetingBatna: "",
  meetingTarget: "",
  meetingFloor: "",
  todos: [{ id: "t1", text: "Ask budget", done: false }],
  meetingFolderId: null,
  meetingOrgShare: null,
  updatedAt: NOW - 10_000,
  ...over,
});

const row = (over: Partial<CloudMeetingDraft> = {}): CloudMeetingDraft => ({
  ...toCloudDraft(draft()),
  ...over,
});

const stateWith = (drafts: MeetingDraft[], over: Partial<DraftSyncState> = {}): DraftSyncState => ({
  ...emptySyncState("u1"),
  synced: Object.fromEntries(drafts.map((d) => [d.id, fingerprint(d)])),
  ...over,
});

const noExchange = { pulled: [], pushed: [], rejected: [] };

describe("mapping", () => {
  it("drops remindedFor on the way up and takes the caller's on the way down", () => {
    const up = toCloudDraft(draft({ remindedFor: 123 }));
    expect(up).not.toHaveProperty("remindedFor");
    expect(up.deletedAt).toBeNull();
    expect(fromCloudDraft(up, 77)).toEqual(draft({ remindedFor: 77 }));
  });

  it("passes the org share through, extra keys included, and fingerprints it order-free", () => {
    const share = { orgId: "acme", folderId: "f1", mode: "move" as const };
    expect(toCloudDraft(draft({ meetingOrgShare: share })).meetingOrgShare).toEqual(share);
    const reordered = { mode: "move" as const, folderId: "f1", orgId: "acme" };
    expect(fingerprint(draft({ meetingOrgShare: reordered }))).toBe(fingerprint(draft({ meetingOrgShare: share })));
    // A share created in the cloud has no mode; it is kept as sent.
    expect(fromCloudDraft(row({ meetingOrgShare: { orgId: "acme", folderId: null } }), null).meetingOrgShare).toEqual({
      orgId: "acme",
      folderId: null,
    });
  });

  it("splits a push at the server's count cap", () => {
    const rows = Array.from({ length: PUSH_BATCH + 1 }, (_, i) => row({ id: `d${i}` }));
    expect(batches(rows).map((b) => b.length)).toEqual([PUSH_BATCH, 1]);
    const big = row({ meetingContext: "字".repeat(20_000) });
    expect(batches(Array.from({ length: 20 }, (_, i) => ({ ...big, id: `b${i}` }))).length).toBeGreaterThan(1);
  });
});

describe("outgoingChanges", () => {
  it("first sync offers every draft", () => {
    const out = outgoingChanges([draft(), draft({ id: "d2", meetingAt: null })], emptySyncState("u1"), NOW);
    expect(out.drafts.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(out.reset).toBe(false);
  });

  it("offers what changed in content or clock, and nothing else", () => {
    const state = stateWith([draft(), draft({ id: "d2" }), draft({ id: "d3" })]);
    const out = outgoingChanges(
      [draft(), draft({ id: "d2", title: "Renamed", updatedAt: NOW }), draft({ id: "d3", updatedAt: NOW })],
      state,
      NOW,
    );
    expect(out.drafts.map((d) => d.id)).toEqual(["d2", "d3"]);
  });

  it("does not take a reminder firing for an edit", () => {
    const state = stateWith([draft()]);
    expect(outgoingChanges([draft({ remindedFor: NOW + 3_600_000 })], state, NOW).drafts).toEqual([]);
  });

  it("turns a draft gone from the list into a tombstone, keeping the first time it was seen gone", () => {
    const state = stateWith([draft()], { pendingDeletes: { d1: NOW - 60_000 } });
    const out = outgoingChanges([], state, NOW);
    expect(out.drafts).toEqual([
      expect.objectContaining({ id: "d1", title: "", meetingContext: "", todos: [], updatedAt: NOW - 60_000, deletedAt: NOW - 60_000 }),
    ]);
    expect(out.pendingDeletes).toEqual({ d1: NOW - 60_000 });
    // Not pinned yet: noticed now.
    expect(outgoingChanges([], stateWith([draft()]), NOW).pendingDeletes).toEqual({ d1: NOW });
  });

  it("does not offer a form the cloud already refused for good", () => {
    const d = draft({ title: "x".repeat(300) });
    expect(outgoingChanges([d], emptySyncState("u1"), NOW).drafts).toHaveLength(1);
    expect(outgoingChanges([d], stateWith([], { parked: { d1: fingerprint(d) } }), NOW).drafts).toEqual([]);
  });

  it("treats a suddenly empty list as lost state, not a mass deletion", () => {
    const many = Array.from({ length: RESET_GUARD_MIN }, (_, i) => draft({ id: `d${i}` }));
    expect(outgoingChanges([], stateWith(many), NOW)).toMatchObject({ drafts: [], reset: true });
    expect(outgoingChanges([], stateWith(many.slice(1)), NOW).drafts).toHaveLength(RESET_GUARD_MIN - 1);
  });
});

describe("applyExchange", () => {
  it("applies other devices' rows to untouched drafts: adds, updates, deletes", () => {
    const local = [draft({ remindedFor: 5 }), draft({ id: "gone" })];
    const state = stateWith(local);
    const out = outgoingChanges(local, state, NOW);
    const res = applyExchange(local, state, out, {
      pulled: [
        row({ title: "Moved", updatedAt: NOW - 1 }),
        row({ id: "gone", updatedAt: NOW - 1, deletedAt: NOW - 1 }),
        row({ id: "new", title: "From MCP", updatedAt: NOW - 2 }),
        row({ id: "never-here", deletedAt: NOW - 3 }),
      ],
      pushed: [],
      rejected: [],
    });
    expect(res.changes.removed).toEqual(["gone"]);
    expect(res.changes.upserts).toEqual([
      draft({ title: "Moved", updatedAt: NOW - 1, remindedFor: 5 }),
      draft({ id: "new", title: "From MCP", updatedAt: NOW - 2 }),
    ]);
    expect(Object.keys(res.state.synced).sort()).toEqual(["d1", "new"]);
  });

  it("an echo of what is already here changes nothing", () => {
    const local = [draft()];
    const state = stateWith(local);
    const res = applyExchange(local, state, outgoingChanges(local, state, NOW), { ...noExchange, pulled: [row()] });
    expect(res.changes).toEqual({ upserts: [], removed: [] });
  });

  it("local wins when newer: a pulled row never overwrites a local edit", () => {
    const state = stateWith([draft()]);
    const sent = [draft({ title: "Mine", updatedAt: NOW })];
    const out = outgoingChanges(sent, state, NOW);
    // Edited again during the round trip: neither the pulled nor the pushed row applies.
    const edited = [draft({ title: "Mine, again", updatedAt: NOW + 1 })];
    const res = applyExchange(edited, state, out, {
      pulled: [row({ title: "Theirs", updatedAt: NOW - 1 })],
      pushed: [row({ title: "Mine", updatedAt: NOW })],
      rejected: [],
    });
    expect(res.changes).toEqual({ upserts: [], removed: [] });
    expect(res.state.synced.d1).toBe(fingerprint(draft()));
  });

  it("remote wins when newer: the push answers with the other device's later write", () => {
    const state = stateWith([draft()]);
    const local = [draft({ title: "Mine", updatedAt: NOW, remindedFor: 9 })];
    const out = outgoingChanges(local, state, NOW);
    const res = applyExchange(local, state, out, {
      pulled: [],
      pushed: [row({ title: "Theirs", updatedAt: NOW + 5 })],
      rejected: [],
    });
    expect(res.changes.upserts).toEqual([draft({ title: "Theirs", updatedAt: NOW + 5, remindedFor: 9 })]);
    expect(res.state.synced.d1).toBe(fingerprint(draft({ title: "Theirs", updatedAt: NOW + 5 })));
  });

  it("clears a confirmed deletion, and brings the draft back when a newer edit beat it", () => {
    const state = stateWith([draft()]);
    const out = outgoingChanges([], state, NOW);
    const confirmed = applyExchange([], state, out, {
      ...noExchange,
      pushed: [row({ updatedAt: NOW, deletedAt: NOW })],
    });
    expect(confirmed.changes).toEqual({ upserts: [], removed: [] });
    expect(confirmed.state).toMatchObject({ synced: {}, pendingDeletes: {} });

    const lost = applyExchange([], state, out, { ...noExchange, pushed: [row({ title: "Newer", updatedAt: NOW + 1 })] });
    expect(lost.changes.upserts).toEqual([draft({ title: "Newer", updatedAt: NOW + 1 })]);
  });

  it("parks an invalid draft, retries a conflict, and drops a refused tombstone", () => {
    const local = [draft({ id: "bad" }), draft({ id: "busy" })];
    const state = stateWith([draft({ id: "gone" })]);
    const out = outgoingChanges(local, state, NOW);
    const res = applyExchange(local, state, out, {
      pulled: [],
      pushed: [],
      rejected: [
        { id: "bad", error: "invalid" },
        { id: "busy", error: "conflict" },
        { id: "gone", error: "invalid" },
      ],
    });
    expect(Object.keys(res.state.parked)).toEqual(["bad"]);
    expect(res.state.synced).toEqual({});
    expect(res.state.pendingDeletes).toEqual({});
    expect(outgoingChanges(local, res.state, NOW).drafts.map((d) => d.id)).toEqual(["busy"]);
    // An edit un-parks it.
    const edited = [draft({ id: "bad", title: "fixed", updatedAt: NOW + 1 }), local[1]];
    expect(outgoingChanges(edited, res.state, NOW).drafts.map((d) => d.id)).toEqual(["bad", "busy"]);
  });
});

describe("mergeCloudDrafts (store)", () => {
  beforeEach(() => useStore.setState({ drafts: [] }));

  it("replaces by id keeping remindedFor, adds unreminded, removes", () => {
    useStore.setState({ drafts: [draft({ remindedFor: 42 }), draft({ id: "d2" })] });
    useStore
      .getState()
      .mergeCloudDrafts([draft({ title: "Remote", remindedFor: 7 }), draft({ id: "d3", remindedFor: 7 })], ["d2"]);
    expect(useStore.getState().drafts).toEqual([
      draft({ title: "Remote", remindedFor: 42 }),
      draft({ id: "d3", remindedFor: null }),
    ]);
  });

  it("leaves the list (and its identity) alone when there is nothing to do", () => {
    const before = [draft()];
    useStore.setState({ drafts: before });
    useStore.getState().mergeCloudDrafts([], []);
    expect(useStore.getState().drafts).toBe(before);
  });
});

const signIn = () =>
  useStore.setState({ cloudAuth: { token: "t", user: { id: "u1", name: "U", email: "u@x" }, activeOrganizationId: null } });

const savedState = () => JSON.parse(backing.get("parley:draftSync") ?? "null") as DraftSyncState | null;

describe("syncDrafts", () => {
  beforeEach(() => {
    backing.clear();
    calls = [];
    signIn();
    useStore.setState({ drafts: [], editingDraftId: null, ...CLEARED_PREP_SLICE });
    useStore.setState((s) => ({ settings: { ...s.settings, syncEnabled: true } }));
  });

  it("first sync uploads everything and pages from the returned cursor next time", async () => {
    useStore.setState({ drafts: [draft(), draft({ id: "d2" })] });
    cloud = (call) =>
      call.method === "GET" ? { drafts: [], now: NOW } : { drafts: call.body!.drafts, rejected: [], now: NOW };
    await syncDrafts();
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ["GET", "/v1/drafts"],
      ["PUT", "/v1/drafts"],
    ]);
    expect(calls[1].body!.drafts.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(calls[1].body!.drafts[0]).not.toHaveProperty("remindedFor");
    expect(savedState()?.cursor).toBe(NOW);

    calls = [];
    cloud = () => ({ drafts: [], now: NOW + 5 });
    await syncDrafts();
    expect(calls.map((c) => [c.method, c.path])).toEqual([["GET", `/v1/drafts?since=${NOW}`]]);
  });

  it("a local edit goes up; a local delete goes up as a tombstone", async () => {
    useStore.setState({ drafts: [draft(), draft({ id: "d2" })] });
    backing.set("parley:draftSync", JSON.stringify(stateWith([draft(), draft({ id: "d2" })], { cursor: NOW })));
    useStore.setState({ drafts: [draft({ title: "Edited", updatedAt: NOW })] });
    cloud = (call) =>
      call.method === "GET" ? { drafts: [], now: NOW + 1 } : { drafts: call.body!.drafts, rejected: [], now: NOW + 1 };
    await syncDrafts();
    const sent = calls.find((c) => c.method === "PUT")!.body!.drafts;
    expect(sent.map((d) => [d.id, d.title, d.deletedAt === null])).toEqual([
      ["d1", "Edited", true],
      ["d2", "", false],
    ]);
    expect(savedState()).toMatchObject({ pendingDeletes: {}, cursor: NOW + 1 });
    expect(Object.keys(savedState()!.synced)).toEqual(["d1"]);
  });

  it("applies remote new / changed / deleted drafts to the list, keeping remindedFor", async () => {
    const here = [draft({ remindedFor: NOW + 3_600_000 }), draft({ id: "gone" })];
    useStore.setState({ drafts: here });
    backing.set("parley:draftSync", JSON.stringify(stateWith(here, { cursor: NOW })));
    cloud = () => ({
      drafts: [
        row({ title: "Retitled elsewhere", updatedAt: NOW + 1 }),
        row({ id: "gone", deletedAt: NOW + 1, updatedAt: NOW + 1 }),
        row({ id: "mcp", title: "Created over MCP", updatedAt: NOW + 2 }),
      ],
      now: NOW + 10,
    });
    await syncDrafts();
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(useStore.getState().drafts).toEqual([
      draft({ title: "Retitled elsewhere", updatedAt: NOW + 1, remindedFor: NOW + 3_600_000 }),
      draft({ id: "mcp", title: "Created over MCP", updatedAt: NOW + 2, remindedFor: null }),
    ]);
  });

  it("never touches the prep fields of the draft loaded for editing", async () => {
    useStore.setState({ drafts: [draft()] });
    backing.set("parley:draftSync", JSON.stringify(stateWith([draft()], { cursor: NOW })));
    useStore.getState().editDraft("d1");
    useStore.getState().setMeetingContext("typing…");
    const prep = () => {
      const s = useStore.getState();
      return [s.editingDraftId, s.meetingTitle, s.meetingContext, s.meetingAt, s.todos];
    };
    const before = prep();
    cloud = () => ({
      drafts: [row({ title: "Remote", meetingContext: "remote ctx", todos: [], updatedAt: NOW + 1 })],
      now: NOW + 10,
    });
    await syncDrafts();
    expect(prep()).toEqual(before);
    expect(useStore.getState().drafts[0].title).toBe("Remote");
    // The user's save afterwards is the newer write and goes up.
    useStore.getState().saveDraft();
    const saved = useStore.getState().drafts[0];
    expect(saved).toMatchObject({ title: "Pricing call", meetingContext: "typing…" });
    expect(saved.updatedAt).toBeGreaterThan(NOW + 1);
    expect(outgoingChanges(useStore.getState().drafts, savedState()!, Date.now()).drafts.map((d) => d.id)).toEqual(["d1"]);
  });

  it("a failed GET or PUT changes nothing, keeps the cursor and the pinned deletion time", async () => {
    const here = [draft(), draft({ id: "gone" })];
    backing.set("parley:draftSync", JSON.stringify(stateWith(here, { cursor: NOW })));
    useStore.setState({ drafts: [draft({ title: "Edited", updatedAt: NOW + 1 })] });
    const list = useStore.getState().drafts;

    cloud = () => {
      throw new Error("offline");
    };
    await syncDrafts();
    const pinned = savedState()!.pendingDeletes.gone;
    expect(savedState()!.cursor).toBe(NOW);
    expect(useStore.getState().drafts).toBe(list);

    cloud = (call) => {
      if (call.method === "PUT") throw new Error("503");
      return { drafts: [row({ title: "Theirs", updatedAt: NOW + 2 })], now: NOW + 20 };
    };
    await new Promise((r) => setTimeout(r, 5));
    await syncDrafts();
    expect(savedState()!.cursor).toBe(NOW);
    expect(savedState()!.pendingDeletes.gone).toBe(pinned);
    expect(useStore.getState().drafts).toBe(list);
    expect(calls.filter((c) => c.method === "PUT").every((c) => c.body!.drafts[1].deletedAt === pinned)).toBe(true);
  });

  it("does nothing while signed out", async () => {
    useStore.setState({ cloudAuth: null, drafts: [draft()] });
    await syncDrafts();
    expect(calls).toEqual([]);
  });

  it("starts over for a different account instead of deleting its drafts", async () => {
    backing.set("parley:draftSync", JSON.stringify(stateWith([draft({ id: "old" })], { userId: "someone-else", cursor: NOW })));
    cloud = () => ({ drafts: [], now: NOW });
    await syncDrafts();
    expect(calls.map((c) => [c.method, c.path])).toEqual([["GET", "/v1/drafts"]]);
  });
});

describe("initDraftSync triggers", () => {
  let stop: (() => void) | undefined;
  beforeEach(() => {
    backing.clear();
    calls = [];
    tauri = true;
    vi.stubGlobal("window", new EventTarget());
    vi.useFakeTimers();
    signIn();
    useStore.setState({ drafts: [], editingDraftId: null, ...CLEARED_PREP_SLICE });
    useStore.setState((s) => ({ settings: { ...s.settings, syncEnabled: true } }));
  });
  afterEach(() => {
    stop?.();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    });
    tauri = false;
  });

  it("syncs at launch, after a local change, and on the interval — but not after applying its own merge", async () => {
    let remote: CloudMeetingDraft[] = [row({ id: "mcp", title: "From MCP", updatedAt: NOW })];
    cloud = (call) =>
      call.method === "GET"
        ? { drafts: remote, now: NOW }
        : { drafts: call.body!.drafts, rejected: [], now: NOW };
    stop = initDraftSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(useStore.getState().drafts.map((d) => d.id)).toEqual(["mcp"]);

    // The merge it just applied does not schedule another round.
    calls = [];
    remote = [];
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS * 2);
    expect(calls).toEqual([]);

    // A reminder firing changes the list but not what syncs.
    useStore.getState().markDraftReminded("mcp", NOW);
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS * 2);
    expect(calls).toEqual([]);

    // A local edit goes up once things are quiet.
    useStore.getState().deleteDraft("mcp");
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS - 100);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
    expect(calls[1].body!.drafts[0]).toMatchObject({ id: "mcp" });
    expect(calls[1].body!.drafts[0].deletedAt).not.toBeNull();

    // The periodic pull.
    calls = [];
    await vi.advanceTimersByTimeAsync(PERIODIC_SYNC_MS);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });
});
