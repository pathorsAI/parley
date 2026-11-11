import { useEffect, useRef } from "react";
import { useStore, type LibrarySelection } from "../../lib/store";
import { recordFolderOpen, recordOrgFolderOpen } from "../../lib/library/folderRank";
import type { Folder } from "../../lib/history/folders";

/**
 * Log every time a personal folder is opened in the library, for the sidebar's
 * most-used ordering (lib/library/folderRank).
 *
 * A store subscriber rather than a call at each door: the sidebar row, ⌘K, the
 * breadcrumb, back/forward and a freshly created folder all land on
 * `openLibrary`, and listening to the selection itself means a door added
 * later counts without anyone remembering to wire it. Mounted in AppShell, not
 * the sidebar, because the sidebar unmounts when it is collapsed and ⌘K opens
 * folders all the same.
 *
 * Org-shared folders are logged too, in their own log (see recordOrgFolderOpen).
 *
 * Opening the folder that is already open is not a second use — the same
 * click on the same row would otherwise count as many times as it is made.
 */
export function useFolderOpenTracking(
  personalFolders: readonly Folder[],
  orgFolders: Readonly<Record<string, readonly Folder[]>>
): void {
  // The subscriber is registered once; the folder lists it prunes against are
  // read through a ref so they are never stale.
  const foldersRef = useRef({ personalFolders, orgFolders });
  useEffect(() => {
    foldersRef.current = { personalFolders, orgFolders };
  }, [personalFolders, orgFolders]);

  useEffect(
    () =>
      useStore.subscribe((next, prev) => {
        if (next.librarySelection === prev.librarySelection && next.appMode === prev.appMode) {
          return;
        }
        if (next.appMode !== "library") return;
        const opened = openedFolder(next.librarySelection);
        if (!opened) return;
        const before = prev.appMode === "library" ? openedFolder(prev.librarySelection) : null;
        if (before?.orgId === opened.orgId && before.folderId === opened.folderId) return;
        const { personalFolders: personal, orgFolders: orgs } = foldersRef.current;
        if (opened.orgId === null) {
          recordFolderOpen(
            opened.folderId,
            personal.map((f) => f.id)
          );
        } else {
          // An org whose folders have not loaded yet passes [], which prunes nothing.
          recordOrgFolderOpen(
            opened.orgId,
            opened.folderId,
            (orgs[opened.orgId] ?? []).map((f) => f.id)
          );
        }
      }),
    []
  );
}

/** The folder a selection opens: a personal one (orgId null) or an org's. */
function openedFolder(sel: LibrarySelection): { orgId: string | null; folderId: string } | null {
  if (sel.kind === "personal" && sel.node.kind === "folder") {
    return { orgId: null, folderId: sel.node.folderId };
  }
  if (sel.kind === "org" && sel.folderId) return { orgId: sel.id, folderId: sel.folderId };
  return null;
}
