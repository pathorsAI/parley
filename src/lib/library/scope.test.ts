import { describe, expect, it } from "vitest";
import {
  buildOwnershipIndex,
  countByNode,
  inFolderNode,
  inNode,
  nodeKey,
  ownerBackfill,
  ownerNode,
  planFolderDedupe,
  recordingsOfCompany,
  type FiledRecording,
  type LibraryNode,
} from "./scope";

/**
 * Two invariants live here.
 *
 * #195: the number next to a node and the recordings that node opens are the
 * SAME rule, and nothing can fall out of the tree entirely.
 *
 * #211: the CUSTOMER decides the node. A recording linked to a company belongs
 * to that company no matter which folder it physically sits in — the bug this
 * replaced was a link that wrote companyId and left folderId behind, stranding
 * the recording in 未歸戶 while the company page happily listed it.
 */

const companies = [
  { id: "acme", folderId: "f-acme" },
  { id: "globex", folderId: "f-globex" },
  { id: "noFolder" }, // a company that never had anything filed under it
];
const folders = [
  { id: "f-acme" },
  { id: "f-globex" },
  { id: "f-loose" }, // a pre-#211 folder belonging to no company
];
const idx = buildOwnershipIndex(companies, folders);

const ACME: LibraryNode = { kind: "company", companyId: "acme" };
const GLOBEX: LibraryNode = { kind: "company", companyId: "globex" };
const LOOSE: LibraryNode = { kind: "folder", folderId: "f-loose" };
const NONE: LibraryNode = { kind: "unassigned" };

const entries: FiledRecording[] = [
  { companyId: "acme", folderId: "f-acme" }, // the normal case
  { companyId: "acme", folderId: null }, // linked after the fact, not yet refiled
  { companyId: "acme", folderId: "f-loose" }, // saved elsewhere on purpose
  { companyId: null, folderId: "f-globex" }, // legacy: filed, never linked
  { companyId: null, folderId: "f-loose" }, // legacy loose folder
  { companyId: null, folderId: null }, // never filed
  {}, // predates both fields
  { companyId: "deleted-co", folderId: null }, // company since deleted
  { folderId: "deleted-folder" }, // folder since deleted
];

describe("ownerNode", () => {
  it("puts a linked recording under its customer, folder or no folder", () => {
    expect(ownerNode({ companyId: "acme", folderId: "f-acme" }, idx)).toEqual(ACME);
    // THE regression: linking without refiling must not strand the recording.
    expect(ownerNode({ companyId: "acme", folderId: null }, idx)).toEqual(ACME);
    // A deliberate "save somewhere else" doesn't change whose call it was.
    expect(ownerNode({ companyId: "acme", folderId: "f-loose" }, idx)).toEqual(ACME);
  });

  it("falls back to the company's folder for recordings saved before the link existed", () => {
    expect(ownerNode({ folderId: "f-globex" }, idx)).toEqual(GLOBEX);
  });

  it("keeps a company-less folder as its own node", () => {
    expect(ownerNode({ folderId: "f-loose" }, idx)).toEqual(LOOSE);
  });

  it("sends everything else to unassigned rather than nowhere", () => {
    expect(ownerNode({}, idx)).toEqual(NONE);
    expect(ownerNode({ companyId: null, folderId: null }, idx)).toEqual(NONE);
    // A link to a company that no longer exists, and a folder that's gone.
    expect(ownerNode({ companyId: "deleted-co" }, idx)).toEqual(NONE);
    expect(ownerNode({ folderId: "deleted-folder" }, idx)).toEqual(NONE);
    // An ORG recording's folderId isn't a personal folder → never joins one.
    expect(ownerNode({ folderId: "org-folder" }, idx)).toEqual(NONE);
  });

  it("gives a company with no folder a node anyway", () => {
    expect(ownerNode({ companyId: "noFolder" }, idx)).toEqual({
      kind: "company",
      companyId: "noFolder",
    });
  });
});

describe("countByNode", () => {
  const counts = countByNode(entries, idx);

  it("counts exactly what each node will show", () => {
    for (const node of [ACME, GLOBEX, LOOSE, NONE]) {
      const shown = entries.filter((e) => inNode(e, node, idx));
      expect(counts.get(nodeKey(node)) ?? 0).toBe(shown.length);
    }
  });

  it("accounts for every recording exactly once across the tree", () => {
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    expect(total).toBe(entries.length);
  });

  it("gathers a customer's recordings wherever they sit on disk", () => {
    expect(counts.get(nodeKey(ACME))).toBe(3);
  });

  it("sweeps orphans into unassigned", () => {
    // null/null + {} + deleted company + deleted folder.
    expect(counts.get(nodeKey(NONE))).toBe(4);
  });
});

describe("recordingsOfCompany", () => {
  it("gives the company page exactly what the tree node shows", () => {
    const shown = recordingsOfCompany(entries, "acme", idx);
    expect(shown).toHaveLength(countByNode(entries, idx).get(nodeKey(ACME)) ?? 0);
  });

  it("includes a recording only the folder fallback can place", () => {
    // The pre-#211 case: filed in the company's folder, never linked. The old
    // `m.companyId === id` filter dropped it from the company page while the
    // tree counted it.
    expect(recordingsOfCompany([{ folderId: "f-globex" }], "globex", idx)).toHaveLength(1);
  });
});

describe("ownerBackfill", () => {
  it("claims a recording sitting in a company's folder with no link", () => {
    expect(ownerBackfill({ folderId: "f-acme" }, idx)).toBe("acme");
    expect(ownerBackfill({ companyId: null, folderId: "f-globex" }, idx)).toBe("globex");
  });

  it("leaves an already-linked recording alone, wherever it sits", () => {
    expect(ownerBackfill({ companyId: "acme", folderId: "f-acme" }, idx)).toBeNull();
    // Deliberately saved elsewhere — the link is the truth, don't "correct" it.
    expect(ownerBackfill({ companyId: "acme", folderId: "f-loose" }, idx)).toBeNull();
  });

  it("claims nothing it can't justify", () => {
    expect(ownerBackfill({}, idx)).toBeNull();
    expect(ownerBackfill({ folderId: null }, idx)).toBeNull();
    expect(ownerBackfill({ folderId: "f-loose" }, idx)).toBeNull(); // no company owns it
    expect(ownerBackfill({ folderId: "deleted-folder" }, idx)).toBeNull();
    expect(ownerBackfill({ folderId: "org-folder" }, idx)).toBeNull();
  });

  it("is idempotent — a second pass finds nothing", () => {
    const once = entries.map((e) => {
      const owner = ownerBackfill(e, idx);
      return owner ? { ...e, companyId: owner } : e;
    });
    expect(once.every((e) => ownerBackfill(e, idx) === null)).toBe(true);
  });

  it("does not change where anything lands — only what is written down", () => {
    const before = entries.map((e) => nodeKey(ownerNode(e, idx)));
    const after = entries
      .map((e) => {
        const owner = ownerBackfill(e, idx);
        return owner ? { ...e, companyId: owner } : e;
      })
      .map((e) => nodeKey(ownerNode(e, idx)));
    expect(after).toEqual(before);
  });
});

describe("planFolderDedupe", () => {
  const f = (id: string, name: string, createdAt: number) => ({ id, name, createdAt });

  it("merges same-name twins into the company-paired folder", () => {
    const merges = planFolderDedupe(
      [f("old", "台數科", 1), f("paired", "台數科", 2)],
      [{ id: "co", folderId: "paired" }]
    );
    expect(merges).toEqual([{ canonicalId: "paired", twinIds: ["old"], name: "台數科" }]);
  });

  it("falls back to the oldest when no company claims the name", () => {
    const merges = planFolderDedupe([f("b", "測試", 2), f("a", "測試", 1)], []);
    expect(merges).toEqual([{ canonicalId: "a", twinIds: ["b"], name: "測試" }]);
  });

  it("skips a name claimed by more than one company", () => {
    // Two same-named companies: merging on the name would move recordings
    // between customers.
    const merges = planFolderDedupe(
      [f("x", "台哥大", 1), f("y", "台哥大", 2)],
      [
        { id: "co1", folderId: "x" },
        { id: "co2", folderId: "y" },
      ]
    );
    expect(merges).toEqual([]);
  });

  it("leaves unique names and blank names alone", () => {
    expect(planFolderDedupe([f("a", "Ai3", 1), f("b", "東森", 2), f("c", " ", 3)], [])).toEqual(
      []
    );
  });

  it("handles a 3-way clone group", () => {
    const merges = planFolderDedupe(
      [f("a", "Ai3", 3), f("b", "Ai3", 1), f("c", "Ai3", 2)],
      []
    );
    expect(merges).toEqual([{ canonicalId: "b", twinIds: ["a", "c"], name: "Ai3" }]);
  });
});

describe("inFolderNode (org scope)", () => {
  const live = new Set(["o-a", "o-b"]);

  it("files by folder, since an org has no companies", () => {
    expect(inFolderNode({ folderId: "o-a" }, "o-a", live)).toBe(true);
    expect(inFolderNode({ folderId: "o-a" }, "o-b", live)).toBe(false);
  });

  it("catches missing and deleted folders at the org root", () => {
    expect(inFolderNode({}, null, live)).toBe(true);
    expect(inFolderNode({ folderId: "gone" }, null, live)).toBe(true);
    expect(inFolderNode({ folderId: "gone" }, "o-a", live)).toBe(false);
  });

  it("ignores the customer link entirely", () => {
    expect(inFolderNode({ companyId: "acme", folderId: "o-a" }, "o-a", live)).toBe(true);
  });
});
