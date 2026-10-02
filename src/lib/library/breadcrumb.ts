import type { LibrarySelection } from "../store";
import { buildOwnershipIndex, ownerNode } from "./scope";

/**
 * Where an open recording lives, as the crumbs IN FRONT of its name in the
 * titlebar breadcrumb (`和運租車 › 第二次報價`). Clicking a crumb is how you leave
 * the recording: it goes to that node of the tree.
 *
 * Pure on purpose — the titlebar owns the folder registry subscription and the
 * org folder fetch; this only decides what the answer is, so every case can be
 * pinned down in a test.
 */

/** Which sidebar icon a crumb borrows, so the crumb and the row it lands on
 *  look like the same place. */
export type CrumbIcon = "folder" | "unassigned" | "all" | "org";

export interface ParentCrumb {
  icon: CrumbIcon;
  /** A folder's or org's own name; null for the fixed nodes (所有錄音 / 還沒歸檔),
   *  whose label is their i18n key. */
  name: string | null;
  /** Where clicking the crumb goes. */
  selection: LibrarySelection;
}

export interface BreadcrumbFacts {
  loadedHistoryId: string | null;
  replayReadOnly: boolean;
  replayFolderId: string | null;
  librarySelection: LibrarySelection;
  /** The personal folder registry, archived folders INCLUDED — an archived
   *  folder is still the recording's home and still has a name. */
  personalFolders: readonly { id: string; name: string }[];
  /** The folders of the org in `librarySelection`, once known. */
  orgFolders?: readonly { id: string; name: string }[] | null;
}

const ALL: ParentCrumb = {
  icon: "all",
  name: null,
  selection: { kind: "personal", node: { kind: "all" } },
};

export function breadcrumbParents(facts: BreadcrumbFacts): ParentCrumb[] {
  if (facts.replayReadOnly) {
    // A shared org recording is opened from that org's grid, so the selection
    // still names the org (and folder) it was opened from. Anywhere else, the
    // only honest parent is the whole library.
    const sel = facts.librarySelection;
    if (sel.kind !== "org") return [ALL];
    const org: ParentCrumb = { icon: "org", name: sel.name, selection: { ...sel, folderId: null } };
    if (!sel.folderId) return [org];
    const folder = facts.orgFolders?.find((f) => f.id === sel.folderId);
    // Until the org's folder list arrives (or if the folder is gone), the org
    // alone is still a true parent; a crumb with no name would not be.
    return folder ? [org, { icon: "folder", name: folder.name, selection: sel }] : [org];
  }

  // An upload that hasn't been saved lives nowhere yet.
  if (!facts.loadedHistoryId) return [ALL];

  // The same rule the sidebar counts with: a folder id nothing answers to (the
  // folder was deleted) lands on 還沒歸檔, exactly where the tree shows it.
  const node = ownerNode(
    { folderId: facts.replayFolderId },
    buildOwnershipIndex(facts.personalFolders)
  );
  if (node.kind === "unassigned") {
    return [{ icon: "unassigned", name: null, selection: { kind: "personal", node } }];
  }
  const folder = facts.personalFolders.find((f) => f.id === node.folderId);
  return [{ icon: "folder", name: folder?.name ?? "", selection: { kind: "personal", node } }];
}
