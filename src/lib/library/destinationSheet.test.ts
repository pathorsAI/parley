import { describe, it, expect } from "vitest";
import { PERSONAL_ROOT, type LibraryDestination } from "./destination";
import { handoffMode, openingDestination, orgNameOf, workspaceFolders, PERSONAL_WORKSPACE } from "./destinationPicker";
import type { Folder } from "../history/folders";

const live: Folder = { id: "p1", name: "Clients", createdAt: 1 };
const archived: Folder = { id: "p2", name: "Old", createdAt: 2, archivedAt: 3 };
const sources = { personalFolders: [live, archived], orgFolders: { o1: [{ id: "of1", name: "Team" }] } };
const orgs = [{ id: "o1", name: "Pathors" }];

describe("workspaceFolders", () => {
  it("offers personal folders minus archived ones, keeping the current home", () => {
    expect(workspaceFolders(PERSONAL_WORKSPACE, sources, true, null)).toEqual([live]);
    expect(workspaceFolders(PERSONAL_WORKSPACE, sources, true, { scope: "personal", folderId: "p2" })).toEqual([live, archived]);
  });
  it("offers no personal folders when the caller hides them, and null for an org still loading", () => {
    expect(workspaceFolders(PERSONAL_WORKSPACE, sources, false, null)).toEqual([]);
    expect(workspaceFolders("o1", sources, true, null)).toEqual([{ id: "of1", name: "Team" }]);
    expect(workspaceFolders("o2", sources, true, null)).toBeNull();
  });
});

describe("openingDestination", () => {
  const foldersOf = (ws: string) => workspaceFolders(ws, sources, true, null);
  const base = { current: null, initial: null, lastUsed: null, orgs, lockWorkspace: undefined, foldersOf };
  it("opens on the recording's place, else the caller's pick, else the last used", () => {
    const here: LibraryDestination = { scope: "personal", folderId: "p1" };
    const team: LibraryDestination = { scope: "org", orgId: "o1", folderId: "of1" };
    expect(openingDestination({ ...base, current: here, initial: team })).toEqual(here);
    expect(openingDestination({ ...base, initial: team })).toEqual(team);
    expect(openingDestination({ ...base, lastUsed: team })).toEqual(team);
    expect(openingDestination(base)).toEqual(PERSONAL_ROOT);
  });
  it("falls back to the workspace root when a remembered folder is gone", () => {
    expect(openingDestination({ ...base, lastUsed: { scope: "org", orgId: "o1", folderId: "gone" } })).toEqual({
      scope: "org",
      orgId: "o1",
      folderId: null,
    });
  });
  it("a locked workspace opens on its root when nothing is known", () => {
    expect(openingDestination({ ...base, lockWorkspace: "o1" })).toEqual({ scope: "org", orgId: "o1", folderId: null });
  });
});

describe("handoffMode / orgNameOf", () => {
  const into: LibraryDestination = { scope: "org", orgId: "o1", folderId: null };
  it("Personal → org is a copy when the original is kept, else a move; nothing else is a handoff", () => {
    expect(handoffMode(into, PERSONAL_ROOT, true)).toBe("copy");
    expect(handoffMode(into, null, false)).toBe("move");
    expect(handoffMode(into, { scope: "org", orgId: "o2", folderId: null }, true)).toBeNull();
    expect(handoffMode(PERSONAL_ROOT, PERSONAL_ROOT, true)).toBeNull();
  });
  it("names the org a destination files into", () => {
    expect(orgNameOf(orgs, into)).toBe("Pathors");
    expect(orgNameOf(orgs, PERSONAL_ROOT)).toBe("");
    expect(orgNameOf(null, into)).toBe("");
  });
});
