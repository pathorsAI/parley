import { describe, expect, it } from "vitest";
import { breadcrumbParents, type BreadcrumbFacts } from "./breadcrumb";

const folders = [
  { id: "f-acme", name: "Acme", createdAt: 1 },
  { id: "f-old", name: "Old client", createdAt: 2, archivedAt: 9 },
];

function facts(over: Partial<BreadcrumbFacts>): BreadcrumbFacts {
  return {
    loadedHistoryId: "rec-1",
    replayReadOnly: false,
    replayFolderId: null,
    librarySelection: { kind: "personal", node: { kind: "all" } },
    personalFolders: folders,
    ...over,
  };
}

describe("breadcrumbParents", () => {
  it("a filed recording's parent is its folder", () => {
    expect(breadcrumbParents(facts({ replayFolderId: "f-acme" }))).toEqual([
      {
        icon: "folder",
        name: "Acme",
        selection: { kind: "personal", node: { kind: "folder", folderId: "f-acme" } },
      },
    ]);
  });

  it("an archived folder is still the home, under its own name", () => {
    expect(breadcrumbParents(facts({ replayFolderId: "f-old" }))[0]).toMatchObject({
      name: "Old client",
      selection: { kind: "personal", node: { kind: "folder", folderId: "f-old" } },
    });
  });

  it("an unfiled recording's parent is 還沒歸檔", () => {
    expect(breadcrumbParents(facts({ replayFolderId: null }))).toEqual([
      { icon: "unassigned", name: null, selection: { kind: "personal", node: { kind: "unassigned" } } },
    ]);
  });

  it("a folder that no longer exists falls to 還沒歸檔, as in the tree", () => {
    expect(breadcrumbParents(facts({ replayFolderId: "f-deleted" }))[0].icon).toBe("unassigned");
  });

  it("does not take the parent from wherever the library happened to be", () => {
    const parents = breadcrumbParents(
      facts({
        replayFolderId: "f-acme",
        librarySelection: { kind: "personal", node: { kind: "unassigned" } },
      })
    );
    expect(parents[0].name).toBe("Acme");
  });

  it("an unsaved upload's parent is the whole library", () => {
    expect(breadcrumbParents(facts({ loadedHistoryId: null }))).toEqual([
      { icon: "all", name: null, selection: { kind: "personal", node: { kind: "all" } } },
    ]);
  });

  describe("read-only org recording", () => {
    const org = { kind: "org" as const, id: "o-1", name: "Pathors", folderId: null };

    it("lives in the org it was opened from", () => {
      expect(
        breadcrumbParents(facts({ loadedHistoryId: null, replayReadOnly: true, librarySelection: org }))
      ).toEqual([{ icon: "org", name: "Pathors", selection: org }]);
    });

    it("shows the org folder once its name is known", () => {
      const sel = { ...org, folderId: "of-1" };
      const base = facts({ loadedHistoryId: null, replayReadOnly: true, librarySelection: sel });

      // Folder list not loaded yet: the org alone, pointing at the org root.
      expect(breadcrumbParents(base)).toEqual([{ icon: "org", name: "Pathors", selection: org }]);

      expect(breadcrumbParents({ ...base, orgFolders: [{ id: "of-1", name: "Deals" }] })).toEqual([
        { icon: "org", name: "Pathors", selection: org },
        { icon: "folder", name: "Deals", selection: sel },
      ]);
    });

    it("falls back to the whole library when no org is selected", () => {
      const parents = breadcrumbParents(
        facts({ loadedHistoryId: null, replayReadOnly: true, replayFolderId: "f-acme" })
      );
      expect(parents.map((p) => p.icon)).toEqual(["all"]);
    });
  });
});
