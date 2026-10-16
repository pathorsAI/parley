import { describe, it, expect, vi } from "vitest";
import {
  cardLocation,
  deleteDialogCopy,
  emptyStateCopy,
  listKey,
  moveTargetFolders,
  openFolderName,
  orgCard,
  routeFiling,
} from "./libraryView";
import type { HistoryCardItem } from "../cloud/sync";
import type { Folder } from "../history/folders";
import type { LibrarySelection } from "../store";

const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${JSON.stringify(vars)}` : key);
const folders: Folder[] = [
  { id: "f1", name: "Acme", createdAt: 1 },
  { id: "f2", name: "Old", createdAt: 2, archivedAt: 5 },
];
const personal = (node: LibrarySelection & { kind: "personal" }) => node;
const item = { id: "r1", folderId: "f1" } as HistoryCardItem;

describe("orgCard", () => {
  it("maps a cloud summary to a cloud card", () => {
    const card = orgCard({
      id: "c", title: "T", source: "live", createdAt: 1, durationMs: 2, speakerCount: 3, findingsCount: 4,
      actionItemsCount: 5, hasAudio: true, snippet: "s", updatedAt: 9,
    } as never);
    expect(card).toEqual({
      id: "c", title: "T", source: "live", createdAt: 1, durationMs: 2, speakerCount: 3, findingsCount: 4,
      actionItemsCount: 5, hasAudio: true, snippet: "s", folderId: null, sync: "cloud", cloudUpdatedAt: 9,
    });
  });
});

describe("openFolderName", () => {
  it("names the open personal or org folder, null at a root", () => {
    expect(openFolderName(personal({ kind: "personal", node: { kind: "folder", folderId: "f1" } }), folders)).toBe("Acme");
    expect(openFolderName({ kind: "org", id: "o", name: "O", folderId: "f2" }, folders)).toBe("Old");
    expect(openFolderName(personal({ kind: "personal", node: { kind: "all" } }), folders)).toBeNull();
    expect(openFolderName({ kind: "voice" }, folders)).toBeNull();
  });
});

describe("emptyStateCopy / deleteDialogCopy", () => {
  const scope = { searching: false, hasFolder: false, isOrg: false, isAll: false };
  it("picks the empty state by scope, search first", () => {
    expect(emptyStateCopy(t, { ...scope, searching: true, hasFolder: true }).title).toBe("history.searchEmpty");
    expect(emptyStateCopy(t, { ...scope, hasFolder: true, isOrg: true }).title).toBe("history.folder.empty");
    expect(emptyStateCopy(t, { ...scope, isOrg: true }).hint).toBe("history.org.emptyHint");
    expect(emptyStateCopy(t, { ...scope, isAll: true }).title).toBe("library.all.empty");
    expect(emptyStateCopy(t, scope)).toEqual({ title: "library.unassigned.empty", hint: "library.unassigned.emptyHint" });
  });
  it("an org scope removes, everywhere else deletes", () => {
    expect(deleteDialogCopy(t, true, "X")).toEqual({
      title: "history.org.remove",
      body: 'history.org.removeConfirm:{"title":"X"}',
      confirmLabel: "history.org.remove",
    });
    expect(deleteDialogCopy(t, false, "X").confirmLabel).toBe("common.delete");
  });
});

describe("moveTargetFolders", () => {
  it("drops archived personal folders except the open one; org folders pass through", () => {
    expect(moveTargetFolders(personal({ kind: "personal", node: { kind: "all" } }), folders)).toEqual([folders[0]]);
    expect(moveTargetFolders(personal({ kind: "personal", node: { kind: "folder", folderId: "f2" } }), folders)).toEqual(folders);
    expect(moveTargetFolders({ kind: "org", id: "o", name: "O", folderId: null }, folders)).toBe(folders);
  });
});

describe("routeFiling", () => {
  const actions = { moveInOrg: vi.fn(async () => {}), move: vi.fn(async () => {}), handOffToOrg: vi.fn(async () => {}) };
  it("routes a refile inside an org, a personal move, or a handoff (move by default)", async () => {
    await routeFiling(true, item, { scope: "org", orgId: "o", folderId: "x" }, null, actions);
    expect(actions.moveInOrg).toHaveBeenCalledWith(item, "x");
    await routeFiling(false, item, { scope: "personal", folderId: "f1" }, null, actions);
    expect(actions.move).toHaveBeenCalledWith(item, "f1");
    await routeFiling(false, item, { scope: "org", orgId: "o", folderId: null }, null, actions);
    expect(actions.handOffToOrg).toHaveBeenCalledWith(item, "o", null, "move");
    await routeFiling(false, item, { scope: "org", orgId: "o", folderId: null }, "copy", actions);
    expect(actions.handOffToOrg).toHaveBeenLastCalledWith(item, "o", null, "copy");
  });
});

describe("cardLocation / listKey", () => {
  it("places a card in the open org or in Personal", () => {
    expect(cardLocation({ kind: "org", id: "o", name: "O", folderId: null }, item)).toEqual({ scope: "org", orgId: "o", folderId: "f1" });
    expect(cardLocation({ kind: "voice" }, { id: "r" } as HistoryCardItem)).toEqual({ scope: "personal", folderId: null });
  });
  it("keys the list by scope, node and search", () => {
    expect(listKey({ kind: "org", id: "o", name: "O", folderId: null }, "q")).toBe("org:o:|q");
    expect(listKey(personal({ kind: "personal", node: { kind: "folder", folderId: "f1" } }), "")).toBe("personal:f:f1|");
    expect(listKey({ kind: "voice" }, "x")).toBe("|x");
  });
});
