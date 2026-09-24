import { beforeEach, describe, expect, it, vi } from "vitest";

// Back localStorage with a Map, counting reads, so the tests can pin both the
// bookkeeping itself and how often the whole index gets re-parsed.
const backing = new Map<string, string>();
let reads = 0;
vi.stubGlobal("localStorage", {
  getItem: (k: string) => {
    reads++;
    return backing.get(k) ?? null;
  },
  setItem: (k: string, v: string) => void backing.set(k, v),
  removeItem: (k: string) => void backing.delete(k),
});

const { markDirty, pruneSyncMeta, readSyncIndex, setSynced, setSyncedMany } = await import(
  "./syncState"
);

beforeEach(() => {
  backing.clear();
  reads = 0;
});

describe("syncState", () => {
  it("setSyncedMany records every baseline in one read", () => {
    markDirty("a");
    reads = 0;
    setSyncedMany([
      ["a", 10],
      ["b", 20],
      ["c", 30],
    ]);
    expect(reads).toBe(1);
    expect(readSyncIndex()).toEqual({
      a: { cloudUpdatedAt: 10, dirty: false },
      b: { cloudUpdatedAt: 20, dirty: false },
      c: { cloudUpdatedAt: 30, dirty: false },
    });
  });

  it("setSyncedMany with nothing to record touches nothing", () => {
    setSyncedMany([]);
    expect(reads).toBe(0);
    expect(backing.size).toBe(0);
  });

  it("setSynced clears dirty, like a batch of one", () => {
    markDirty("a");
    setSynced("a", 5);
    expect(readSyncIndex().a).toEqual({ cloudUpdatedAt: 5, dirty: false });
  });

  it("markDirty keeps the known cloud version", () => {
    setSynced("a", 5);
    markDirty("a");
    expect(readSyncIndex().a).toEqual({ cloudUpdatedAt: 5, dirty: true });
  });

  it("prune drops ids that exist nowhere", () => {
    setSyncedMany([
      ["keep", 1],
      ["gone", 2],
    ]);
    pruneSyncMeta(new Set(["keep"]));
    expect(Object.keys(readSyncIndex())).toEqual(["keep"]);
  });

  it("a corrupt index reads as empty", () => {
    backing.set("parley:cloudSync", "{not json");
    expect(readSyncIndex()).toEqual({});
  });
});
