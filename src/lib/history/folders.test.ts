import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));
// Outside Tauri the registry never touches disk or the event bus, so the
// in-memory cache IS the registry — exactly what these rules are about.
vi.mock("../tauriEvents", () => ({ isTauri: () => false }));

import {
  createLocalFolder,
  deleteLocalFolder,
  filingChoices,
  folderGeneration,
  isArchived,
  listLocalFolders,
  mirrorCloudFolders,
  renameLocalFolder,
  setLocalFolderArchived,
  writeLocalFolders,
  type Folder,
} from "./folders";

const byName = (name: string): Folder => {
  const f = listLocalFolders().find((x) => x.name === name);
  if (!f) throw new Error(`no folder named ${name}`);
  return f;
};

beforeEach(() => {
  writeLocalFolders([]);
});

describe("archiving a folder puts it away without moving anything", () => {
  it("keeps the folder in the registry so its recordings still have a home", () => {
    const f = createLocalFolder("和運租車");
    setLocalFolderArchived(f.id, true);

    const stored = listLocalFolders();
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(f.id);
    expect(isArchived(stored[0])).toBe(true);
  });

  it("restores cleanly — an unarchived folder carries no leftover flag", () => {
    const f = createLocalFolder("台數科");
    setLocalFolderArchived(f.id, true);
    setLocalFolderArchived(f.id, false);

    expect(isArchived(byName("台數科"))).toBe(false);
    expect(byName("台數科").archivedAt).toBeUndefined();
  });

  it("survives a rename", () => {
    const f = createLocalFolder("old");
    setLocalFolderArchived(f.id, true);
    renameLocalFolder(f.id, "new");

    expect(isArchived(byName("new"))).toBe(true);
  });

  it("ignores an id nothing answers to", () => {
    createLocalFolder("kept");
    setLocalFolderArchived("no-such-folder", true);

    expect(listLocalFolders().map((f) => f.name)).toEqual(["kept"]);
  });
});

describe("the cloud mirror-down cannot un-archive", () => {
  // Regression: the cloud `folder` table has no archived column, so a cloud
  // reload hands back folders with the flag missing. Taking that at face value
  // would empty the archive shelf on every sync.
  it("carries the local flag across a cloud list that does not know about it", () => {
    const f = createLocalFolder("和運租車");
    setLocalFolderArchived(f.id, true);

    writeLocalFolders([{ id: f.id, name: "和運租車", createdAt: f.createdAt }]);

    expect(isArchived(byName("和運租車"))).toBe(true);
  });

  it("still drops a folder the cloud no longer has", () => {
    const gone = createLocalFolder("gone");
    setLocalFolderArchived(gone.id, true);

    writeLocalFolders([]);

    expect(listLocalFolders()).toEqual([]);
  });
});

describe("a local edit outranks a cloud snapshot taken before it", () => {
  // Regression: deleting a folder appeared to do nothing. A reload fires on
  // window focus, so its cloud read was already in flight when the delete
  // landed — and the reply, taken before the DELETE, still listed the folder.
  // Mirroring that down resurrected it, on disk and on screen.
  it("drops a snapshot older than a local delete, and the folder stays gone", () => {
    const doomed = createLocalFolder("和運租車");
    const kept = createLocalFolder("台數科");
    // What reloadFolders does: read the generation, then go to the network.
    const since = folderGeneration();
    const inFlight = listLocalFolders();
    // The user answers the confirmation while that read is still outstanding.
    deleteLocalFolder(doomed.id);

    const rendered = mirrorCloudFolders(inFlight, since);

    expect(rendered.map((f) => f.id)).toEqual([kept.id]);
    expect(listLocalFolders().map((f) => f.id)).toEqual([kept.id]);
  });

  it("writes an uncontested snapshot down, additions and removals alike", () => {
    const shared = createLocalFolder("shared");
    const localOnly = createLocalFolder("dropped by the cloud");
    const since = folderGeneration();

    const rendered = mirrorCloudFolders(
      [
        { id: shared.id, name: "shared", createdAt: shared.createdAt },
        { id: "other-device", name: "made elsewhere", createdAt: shared.createdAt + 1 },
      ],
      since
    );

    expect(rendered.map((f) => f.name)).toEqual(["shared", "made elsewhere"]);
    expect(listLocalFolders().some((f) => f.id === localOnly.id)).toBe(false);
  });

  it("drops a snapshot older than a local rename, so the new name survives", () => {
    const f = createLocalFolder("old name");
    const since = folderGeneration();
    const inFlight = [{ id: f.id, name: "old name", createdAt: f.createdAt }];
    renameLocalFolder(f.id, "new name");

    expect(mirrorCloudFolders(inFlight, since).map((x) => x.name)).toEqual(["new name"]);
    expect(listLocalFolders().map((x) => x.name)).toEqual(["new name"]);
  });
});

describe("filingChoices — where a recording can be filed", () => {
  const live: Folder = { id: "a", name: "live", createdAt: 1 };
  const put: Folder = { id: "b", name: "put away", createdAt: 2, archivedAt: 3 };

  it("hides archived folders", () => {
    expect(filingChoices([live, put])).toEqual([live]);
  });

  it("keeps the archived folder the recording is already in", () => {
    expect(filingChoices([live, put], "b")).toEqual([live, put]);
  });
});

describe("createLocalFolder revives rather than duplicates", () => {
  it("brings back the archived folder that already wears the name", () => {
    const first = createLocalFolder("和運租車");
    setLocalFolderArchived(first.id, true);

    const again = createLocalFolder("和運租車");

    expect(again.id).toBe(first.id);
    expect(listLocalFolders()).toHaveLength(1);
    expect(isArchived(byName("和運租車"))).toBe(false);
  });

  it("leaves live folders alone — duplicate names among them are allowed", () => {
    const first = createLocalFolder("dup");
    const second = createLocalFolder("dup");

    expect(second.id).not.toBe(first.id);
    expect(listLocalFolders()).toHaveLength(2);
  });
});
