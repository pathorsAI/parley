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
  setItem: (k: string, v: string) => {
    writes++;
    backing.set(k, v);
  },
  removeItem: (k: string) => void backing.delete(k),
});

let writes = 0;
const {
  clearCloudGone,
  isCloudGone,
  markCloudGone,
  markDirty,
  pruneSyncMeta,
  readSyncIndex,
  setSynced,
  setSyncedMany,
} = await import("./syncState");

beforeEach(() => {
  backing.clear();
  reads = 0;
  writes = 0;
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

  it("markCloudGone flags a batch in one read and one write, keeping other facts", () => {
    setSynced("a", 5);
    markDirty("b");
    reads = 0;
    writes = 0;
    expect(markCloudGone(["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(reads).toBe(1);
    expect(writes).toBe(1);
    expect(readSyncIndex()).toEqual({
      a: { cloudUpdatedAt: 5, dirty: false, cloudGone: true },
      b: { dirty: true, cloudGone: true },
      c: { cloudGone: true },
    });
  });

  it("markCloudGone reports only newly flagged ids and skips the write when none", () => {
    markCloudGone(["a"]);
    writes = 0;
    expect(markCloudGone(["a"])).toEqual([]);
    expect(writes).toBe(0);
    expect(markCloudGone(["a", "b"])).toEqual(["b"]);
  });

  it("isCloudGone reads the flag", () => {
    markCloudGone(["a"]);
    expect(isCloudGone("a")).toBe(true);
    expect(isCloudGone("b")).toBe(false);
  });

  it("an edit to a gone entry stays gone (markDirty keeps the flag)", () => {
    markCloudGone(["a"]);
    markDirty("a");
    expect(readSyncIndex().a).toEqual({ cloudGone: true, dirty: true });
  });

  it("a confirmed sync drops the flag", () => {
    markCloudGone(["a"]);
    setSynced("a", 9);
    expect(readSyncIndex().a).toEqual({ cloudUpdatedAt: 9, dirty: false });
  });

  it("clearCloudGone removes only the flag", () => {
    setSynced("a", 5);
    markCloudGone(["a"]);
    writes = 0;
    clearCloudGone(["a", "never-flagged"]);
    expect(writes).toBe(1);
    expect(readSyncIndex().a).toEqual({ cloudUpdatedAt: 5, dirty: false });
    writes = 0;
    clearCloudGone(["a"]);
    expect(writes).toBe(0);
  });

  it("prune keeps a gone entry while its local copy exists, then drops it", () => {
    markCloudGone(["local-only"]);
    // The listing keeps local ∪ cloud ids; a gone id is only local.
    pruneSyncMeta(new Set(["local-only"]));
    expect(readSyncIndex()["local-only"]).toEqual({ cloudGone: true });
    pruneSyncMeta(new Set());
    expect(readSyncIndex()).toEqual({});
  });
});
