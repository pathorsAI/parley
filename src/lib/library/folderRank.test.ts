import { describe, it, expect } from "vitest";
import type { Folder } from "../history/folders";
import {
  MAX_OPENS_PER_FOLDER,
  frecency,
  rankFolders,
  readFolderOpens,
  readOrgFolderOpens,
  recordFolderOpen,
  recordOrgFolderOpen,
  recordingTimesByFolder,
} from "./folderRank";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000 * DAY;

const folder = (id: string, createdAt: number, pinnedAt?: number): Folder =>
  pinnedAt === undefined ? { id, name: id, createdAt } : { id, name: id, createdAt, pinnedAt };

const ids = (fs: readonly Folder[]) => fs.map((f) => f.id);
const none = { opens: {}, recordingTimes: {}, now: NOW };

function memoryStorage(initial?: string, key = "parley:folder-opens") {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(key, initial);
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe("frecency", () => {
  it("counts a use from right now as one, and halves it every fourteen days", () => {
    expect(frecency([NOW], NOW)).toBeCloseTo(1);
    expect(frecency([NOW - 14 * DAY], NOW)).toBeCloseTo(0.5);
    expect(frecency([NOW - 28 * DAY], NOW)).toBeCloseTo(0.25);
  });

  it("does not let a future timestamp count for more than one", () => {
    expect(frecency([NOW + 5 * DAY], NOW)).toBeCloseTo(1);
  });
});

describe("rankFolders", () => {
  it("puts pinned folders first, in the order they were pinned", () => {
    const folders = [folder("a", 1), folder("b", 2, 30), folder("c", 3), folder("d", 4, 10)];
    const busy = { ...none, opens: { a: [NOW, NOW, NOW], c: [NOW] } };
    expect(ids(rankFolders(folders, busy))).toEqual(["d", "b", "a", "c"]);
  });

  it("orders the rest by use, opens and recordings weighing the same", () => {
    const folders = [folder("a", 1), folder("b", 2), folder("c", 3)];
    const ranked = rankFolders(folders, {
      opens: { b: [NOW] },
      recordingTimes: { c: [NOW, NOW - DAY] },
      now: NOW,
    });
    expect(ids(ranked)).toEqual(["c", "b", "a"]);
  });

  it("lets recent use beat heavy use that has gone stale", () => {
    const folders = [folder("old", 1), folder("new", 2)];
    const ranked = rankFolders(folders, {
      opens: { old: Array.from({ length: 20 }, () => NOW - 120 * DAY), new: [NOW - DAY, NOW] },
      recordingTimes: {},
      now: NOW,
    });
    expect(ids(ranked)).toEqual(["new", "old"]);
  });

  it("breaks ties by creation, oldest first", () => {
    const folders = [folder("late", 9), folder("early", 1), folder("mid", 5)];
    expect(ids(rankFolders(folders, none))).toEqual(["early", "mid", "late"]);
  });

  it("does not mutate its input", () => {
    const folders = [folder("b", 2), folder("a", 1)];
    rankFolders(folders, none);
    expect(ids(folders)).toEqual(["b", "a"]);
  });
});

describe("recordingTimesByFolder", () => {
  it("groups filed recordings by folder and skips the unfiled", () => {
    expect(
      recordingTimesByFolder([
        { folderId: "a", createdAt: 1 },
        { folderId: null, createdAt: 2 },
        { createdAt: 3 },
        { folderId: "a", createdAt: 4 },
      ])
    ).toEqual({ a: [1, 4] });
  });
});

describe("the open log", () => {
  it("records opens and reads them back", () => {
    const storage = memoryStorage();
    recordFolderOpen("a", ["a"], 10, storage);
    recordFolderOpen("a", ["a"], 20, storage);
    expect(readFolderOpens(storage)).toEqual({ a: [10, 20] });
  });

  it("keeps only the newest opens per folder", () => {
    const storage = memoryStorage();
    for (let i = 0; i < MAX_OPENS_PER_FOLDER + 5; i++) recordFolderOpen("a", ["a"], i, storage);
    const opens = readFolderOpens(storage).a;
    expect(opens).toHaveLength(MAX_OPENS_PER_FOLDER);
    expect(opens[0]).toBe(5);
  });

  it("drops folders that are no longer in the list", () => {
    const storage = memoryStorage(JSON.stringify({ gone: [1], kept: [2] }));
    recordFolderOpen("a", ["a", "kept"], 3, storage);
    expect(readFolderOpens(storage)).toEqual({ kept: [2], a: [3] });
  });

  it("prunes nothing when the folder list has not loaded yet", () => {
    const storage = memoryStorage(JSON.stringify({ kept: [2] }));
    recordFolderOpen("a", [], 3, storage);
    expect(readFolderOpens(storage)).toEqual({ kept: [2], a: [3] });
  });

  it("treats a garbled or missing record as empty", () => {
    expect(readFolderOpens(memoryStorage("{not json"))).toEqual({});
    expect(readFolderOpens(memoryStorage("[1,2]"))).toEqual({});
    expect(readFolderOpens(null)).toEqual({});
  });

  it("survives storage that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(readFolderOpens(broken)).toEqual({});
    expect(() => recordFolderOpen("a", ["a"], 1, broken)).not.toThrow();
  });
});

describe("the org open log", () => {
  const orgStorage = (initial?: Record<string, number[]>) =>
    memoryStorage(initial && JSON.stringify(initial), "parley:org-folder-opens");

  it("keeps each org's opens apart, read back by plain folder id", () => {
    const storage = orgStorage();
    recordOrgFolderOpen("o1", "f", ["f"], 10, storage);
    recordOrgFolderOpen("o2", "f", ["f"], 20, storage);
    expect(readOrgFolderOpens("o1", storage)).toEqual({ f: [10] });
    expect(readOrgFolderOpens("o2", storage)).toEqual({ f: [20] });
  });

  it("does not touch the personal log", () => {
    const storage = orgStorage();
    recordOrgFolderOpen("o1", "f", ["f"], 10, storage);
    expect(readFolderOpens(storage)).toEqual({});
  });

  it("prunes only the org being opened in, against that org's folders", () => {
    const storage = orgStorage({ "o1:gone": [1], "o1:kept": [2], "o2:other": [3] });
    recordOrgFolderOpen("o1", "f", ["f", "kept"], 4, storage);
    expect(readOrgFolderOpens("o1", storage)).toEqual({ kept: [2], f: [4] });
    expect(readOrgFolderOpens("o2", storage)).toEqual({ other: [3] });
  });

  it("prunes nothing while that org's folders have not loaded", () => {
    const storage = orgStorage({ "o1:old": [1] });
    recordOrgFolderOpen("o1", "f", [], 2, storage);
    expect(readOrgFolderOpens("o1", storage)).toEqual({ old: [1], f: [2] });
  });

  it("keeps only the newest opens per org folder", () => {
    const storage = orgStorage();
    for (let i = 0; i < MAX_OPENS_PER_FOLDER + 3; i++) {
      recordOrgFolderOpen("o1", "f", ["f"], i, storage);
    }
    expect(readOrgFolderOpens("o1", storage).f).toHaveLength(MAX_OPENS_PER_FOLDER);
  });

  it("ranks an org's folders by opens alone", () => {
    const storage = orgStorage();
    recordOrgFolderOpen("o1", "b", ["a", "b"], NOW, storage);
    const ranked = rankFolders([folder("a", 1), folder("b", 2)], {
      opens: readOrgFolderOpens("o1", storage),
      recordingTimes: {},
      now: NOW,
    });
    expect(ids(ranked)).toEqual(["b", "a"]);
  });
});
