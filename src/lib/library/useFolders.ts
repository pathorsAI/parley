// Folder names for the titlebar breadcrumb: the personal registry (kept live)
// and one org's folders (fetched on demand).

import { useEffect, useState } from "react";
import { listLocalFolders, listenForFoldersUpdated, type Folder } from "../history/folders";
import { CLOUD_ENABLED } from "../flags";
import { log } from "../log";

/**
 * The personal folder registry, kept live while the breadcrumb is on screen: a
 * rename in the sidebar (this window) or in another window broadcasts the
 * folders-updated event, and a cloud mirror-down lands on window focus.
 */
export function usePersonalFolders(): Folder[] {
  const [folders, setFolders] = useState<Folder[]>(() => listLocalFolders());
  useEffect(() => {
    const refresh = () => setFolders(listLocalFolders());
    const un = listenForFoldersUpdated(refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      un.then((fn) => fn()).catch(() => {});
    };
  }, []);
  return folders;
}

/** One org's folders, fetched only when a crumb needs one of their names. The
 *  cloud module is imported dynamically so the OSS bundle never reaches it. */
export function useOrgFolders(orgId: string | null): { id: string; name: string }[] | null {
  const [state, setState] = useState<{ orgId: string; folders: { id: string; name: string }[] } | null>(
    null
  );
  useEffect(() => {
    if (!orgId || !CLOUD_ENABLED) return;
    let active = true;
    import("../cloud/folders")
      .then((m) => m.listOrgFolders(orgId))
      .then((folders) => {
        if (active) setState({ orgId, folders });
      })
      .catch((e) => log.warn("titlebar: org folders failed", { orgId, error: String(e) }));
    return () => {
      active = false;
    };
  }, [orgId]);
  return state?.orgId === orgId ? state.folders : null;
}
