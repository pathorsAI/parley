import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  createLocalFolder,
  deleteLocalFolder,
  emitFoldersUpdated,
  listLocalFolders,
  listenForFoldersUpdated,
  renameLocalFolder,
  writeLocalFolders,
  type Folder as LocalFolder,
} from "../../lib/history/folders";
import {
  createCloudFolder,
  createOrgFolder,
  deleteCloudFolder,
  deleteOrgFolder,
  listCloudFolders,
  listOrgFolders,
  pushUnsyncedFolders,
  renameCloudFolder,
  renameOrgFolder,
  type CloudFolder,
} from "../../lib/cloud/folders";
import { syncEnabled } from "../../lib/cloud/client";
import { listMyOrgs } from "../../lib/cloud/orgs";
import { listHistory, listenForHistoryUpdated } from "../../lib/history/history";
import { CLOUD_ENABLED } from "../../lib/flags";
import { useStore } from "../../lib/store";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import type { HistoryEntrySummary } from "../../lib/history/types";
import type { CloudOrg } from "../../lib/cloud/types";

/**
 * The data behind the one tree (issue #195): personal folders, the orgs and
 * their folders, and a lightweight list of the local recordings so each node
 * can show how many recordings are actually in it.
 *
 * Owned by the shell and handed to BOTH the sidebar and the library pane, so
 * the tree and the grid can never disagree about what exists — the old split
 * (company tree in the main window, folder tree in the History window) is
 * exactly what this refactor exists to end.
 */
export interface LibraryTree {
  personalFolders: LocalFolder[];
  orgs: CloudOrg[];
  orgFolders: Record<string, LocalFolder[]>;
  /** Local recording summaries, newest first — the source of every node count. */
  summaries: HistoryEntrySummary[];
  signedIn: boolean;
  ensureOrgFolders: (orgId: string, force?: boolean) => void;
  reloadFolders: () => Promise<void>;
  reloadSummaries: () => void;
  /** Create a personal folder and return its id (empty string on a blank name). */
  createPersonalFolder: (name: string) => string;
  renamePersonalFolder: (id: string, name: string) => void;
  deletePersonalFolder: (folder: LocalFolder) => void;
  createOrgFolder: (orgId: string, name: string) => Promise<void>;
  renameOrgFolder: (orgId: string, id: string, name: string) => Promise<void>;
  deleteOrgFolder: (orgId: string, folder: LocalFolder) => Promise<boolean>;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A cloud folder → the lightweight local folder shape the tree renders. */
function toLocalFolder(f: CloudFolder): LocalFolder {
  return { id: f.id, name: f.name, createdAt: f.createdAt };
}

const byCreatedAt = (a: LocalFolder, b: LocalFolder) => a.createdAt - b.createdAt;

export function useLibraryTree(): LibraryTree {
  const { t } = useI18n();
  // Hooks must run unconditionally; the flag just forces cloud UI off in OSS.
  const signedInRaw = useStore((s) => !!s.cloudAuth);
  const signedIn = CLOUD_ENABLED && signedInRaw;

  const [personalFolders, setPersonalFolders] = useState<LocalFolder[]>(() => listLocalFolders());
  const [orgs, setOrgs] = useState<CloudOrg[]>([]);
  const [orgFolders, setOrgFolders] = useState<Record<string, LocalFolder[]>>({});
  const [summaries, setSummaries] = useState<HistoryEntrySummary[]>([]);

  // ── Personal folders ────────────────────────────────────────────────────────
  // Sync on → the cloud is the source of truth (after the startup sweep uploads
  // any local-only folders), so a folder created on another device shows here.
  // Sync off / OSS → the local registry is the truth.
  const reloadFolders = useCallback(async () => {
    if (CLOUD_ENABLED && syncEnabled()) {
      try {
        // Push local-only folders FIRST, so mirroring the cloud list down can't
        // drop folders created while sync was off.
        await pushUnsyncedFolders();
        const cloud = (await listCloudFolders()).map(toLocalFolder).sort(byCreatedAt);
        writeLocalFolders(cloud);
        setPersonalFolders(cloud);
        return;
      } catch (e) {
        log.warn("library: cloud folders failed; using local", { error: String(e) });
      }
    }
    setPersonalFolders(listLocalFolders());
  }, []);

  const reloadSummaries = useCallback(() => {
    listHistory()
      .then(setSummaries)
      .catch((e) => log.warn("library: summary list failed", { error: String(e) }));
  }, []);

  useEffect(() => {
    reloadFolders().catch((e) => log.warn("library: folder load failed", { error: String(e) }));
    reloadSummaries();
  }, [reloadFolders, reloadSummaries, signedIn]);

  // The registry and the recordings can both change in another window (or from
  // a save that just landed) — re-read on the cross-window events and on focus.
  useEffect(() => {
    const unFolders = listenForFoldersUpdated(() => {
      reloadFolders().catch((e) =>
        log.warn("library: folder reload failed", { error: String(e) })
      );
    });
    const unHistory = listenForHistoryUpdated(() => reloadSummaries());
    const onFocus = () => {
      reloadFolders().catch(() => {});
      reloadSummaries();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      unFolders.then((fn) => fn()).catch(() => {});
      unHistory.then((fn) => fn()).catch(() => {});
    };
  }, [reloadFolders, reloadSummaries]);

  // ── Orgs ────────────────────────────────────────────────────────────────────
  const reloadOrgs = useCallback(() => {
    if (!signedIn) {
      setOrgs([]);
      return;
    }
    listMyOrgs()
      .then(setOrgs)
      .catch((e) => log.warn("library: list orgs failed", { error: String(e) }));
  }, [signedIn]);

  useEffect(() => {
    reloadOrgs();
    const onFocus = () => reloadOrgs();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reloadOrgs]);

  // Latest org-folder cache, reachable from the fetch guard without re-creating
  // the callback on every folder change (reading it inside a state updater would
  // make that updater impure).
  const orgFoldersRef = useRef(orgFolders);
  orgFoldersRef.current = orgFolders;
  const ensureOrgFolders = useCallback((orgId: string, force = false) => {
    if (!force && orgFoldersRef.current[orgId]) return;
    listOrgFolders(orgId)
      .then((fs) =>
        setOrgFolders((p) => ({ ...p, [orgId]: fs.map(toLocalFolder).sort(byCreatedAt) }))
      )
      .catch((e) => log.warn("library: org folders failed", { orgId, error: String(e) }));
  }, []);

  // ── Folder mutations ────────────────────────────────────────────────────────
  const createPersonalFolder = useCallback(
    (name: string) => {
      const clean = name.trim();
      if (!clean) return "";
      const folder = createLocalFolder(clean);
      setPersonalFolders(listLocalFolders());
      if (CLOUD_ENABLED && syncEnabled()) {
        createCloudFolder(folder).catch((e) =>
          toast.error(t("history.folder.createFailed", { error: errText(e) }))
        );
      }
      emitFoldersUpdated().catch(() => {});
      return folder.id;
    },
    [t]
  );

  const renamePersonalFolder = useCallback(
    (id: string, name: string) => {
      const clean = name.trim();
      if (!clean) return;
      renameLocalFolder(id, clean);
      setPersonalFolders(listLocalFolders());
      if (CLOUD_ENABLED && syncEnabled()) {
        renameCloudFolder(id, clean).catch((e) =>
          toast.error(t("history.folder.renameFailed", { error: errText(e) }))
        );
      }
      emitFoldersUpdated().catch(() => {});
    },
    [t]
  );

  const deletePersonalFolder = useCallback(
    (folder: LocalFolder) => {
      if (!globalThis.confirm(t("history.folder.deleteConfirm", { name: folder.name }))) return;
      deleteLocalFolder(folder.id);
      setPersonalFolders(listLocalFolders());
      if (CLOUD_ENABLED && syncEnabled()) {
        deleteCloudFolder(folder.id).catch((e) =>
          toast.error(t("history.folder.deleteFailed", { error: errText(e) }))
        );
      }
      emitFoldersUpdated().catch(() => {});
    },
    [t]
  );

  const createOrgFolderUI = useCallback(
    async (orgId: string, name: string) => {
      const clean = name.trim();
      if (!clean) return;
      try {
        await createOrgFolder(orgId, clean);
        ensureOrgFolders(orgId, true);
      } catch (e) {
        toast.error(t("history.folder.createFailed", { error: errText(e) }));
      }
    },
    [ensureOrgFolders, t]
  );

  const renameOrgFolderUI = useCallback(
    async (orgId: string, id: string, name: string) => {
      const clean = name.trim();
      if (!clean) return;
      try {
        await renameOrgFolder(orgId, id, clean);
        ensureOrgFolders(orgId, true);
      } catch (e) {
        toast.error(t("history.folder.renameFailed", { error: errText(e) }));
      }
    },
    [ensureOrgFolders, t]
  );

  /** Returns true when the folder was actually deleted (so the caller can move
   *  a selection that pointed at it). */
  const deleteOrgFolderUI = useCallback(
    async (orgId: string, folder: LocalFolder) => {
      if (!globalThis.confirm(t("history.folder.deleteConfirm", { name: folder.name })))
        return false;
      try {
        await deleteOrgFolder(orgId, folder.id);
        ensureOrgFolders(orgId, true);
        return true;
      } catch (e) {
        toast.error(t("history.folder.deleteFailed", { error: errText(e) }));
        return false;
      }
    },
    [ensureOrgFolders, t]
  );

  return {
    personalFolders,
    orgs,
    orgFolders,
    summaries,
    signedIn,
    ensureOrgFolders,
    reloadFolders,
    reloadSummaries,
    createPersonalFolder,
    renamePersonalFolder,
    deletePersonalFolder,
    createOrgFolder: createOrgFolderUI,
    renameOrgFolder: renameOrgFolderUI,
    deleteOrgFolder: deleteOrgFolderUI,
  };
}
