import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  createLocalFolder,
  deleteLocalFolder,
  emitFoldersUpdated,
  folderGeneration,
  listLocalFolders,
  listenForFoldersUpdated,
  mirrorCloudFolders,
  renameLocalFolder,
  setLocalFolderArchived,
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
  /** Put a personal folder away (or bring it back) — nothing moves, nothing is
   *  deleted; it just leaves the tree and the filing pickers. */
  archivePersonalFolder: (id: string, archived: boolean) => void;
  /** ASK to delete a personal folder. Resolves true once the user has said yes
   *  and the folder is gone, false if they backed out. */
  deletePersonalFolder: (folder: LocalFolder) => Promise<boolean>;
  createOrgFolder: (orgId: string, name: string) => Promise<void>;
  renameOrgFolder: (orgId: string, id: string, name: string) => Promise<void>;
  deleteOrgFolder: (orgId: string, folder: LocalFolder) => Promise<boolean>;
  /** The delete waiting on an answer, or null. The hook owns it so that both
   *  doors onto the same action — the row's hover button and its context menu —
   *  can only ever put ONE dialog on screen. */
  pendingFolderDelete: { folder: LocalFolder } | null;
  confirmFolderDelete: () => void;
  cancelFolderDelete: () => void;
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
        // Read the generation before the first await: from here on the user can
        // edit the registry out from under us — this reload runs on window
        // focus, which is exactly when a dialog closing hands control back —
        // and mirrorCloudFolders needs to know the answer below is older.
        const since = folderGeneration();
        // Push local-only folders FIRST, so mirroring the cloud list down can't
        // drop folders created while sync was off.
        await pushUnsyncedFolders();
        const cloud = (await listCloudFolders()).map(toLocalFolder).sort(byCreatedAt);
        setPersonalFolders(mirrorCloudFolders(cloud, since));
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

  // Archive state is local-only (the cloud folder table has no column for it),
  // so there is no cloud call here — see Folder.archivedAt. It still broadcasts,
  // because every window in THIS instance reads the same registry file.
  const archivePersonalFolder = useCallback((id: string, archived: boolean) => {
    setLocalFolderArchived(id, archived);
    setPersonalFolders(listLocalFolders());
    emitFoldersUpdated().catch(() => {});
  }, []);

  // ── Deleting a folder, in two halves ────────────────────────────────────────
  // Asking and doing used to be one call, because `confirm()` blocked until the
  // user answered. On Windows that dialog is a window of its own, and the focus
  // it cycles on the way out raced the very delete it had just authorized (see
  // ConfirmDialog), so the question is app state now and the deed waits for the
  // answer to come back — which turns the caller's "did it actually happen?"
  // from a return value into a promise.
  //
  // The live request is kept in a ref as well as in state: the ref is what
  // confirm/cancel read, so neither callback has to be rebuilt each time a
  // request arrives, while the state is what puts the dialog on screen. Only
  // the state's shape is exposed — a caller has no business holding `resolve`.
  const pendingRef = useRef<{
    folder: LocalFolder;
    /** Absent for a personal folder; an org folder is deleted through the API. */
    orgId?: string;
    resolve: (deleted: boolean) => void;
  } | null>(null);
  const [pendingFolderDelete, setPendingFolderDelete] = useState<{
    folder: LocalFolder;
  } | null>(null);

  const requestFolderDelete = useCallback(
    (folder: LocalFolder, orgId?: string) =>
      new Promise<boolean>((resolve) => {
        // A second delete asked for while one is still on screen replaces it.
        // The outgoing request has to be answered, or whoever awaited it waits
        // for the rest of the session.
        pendingRef.current?.resolve(false);
        pendingRef.current = { folder, orgId, resolve };
        setPendingFolderDelete({ folder });
      }),
    []
  );

  const cancelFolderDelete = useCallback(() => {
    const req = pendingRef.current;
    pendingRef.current = null;
    setPendingFolderDelete(null);
    req?.resolve(false);
  }, []);

  const confirmFolderDelete = useCallback(() => {
    const req = pendingRef.current;
    pendingRef.current = null;
    setPendingFolderDelete(null);
    if (!req) return;
    const { folder, orgId, resolve } = req;
    if (orgId === undefined) {
      deleteLocalFolder(folder.id);
      setPersonalFolders(listLocalFolders());
      if (CLOUD_ENABLED && syncEnabled()) {
        deleteCloudFolder(folder.id).catch((e) =>
          toast.error(t("history.folder.deleteFailed", { error: errText(e) }))
        );
      }
      emitFoldersUpdated().catch(() => {});
      resolve(true);
      return;
    }
    // An org folder is only gone once the server says so, so unlike the local
    // registry there is a failure to report — and a caller that must not move
    // its selection off a folder that is still there.
    deleteOrgFolder(orgId, folder.id)
      .then(() => {
        ensureOrgFolders(orgId, true);
        resolve(true);
      })
      .catch((e) => {
        toast.error(t("history.folder.deleteFailed", { error: errText(e) }));
        resolve(false);
      });
  }, [ensureOrgFolders, t]);

  const deletePersonalFolder = useCallback(
    (folder: LocalFolder) => requestFolderDelete(folder),
    [requestFolderDelete]
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
   *  a selection that pointed at it) — unchanged contract, now answered by the
   *  dialog rather than by a blocking prompt. */
  const deleteOrgFolderUI = useCallback(
    (orgId: string, folder: LocalFolder) => requestFolderDelete(folder, orgId),
    [requestFolderDelete]
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
    archivePersonalFolder,
    deletePersonalFolder,
    createOrgFolder: createOrgFolderUI,
    renameOrgFolder: renameOrgFolderUI,
    deleteOrgFolder: deleteOrgFolderUI,
    pendingFolderDelete,
    confirmFolderDelete,
    cancelFolderDelete,
  };
}
