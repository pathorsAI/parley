import { describe, expect, it } from "vitest";
import {
  buildOwnershipIndex,
  countByNode,
  inFolderNode,
  inNode,
  nodeKey,
  ownerNode,
  planFolderDedupe,
  recordingsOfFolder,
  type FiledRecording,
  type LibraryNode,
} from "./scope";

/**
 * The #195 invariant: the number next to a node and the recordings that node
 * opens are the SAME rule, and nothing can fall out of the tree entirely.
 */

const folders = [{ id: "f-acme" }, { id: "f-globex" }];
const idx = buildOwnershipIndex(folders);

const ACME: LibraryNode = { kind: "folder", folderId: "f-acme" };
const GLOBEX: LibraryNode = { kind: "folder", folderId: "f-globex" };
const NONE: LibraryNode = { kind: "unassigned" };
const ALL: LibraryNode = { kind: "all" };

const entries: FiledRecording[] = [
  { folderId: "f-acme" },
  { folderId: "f-acme" },
  { folderId: "f-globex" },
  { folderId: null }, // never filed
  {}, // predates the field
  { folderId: "deleted-folder" }, // folder since deleted
];

describe("ownerNode", () => {
  it("puts a filed recording in its folder", () => {
    expect(ownerNode({ folderId: "f-acme" }, idx)).toEqual(ACME);
  });

  it("sends everything else to unassigned rather than nowhere", () => {
    expect(ownerNode({}, idx)).toEqual(NONE);
    expect(ownerNode({ folderId: null }, idx)).toEqual(NONE);
    expect(ownerNode({ folderId: "deleted-folder" }, idx)).toEqual(NONE);
    // An ORG recording's folderId isn't a personal folder → never joins one.
    expect(ownerNode({ folderId: "org-folder" }, idx)).toEqual(NONE);
  });
});

describe("countByNode", () => {
  const counts = countByNode(entries, idx);

  it("counts exactly what each node will show", () => {
    for (const node of [ACME, GLOBEX, NONE]) {
      const shown = entries.filter((e) => inNode(e, node, idx));
      expect(counts.get(nodeKey(node)) ?? 0).toBe(shown.length);
    }
  });

  it("accounts for every recording exactly once across the tree", () => {
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    expect(total).toBe(entries.length);
  });

  it("sweeps orphans into unassigned", () => {
    // null + {} + deleted folder.
    expect(counts.get(nodeKey(NONE))).toBe(3);
  });
});

describe("the all node (#330)", () => {
  it("takes every recording, however it is filed", () => {
    for (const e of entries) expect(inNode(e, ALL, idx)).toBe(true);
  });

  it("is never where a recording LIVES — ownerNode can only answer folder or unassigned", () => {
    for (const e of entries) expect(ownerNode(e, idx).kind).not.toBe("all");
  });

  it("stays out of the owner counts so the tree total is not doubled", () => {
    const counts = countByNode(entries, idx);
    expect(counts.has(nodeKey(ALL))).toBe(false);
    expect([...counts.values()].reduce((sum, n) => sum + n, 0)).toBe(entries.length);
  });

  it("keeps its own identity apart from the other nodes", () => {
    expect(nodeKey(ALL)).not.toBe(nodeKey(NONE));
    expect(nodeKey(ALL)).not.toBe(nodeKey(ACME));
  });
});

describe("recordingsOfFolder", () => {
  it("gives the folder exactly what the tree node shows", () => {
    const shown = recordingsOfFolder(entries, "f-acme", idx);
    expect(shown).toHaveLength(countByNode(entries, idx).get(nodeKey(ACME)) ?? 0);
  });
});

describe("planFolderDedupe", () => {
  const f = (id: string, name: string, createdAt: number) => ({ id, name, createdAt });

  it("merges same-name twins into the oldest", () => {
    const merges = planFolderDedupe([f("b", "測試", 2), f("a", "測試", 1)]);
    expect(merges).toEqual([{ canonicalId: "a", twinIds: ["b"], name: "測試" }]);
  });

  it("leaves unique names and blank names alone", () => {
    expect(planFolderDedupe([f("a", "Ai3", 1), f("b", "東森", 2), f("c", " ", 3)])).toEqual([]);
  });

  it("handles a 3-way clone group", () => {
    const merges = planFolderDedupe([f("a", "Ai3", 3), f("b", "Ai3", 1), f("c", "Ai3", 2)]);
    expect(merges).toEqual([{ canonicalId: "b", twinIds: ["a", "c"], name: "Ai3" }]);
  });
});

describe("inFolderNode (org scope)", () => {
  const live = new Set(["o-a", "o-b"]);

  it("files by folder", () => {
    expect(inFolderNode({ folderId: "o-a" }, "o-a", live)).toBe(true);
    expect(inFolderNode({ folderId: "o-a" }, "o-b", live)).toBe(false);
  });

  it("catches missing and deleted folders at the org root", () => {
    expect(inFolderNode({}, null, live)).toBe(true);
    expect(inFolderNode({ folderId: "gone" }, null, live)).toBe(true);
    expect(inFolderNode({ folderId: "gone" }, "o-a", live)).toBe(false);
  });
});
