import { describe, expect, it } from "vitest";
import { countInFolderNode, inFolderNode, type FiledRecording } from "./scope";

/**
 * The point of these tests is the invariant issue #195 asks for: the number
 * next to a node and the recordings that node opens are the SAME rule, and
 * nothing can fall out of the tree entirely.
 */

const live = new Set(["co-a", "co-b"]);

const entries: FiledRecording[] = [
  { folderId: "co-a" },
  { folderId: "co-a" },
  { folderId: "co-b" },
  { folderId: null }, // never filed
  {}, // predates folders entirely
  { folderId: "deleted-folder" }, // folder is gone
];

describe("inFolderNode", () => {
  it("puts a recording under the company folder it was saved into", () => {
    expect(inFolderNode({ folderId: "co-a" }, "co-a", live)).toBe(true);
    expect(inFolderNode({ folderId: "co-a" }, "co-b", live)).toBe(false);
  });

  it("treats a missing folderId the same as an explicit null", () => {
    expect(inFolderNode({}, null, live)).toBe(true);
    expect(inFolderNode({ folderId: null }, null, live)).toBe(true);
  });

  it("catches recordings whose folder was deleted, so none can disappear", () => {
    expect(inFolderNode({ folderId: "deleted-folder" }, null, live)).toBe(true);
    expect(inFolderNode({ folderId: "deleted-folder" }, "co-a", live)).toBe(false);
  });

  it("keeps another scope's recordings out of a named folder", () => {
    // An org recording carries an ORG folderId; in the personal scope that id
    // isn't live, so it must not silently join a personal folder.
    expect(inFolderNode({ folderId: "org-folder" }, "co-a", live)).toBe(false);
  });
});

describe("countInFolderNode", () => {
  it("counts exactly what the node will show", () => {
    for (const node of ["co-a", "co-b", null] as const) {
      const shown = entries.filter((e) => inFolderNode(e, node, live));
      expect(countInFolderNode(entries, node, live)).toBe(shown.length);
    }
  });

  it("accounts for every recording exactly once across the tree", () => {
    const nodes: (string | null)[] = ["co-a", "co-b", null];
    const total = nodes.reduce((sum, n) => sum + countInFolderNode(entries, n, live), 0);
    expect(total).toBe(entries.length);
  });

  it("reports the unfiled bucket, including orphans", () => {
    // null + {} + the entry pointing at a deleted folder.
    expect(countInFolderNode(entries, null, live)).toBe(3);
  });
});
