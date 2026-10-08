import { describe, it, expect } from "vitest";
import { PERSONAL_ROOT, type LibraryDestination } from "./destination";
import {
  PERSONAL_WORKSPACE,
  breadcrumb,
  canCreateFolder,
  filterFolders,
  formatBreadcrumb,
  initialDestination,
  loadLastDestination,
  needsFolderSearch,
  offersKeepCopy,
  primaryAction,
  revealsToOrg,
  saveLastDestination,
  workspaceControl,
  workspaceOf,
  workspaceRoot,
} from "./destinationPicker";

const ORGS = [
  { id: "org-1", name: "Pathors" },
  { id: "org-2", name: "Cerana" },
];
const personalIn = (folderId: string | null): LibraryDestination => ({ scope: "personal", folderId });
const orgIn = (orgId: string, folderId: string | null): LibraryDestination => ({
  scope: "org",
  orgId,
  folderId,
});

describe("workspace control", () => {
  it("is a segmented control up to three workspaces, a combobox past that", () => {
    expect(workspaceControl(1)).toBe("segmented");
    expect(workspaceControl(3)).toBe("segmented");
    expect(workspaceControl(4)).toBe("combobox");
  });

  it("maps destinations to workspaces and back to their roots", () => {
    expect(workspaceOf(personalIn("f"))).toBe(PERSONAL_WORKSPACE);
    expect(workspaceOf(orgIn("org-1", "f"))).toBe("org-1");
    expect(workspaceRoot(PERSONAL_WORKSPACE)).toEqual(PERSONAL_ROOT);
    expect(workspaceRoot("org-1")).toEqual(orgIn("org-1", null));
  });
});

describe("default selection", () => {
  it("opens on where the recording is now", () => {
    const current = orgIn("org-1", "of-1");
    expect(initialDestination(current, personalIn("f-9"), ORGS)).toEqual(current);
  });

  it("opens a new recording on the last-used destination", () => {
    expect(initialDestination(null, orgIn("org-2", "of-2"), ORGS)).toEqual(orgIn("org-2", "of-2"));
  });

  it("falls back to Personal when the remembered org is no longer reachable", () => {
    expect(initialDestination(null, orgIn("gone", null), ORGS)).toEqual(PERSONAL_ROOT);
    expect(initialDestination(null, orgIn("org-1", null), [])).toEqual(PERSONAL_ROOT);
  });

  it("keeps an org pick while the org list is still loading", () => {
    expect(initialDestination(orgIn("org-1", "of-1"), null, null)).toEqual(orgIn("org-1", "of-1"));
  });

  it("starts at the personal root with nothing to go on", () => {
    expect(initialDestination(null, null, ORGS)).toEqual(PERSONAL_ROOT);
  });

  it("round-trips the last-used destination through storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(loadLastDestination(storage)).toBeNull();
    saveLastDestination(orgIn("org-1", "of-1"), storage);
    expect(loadLastDestination(storage)).toEqual(orgIn("org-1", "of-1"));
  });
});

describe("breadcrumb", () => {
  const names = (folders: { id: string; name: string }[]) => ({ personal: "個人", orgs: ORGS, folders });

  it("names Personal and its folder", () => {
    expect(formatBreadcrumb(breadcrumb(personalIn("f-1"), names([{ id: "f-1", name: "客戶會議" }])))).toBe(
      "個人 › 客戶會議"
    );
  });

  it("names the org and its folder", () => {
    expect(
      formatBreadcrumb(breadcrumb(orgIn("org-1", "of-1"), names([{ id: "of-1", name: "客戶會議" }])))
    ).toBe("Pathors › 客戶會議");
  });

  it("is the workspace alone at a root, and never shows a raw id", () => {
    expect(breadcrumb(PERSONAL_ROOT, names([]))).toEqual(["個人"]);
    expect(breadcrumb(orgIn("org-1", null), names([]))).toEqual(["Pathors"]);
    expect(breadcrumb(personalIn("unknown"), names([]))).toEqual(["個人"]);
  });
});

describe("primary button", () => {
  it("states the action and the target", () => {
    expect(primaryAction("move", personalIn(null), orgIn("org-1", "of-1"), "Pathors › 客戶會議")).toEqual({
      kind: "move",
      target: "Pathors › 客戶會議",
    });
    expect(primaryAction("save", null, personalIn("f-1"), "個人 › 客戶會議")).toEqual({
      kind: "save",
      target: "個人 › 客戶會議",
    });
  });

  it("offers no move to where the recording already is", () => {
    expect(primaryAction("move", personalIn("f-1"), personalIn("f-1"), "個人 › A").kind).toBe("stay");
  });

  it("treats Personal as switching the auto-share default off", () => {
    expect(primaryAction("share", null, PERSONAL_ROOT, "個人")).toEqual({ kind: "shareOff" });
    expect(primaryAction("share", null, orgIn("org-1", null), "Pathors").kind).toBe("share");
  });
});

describe("org visibility note", () => {
  it("shows when a recording lands in an org it was not in", () => {
    expect(revealsToOrg(personalIn("f-1"), orgIn("org-1", null))).toBe(true);
    expect(revealsToOrg(null, orgIn("org-1", "of-1"))).toBe(true);
    expect(revealsToOrg(orgIn("org-1", null), orgIn("org-2", null))).toBe(true);
  });

  it("stays quiet within the same org and for Personal", () => {
    expect(revealsToOrg(orgIn("org-1", null), orgIn("org-1", "of-1"))).toBe(false);
    expect(revealsToOrg(orgIn("org-1", null), PERSONAL_ROOT)).toBe(false);
    expect(revealsToOrg(personalIn(null), personalIn("f-1"))).toBe(false);
  });

  it("offers keeping a personal copy only on the way into an org", () => {
    expect(offersKeepCopy(personalIn(null), orgIn("org-1", null))).toBe(true);
    expect(offersKeepCopy(null, orgIn("org-1", null))).toBe(true);
    expect(offersKeepCopy(orgIn("org-1", null), orgIn("org-1", "of-1"))).toBe(false);
    expect(offersKeepCopy(personalIn(null), personalIn("f-1"))).toBe(false);
  });
});

describe("folder search", () => {
  const folders = [
    { id: "1", name: "和運租車" },
    { id: "2", name: "Café Pathors" },
    { id: "3", name: "ＡＢＣ Motors" },
  ];

  it("matches substrings regardless of case, width and accents", () => {
    expect(filterFolders(folders, "租車").map((f) => f.id)).toEqual(["1"]);
    expect(filterFolders(folders, "cafe").map((f) => f.id)).toEqual(["2"]);
    expect(filterFolders(folders, "abc").map((f) => f.id)).toEqual(["3"]);
    expect(filterFolders(folders, "  ")).toHaveLength(3);
  });

  it("offers to create only a name that does not exist yet", () => {
    expect(canCreateFolder(folders, "和運租車")).toBe(false);
    expect(canCreateFolder(folders, "裕隆汽車")).toBe(true);
    expect(canCreateFolder(folders, "")).toBe(false);
  });

  it("shows a search field once the list is long", () => {
    expect(needsFolderSearch(7)).toBe(false);
    expect(needsFolderSearch(8)).toBe(true);
  });
});
