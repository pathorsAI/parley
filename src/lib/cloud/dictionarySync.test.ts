import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DictionaryEntry } from "../dictionary";
import type { CloudDictionaryEntry, DictionarySyncState } from "./dictionarySync";

// Dictionary cloud sync: the pure diff/merge, then the runner end to end against
// a fake cloud. The local dictionary, the store and the network are stubbed; the
// snapshot bookkeeping is real, over a Map-backed localStorage.

const backing = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, v),
  removeItem: (k: string) => void backing.delete(k),
});

let localEntries: DictionaryEntry[] = [];
const replaceEntries = vi.fn((next: DictionaryEntry[]) => {
  localEntries = next;
});
vi.mock("../dictionary", () => ({
  listEntries: () => [...localEntries],
  reloadDictionary: vi.fn(async () => {}),
  replaceEntries: (next: DictionaryEntry[]) => replaceEntries(next),
  whenDictionaryReady: () => Promise.resolve(),
  listenForDictionaryUpdated: vi.fn(async () => () => {}),
}));
vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../flags", () => ({ CLOUD_ENABLED: true }));
vi.mock("../tauriEvents", () => ({ isTauri: () => true }));
let userId: string | null = "u1";
vi.mock("../store", () => ({
  useStore: {
    getState: () => ({ cloudAuth: userId ? { user: { id: userId } } : null }),
    subscribe: () => () => {},
  },
}));

type Call = { path: string; method: string; body?: { entries: CloudDictionaryEntry[] } };
let calls: Call[] = [];
let cloud: (call: Call) => unknown = () => ({});
vi.mock("./client", () => ({
  syncEnabled: () => userId !== null,
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

const {
  applyExchange,
  emptySyncState,
  fromCloudSource,
  outgoingChanges,
  readDictionarySyncStatus,
  syncDictionary,
  toCloudSource,
  RESET_GUARD_MIN,
} = await import("./dictionarySync");

const NOW = 1_790_000_000_000;

const local = (over: Partial<DictionaryEntry> = {}): DictionaryEntry => ({
  id: "l1",
  phrase: "Parley",
  variants: ["怕理"],
  createdAt: NOW - 10_000,
  source: "manual",
  ...over,
});

const row = (over: Partial<CloudDictionaryEntry> = {}): CloudDictionaryEntry => ({
  id: "s1",
  phrase: "Parley",
  variants: ["怕理"],
  source: "manual",
  confirmed: true,
  updatedAt: NOW - 5_000,
  deletedAt: null,
  ...over,
});

const stateWith = (synced: DictionarySyncState["synced"], over: Partial<DictionarySyncState> = {}) => ({
  ...emptySyncState("u1"),
  synced,
  ...over,
});

describe("source mapping", () => {
  it("maps the desktop sources onto the shared cloud labels and back", () => {
    expect(toCloudSource("correction")).toBe("learned");
    expect(toCloudSource("mcp")).toBe("imported");
    expect(toCloudSource("manual")).toBe("manual");
    expect(fromCloudSource("learned")).toBe("correction");
    expect(fromCloudSource("imported")).toBe("mcp");
    expect(fromCloudSource("manual")).toBe("manual");
    expect(fromCloudSource("something-new")).toBe("manual");
  });
});

describe("outgoingChanges", () => {
  it("first sync offers every entry, falling back to createdAt for the clock", () => {
    const out = outgoingChanges([local(), local({ id: "l2", phrase: "Cerana", updatedAt: NOW - 1, source: "correction" })], emptySyncState("u1"), NOW);
    expect(out.entries).toEqual([
      row({ id: "l1", updatedAt: NOW - 10_000 }),
      row({ id: "l2", phrase: "Cerana", source: "learned", updatedAt: NOW - 1 }),
    ]);
    expect(out.reset).toBe(false);
  });

  it("skips what matches the snapshot and offers what changed", () => {
    const state = stateWith({
      Parley: { id: "l1", variants: ["怕理"], source: "manual" },
      Cerana: { id: "l2", variants: [], source: "manual" },
    });
    const out = outgoingChanges(
      [local(), local({ id: "l2", phrase: "Cerana", variants: ["色瑞納"], updatedAt: NOW - 3 })],
      state,
      NOW,
    );
    expect(out.entries).toEqual([row({ id: "l2", phrase: "Cerana", variants: ["色瑞納"], updatedAt: NOW - 3 })]);
  });

  it("turns a phrase gone from disk into a tombstone, keeping the first time it was seen gone", () => {
    const state = stateWith(
      { Parley: { id: "s1", variants: ["怕理"], source: "correction" } },
      { pendingDeletes: { Parley: NOW - 60_000 } },
    );
    const out = outgoingChanges([], state, NOW);
    expect(out.entries).toEqual([
      row({ variants: [], source: "learned", updatedAt: NOW - 60_000, deletedAt: NOW - 60_000 }),
    ]);
    expect(out.pendingDeletes).toEqual({ Parley: NOW - 60_000 });
    expect(outgoingChanges([], stateWith(state.synced), NOW).pendingDeletes).toEqual({ Parley: NOW });
  });

  it("collapses a phrase stored twice into one entry under the id the cloud knows", () => {
    const state = stateWith({ Parley: { id: "l2", variants: ["a"], source: "manual" } });
    const out = outgoingChanges(
      [
        local({ id: "l1", variants: ["b"], createdAt: 1, updatedAt: NOW - 1, source: "mcp" }),
        local({ id: "l2", variants: ["a"], createdAt: 2, updatedAt: NOW - 9 }),
      ],
      state,
      NOW,
    );
    expect(out.entries).toEqual([row({ id: "l2", variants: ["b", "a"], source: "imported", updatedAt: NOW - 1 })]);
  });

  it("does not offer a form the cloud already refused for good", () => {
    const entry = local({ phrase: "x".repeat(150) });
    const parked = JSON.stringify([[entry.id, entry.variants, entry.source]]);
    expect(outgoingChanges([entry], stateWith({}, { parked: { [entry.phrase]: parked } }), NOW).entries).toEqual([]);
  });

  it("treats a suddenly empty dictionary as a lost file, not a mass deletion", () => {
    const synced = Object.fromEntries(
      Array.from({ length: RESET_GUARD_MIN }, (_, i) => [`p${i}`, { id: `s${i}`, variants: [], source: "manual" as const }]),
    );
    const out = outgoingChanges([], stateWith(synced), NOW);
    expect(out).toMatchObject({ entries: [], reset: true });
    // Below the threshold, deleting everything is just deleting everything.
    const few = stateWith({ a: { id: "s", variants: [], source: "manual" } });
    expect(outgoingChanges([], few, NOW).entries).toHaveLength(1);
  });
});

describe("applyExchange", () => {
  it("applies other devices' rows to untouched phrases: adds, updates, deletes", () => {
    const state = stateWith({
      Parley: { id: "s1", variants: ["怕理"], source: "manual" },
      Gone: { id: "s2", variants: [], source: "manual" },
    });
    const current = [local({ id: "s1" }), local({ id: "s2", phrase: "Gone", variants: [] })];
    const out = outgoingChanges(current, state, NOW);
    const res = applyExchange(current, state, out, {
      pulled: [
        row({ variants: ["怕理", "帕力"], source: "learned", updatedAt: NOW - 1 }),
        row({ id: "s2", phrase: "Gone", variants: [], updatedAt: NOW - 1, deletedAt: NOW - 1 }),
        row({ id: "s3", phrase: "Cerana", variants: [], updatedAt: NOW - 2 }),
      ],
      pushed: [],
      rejected: [],
    });
    expect(res.entries).toEqual([
      local({ id: "s1", variants: ["怕理", "帕力"], source: "correction", updatedAt: NOW - 1 }),
      { id: "s3", phrase: "Cerana", variants: [], createdAt: NOW - 2, updatedAt: NOW - 2, source: "manual" },
    ]);
    expect(res.state.synced).toEqual({
      Parley: { id: "s1", variants: ["怕理", "帕力"], source: "correction" },
      Cerana: { id: "s3", variants: [], source: "manual" },
    });
  });

  it("never lets a pulled row overwrite a local edit", () => {
    const state = stateWith({ Parley: { id: "s1", variants: ["怕理"], source: "manual" } });
    const sent = [local({ id: "s1", variants: ["mine"], updatedAt: NOW - 1 })];
    const out = outgoingChanges(sent, state, NOW);
    // Edited during the round trip, too: neither the pulled nor the pushed row applies.
    const edited = [local({ id: "s1", variants: ["mine", "more"], updatedAt: NOW })];
    const res = applyExchange(edited, state, out, {
      pulled: [row({ variants: ["theirs"] })],
      pushed: [row({ variants: ["mine"], updatedAt: NOW - 1 })],
      rejected: [],
    });
    expect(res.entries).toBeNull();
    expect(res.state.synced.Parley.variants).toEqual(["怕理"]);
  });

  it("adopts the merged row the push answered with, including the cloud's id", () => {
    const current = [local({ id: "l1", variants: ["怕理"] })];
    const out = outgoingChanges(current, emptySyncState("u1"), NOW);
    const res = applyExchange(current, emptySyncState("u1"), out, {
      pulled: [row({ id: "phone", variants: ["帕力"] })],
      pushed: [row({ id: "phone", variants: ["帕力", "怕理"], updatedAt: NOW - 10_000 })],
      rejected: [],
    });
    expect(res.entries).toEqual([local({ id: "phone", variants: ["帕力", "怕理"], updatedAt: NOW - 10_000 })]);
    expect(res.state.synced.Parley.id).toBe("phone");
  });

  it("clears a confirmed deletion, and brings the entry back when a newer edit won", () => {
    const state = stateWith({ Parley: { id: "s1", variants: ["怕理"], source: "manual" } });
    const out = outgoingChanges([], state, NOW);
    const confirmed = applyExchange([], state, out, {
      pulled: [],
      pushed: [row({ variants: [], updatedAt: NOW, deletedAt: NOW })],
      rejected: [],
    });
    expect(confirmed.entries).toEqual([]);
    expect(confirmed.state).toMatchObject({ synced: {}, pendingDeletes: {} });

    const lost = applyExchange([], state, out, {
      pulled: [],
      pushed: [row({ variants: ["newer"], updatedAt: NOW + 1 })],
      rejected: [],
    });
    expect(lost.entries).toEqual([
      { id: "s1", phrase: "Parley", variants: ["newer"], createdAt: NOW + 1, updatedAt: NOW + 1, source: "manual" },
    ]);
  });

  it("parks a permanently refused form but retries a transient refusal", () => {
    const current = [local({ phrase: "Long" }), local({ id: "l2", phrase: "Full" })];
    const out = outgoingChanges(current, emptySyncState("u1"), NOW);
    const res = applyExchange(current, emptySyncState("u1"), out, {
      pulled: [],
      pushed: [],
      rejected: [
        { phrase: "Long", error: "phrase_too_long" },
        { phrase: "Full", error: "entry_limit" },
      ],
    });
    expect(Object.keys(res.state.parked)).toEqual(["Long"]);
    expect(outgoingChanges(current, res.state, NOW).entries.map((e) => e.phrase)).toEqual(["Full"]);
  });

  it("keeps local ids unique when a cloud row claims one held by another phrase", () => {
    const current = [local({ id: "x", phrase: "Renamed" })];
    const state = stateWith({ Renamed: { id: "x", variants: ["怕理"], source: "manual" } });
    const out = outgoingChanges(current, state, NOW);
    const res = applyExchange(
      current,
      state,
      out,
      { pulled: [row({ id: "x", phrase: "Old", variants: [] })], pushed: [], rejected: [] },
      () => "fresh",
    );
    expect(res.entries?.map((e) => [e.id, e.phrase])).toEqual([
      ["fresh", "Renamed"],
      ["x", "Old"],
    ]);
  });
});

describe("syncDictionary", () => {
  beforeEach(() => {
    backing.clear();
    calls = [];
    userId = "u1";
    localEntries = [];
    replaceEntries.mockClear();
  });

  it("pulls, pushes, writes the merge, and pages from the returned cursor next time", async () => {
    localEntries = [local({ id: "l1", variants: ["怕理"], updatedAt: NOW - 1 })];
    cloud = (call) =>
      call.method === "GET"
        ? { entries: [row({ id: "s9", phrase: "Cerana", variants: [] })], now: NOW }
        : { entries: [row({ id: "l1", updatedAt: NOW - 1 })], rejected: [], now: NOW };
    await syncDictionary();

    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ["GET", "/v1/dictionary"],
      ["PUT", "/v1/dictionary"],
    ]);
    expect(calls[1].body?.entries).toEqual([row({ id: "l1", updatedAt: NOW - 1 })]);
    expect(localEntries.map((e) => e.phrase).sort()).toEqual(["Cerana", "Parley"]);
    expect(readDictionarySyncStatus()).toMatchObject({ state: "ok" });

    // Nothing changed locally: the next run only pulls, from the saved cursor.
    calls = [];
    cloud = () => ({ entries: [], now: NOW + 5 });
    await syncDictionary();
    expect(calls.map((c) => [c.method, c.path])).toEqual([["GET", `/v1/dictionary?since=${NOW}`]]);
  });

  it("a failed run changes nothing, keeps the cursor, and reports the error", async () => {
    localEntries = [local()];
    cloud = () => {
      throw new Error("offline");
    };
    await syncDictionary();
    expect(replaceEntries).not.toHaveBeenCalled();
    expect(readDictionarySyncStatus()).toMatchObject({ state: "error", lastSyncedAt: null });
    const saved = JSON.parse(backing.get("parley:dictionarySync") ?? "{}") as DictionarySyncState;
    expect(saved.cursor).toBeNull();
  });

  it("does nothing while signed out", async () => {
    userId = null;
    await syncDictionary();
    expect(calls).toEqual([]);
  });

  it("starts over for a different account instead of deleting its entries", async () => {
    backing.set(
      "parley:dictionarySync",
      JSON.stringify(stateWith({ Old: { id: "o", variants: [], source: "manual" } }, { userId: "someone-else", cursor: NOW })),
    );
    cloud = (call) => (call.method === "GET" ? { entries: [], now: NOW } : { entries: [], rejected: [], now: NOW });
    await syncDictionary();
    // A full pull (no cursor carried over), and no tombstone for "Old".
    expect(calls.map((c) => [c.method, c.path])).toEqual([["GET", "/v1/dictionary"]]);
  });
});
