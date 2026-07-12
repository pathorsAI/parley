import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Check,
  ChevronRight,
  Clock,
  CloudCheck,
  CloudDownload,
  CloudOff,
  Folder,
  FolderClosed,
  FolderPlus,
  ListChecks,
  Loader2,
  Mic,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Share2,
  Sparkles,
  Trash2,
  Upload,
  Users,
  UsersRound,
  Volume2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useThemePreference } from "../lib/theme";
import { isTauri } from "../lib/tauriEvents";
import { log } from "../lib/log";
import { useI18n } from "../i18n";
import {
  deleteHistoryEntry,
  emitHistoryOpen,
  emitHistoryOpenOrg,
  listenForHistoryUpdated,
  renameHistoryEntry,
  setEntryFolder,
  emitHistoryImport,
} from "../lib/history/history";
import {
  createLocalFolder,
  deleteLocalFolder,
  emitFoldersUpdated,
  listLocalFolders,
  listenForFoldersUpdated,
  renameLocalFolder,
  writeLocalFolders,
  type Folder as LocalFolder,
} from "../lib/history/folders";
import {
  createCloudFolder,
  createOrgFolder,
  deleteCloudFolder,
  deleteOrgFolder,
  listCloudFolders,
  listOrgFolders,
  renameCloudFolder,
  renameOrgFolder,
  setOrgRecordingFolder,
  type CloudFolder,
} from "../lib/cloud/folders";
import {
  deleteCloudRecording,
  deleteOrgRecording,
  downloadCloudEntry,
  listMergedHistory,
  listOrgRecordings,
  moveRecordingToOrg,
  pushUnsyncedToCloud,
  shareRecordingToOrg,
  type HistoryCardItem,
  type HistorySyncState,
} from "../lib/cloud/sync";
import { pushUnsyncedFolders } from "../lib/cloud/folders";
import { syncEnabled } from "../lib/cloud/client";
import { listMyOrgs } from "../lib/cloud/orgs";
import { listenForSettings, openSettingsWindow } from "../lib/settingsSync";
import { useStore } from "../lib/store";

import { CLOUD_ENABLED } from "../lib/flags";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import type { CloudOrg, CloudRecordingSummary } from "../lib/cloud/types";
import { VoiceTypingHistory } from "./VoiceTypingHistory";

/** "+ Import" in the header: pick an audio file here, hand it to the main
 *  window's ingest wizard (which owns the transcribe→diarize→analyze flow). */
async function importRecording(): Promise<void> {
  const { settings } = useStore.getState();
  try {
    const { pickRecordingFile } = await import("../lib/replay/ingest");
    const path = await pickRecordingFile(settings);
    if (path) await emitHistoryImport(path);
  } catch (e) {
    log.error("history: import pick failed", { error: String(e) });
  }
}

/**
 * Which context (left sidebar) is selected. Both kinds carry a `folderId`: null is
 * the scope's ROOT (個人 root / org root), a string is a specific folder.
 */
type Selection =
  | { kind: "personal"; folderId: string | null }
  | { kind: "org"; id: string; name: string; folderId: string | null };

/** Where a dragged card is being dropped. */
type DropTarget =
  | { scope: "personal"; folderId: string | null }
  | { scope: "org"; orgId: string; folderId: string | null };

/** m:ss for short clips, h:mm:ss past an hour. */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatDate(ts: number, locale: string): string {
  return new Date(ts).toLocaleString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A cloud folder → the lightweight local folder shape the sidebar renders. */
function toLocalFolder(f: CloudFolder): LocalFolder {
  return { id: f.id, name: f.name, createdAt: f.createdAt };
}

const byCreatedAt = (a: LocalFolder, b: LocalFolder) => a.createdAt - b.createdAt;

/** A stable drop-target key for highlighting the row under the cursor. */
function dropKeyOf(t: DropTarget): string {
  return t.scope === "personal"
    ? `personal:${t.folderId ?? "root"}`
    : `org:${t.orgId}:${t.folderId ?? "root"}`;
}

/** Map a cloud org recording to the card shape the grid renders. */
function orgCard(c: CloudRecordingSummary): HistoryCardItem {
  return {
    id: c.id,
    title: c.title,
    source: c.source,
    createdAt: c.createdAt,
    durationMs: c.durationMs,
    speakerCount: c.speakerCount,
    findingsCount: c.findingsCount,
    actionItemsCount: c.actionItemsCount,
    hasAudio: c.hasAudio,
    snippet: c.snippet,
    folderId: c.folderId ?? null,
    sync: "cloud",
    cloudUpdatedAt: c.updatedAt,
  };
}

/** Per-card cloud-sync indicator. Hidden when signed out (sync not in use). */
function SyncIcon({ sync, signedIn }: Readonly<{ sync: HistorySyncState; signedIn: boolean }>) {
  const { t } = useI18n();
  if (!signedIn) return null;
  if (sync === "synced")
    return (
      <span className="inline-flex" title={t("history.sync.synced")}>
        <CloudCheck className="size-3 text-emerald-500/90" />
      </span>
    );
  if (sync === "stale")
    return (
      <span className="inline-flex" title={t("history.sync.stale")}>
        <RefreshCw className="size-3 text-amber-500/90" />
      </span>
    );
  if (sync === "cloud")
    return (
      <span className="inline-flex" title={t("history.sync.cloudOnly")}>
        <CloudDownload className="size-3 text-sky-500/90" />
      </span>
    );
  // Local-only while signed in → on this device, not backed up yet.
  return (
    <span className="inline-flex" title={t("history.sync.local")}>
      <CloudOff className="size-3 text-muted-foreground/60" />
    </span>
  );
}

/**
 * Standalone History window (Tauri multi-window, like Settings / Field Log).
 *
 * Left sidebar = a tree: the **personal** library (its root 個人 + one-level
 * folders) and, in the cloud edition when signed in, one expandable **shared**
 * folder tree per org. A recording's home is its scope + folderId; the two scopes
 * never mix. Drag a card onto a folder to file it; drag a personal card onto an org
 * (root or folder) to copy or move it there. Folders are one level deep.
 */
export function HistoryApp() {
  useThemePreference();
  const { t, language } = useI18n();
  const locale = language === "en" ? "en-US" : "zh-TW";
  // Hooks must run unconditionally; the flag just forces cloud UI off in the OSS build.
  const signedInRaw = useStore((s) => !!s.cloudAuth);
  const signedIn = CLOUD_ENABLED && signedInRaw;
  const [orgs, setOrgs] = useState<CloudOrg[]>([]);
  // The voice-typing log is a sibling view to the meetings library; it lives
  // outside `selection` (which is folder-scoped) so library state stays intact
  // while the user dips into it.
  const [view, setView] = useState<"library" | "voice">("library");
  const [selection, setSelection] = useState<Selection>({ kind: "personal", folderId: null });
  const [entries, setEntries] = useState<HistoryCardItem[] | null>(null);
  // Text search over the current scope (title + snippet). While active it looks
  // across ALL folders of the scope, so a match never hides behind folder
  // navigation; clearing it restores the folder view.
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Folder state. Personal folders are the local list (mirrored from cloud when
  // sync is on); org folders are fetched per org and cached, lazily on expand.
  const [personalFolders, setPersonalFolders] = useState<LocalFolder[]>(() => listLocalFolders());
  const [orgFolders, setOrgFolders] = useState<Record<string, LocalFolder[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [newFolderScope, setNewFolderScope] = useState<string | null>(null); // "personal" | orgId

  // Drag-and-drop: the card being dragged + the row currently hovered (for highlight).
  const [dragItem, setDragItem] = useState<HistoryCardItem | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  // The copy-or-move prompt shown when a personal card is dropped onto an org.
  const [movePrompt, setMovePrompt] = useState<
    { item: HistoryCardItem; org: CloudOrg; folderId: string | null } | null
  >(null);

  const isOrg = selection.kind === "org";

  // Switch back to the meetings library and select a folder/scope in one go.
  const selectLibrary = (sel: Selection) => {
    setView("library");
    setSelection(sel);
  };

  // ── Orgs ────────────────────────────────────────────────────────────────────
  const reloadOrgs = useCallback(() => {
    if (!signedIn) return;
    listMyOrgs()
      .then(setOrgs)
      .catch((e) => log.warn("history: list orgs failed", { error: String(e) }));
  }, [signedIn]);

  useEffect(() => {
    if (!signedIn) {
      setOrgs([]);
      setSelection({ kind: "personal", folderId: null });
      return;
    }
    reloadOrgs();
  }, [signedIn, reloadOrgs]);

  useEffect(() => {
    const onFocus = () => reloadOrgs();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reloadOrgs]);

  // If the selected org disappears (deleted / membership removed), snap to personal.
  useEffect(() => {
    if (selection.kind === "org" && !orgs.some((o) => o.id === selection.id)) {
      setSelection({ kind: "personal", folderId: null });
    }
  }, [orgs, selection]);

  // ── Personal folders ──────────────────────────────────────────────────────────
  // Sync on → the cloud is the source of truth (after the startup sweep uploads any
  // local-only folders), so a folder created/deleted on another device shows here.
  // Sync off / OSS → the local list is the truth.
  const loadPersonalFolders = useCallback(async () => {
    if (CLOUD_ENABLED && syncEnabled()) {
      try {
        // Push any local-only folders (created/renamed while sync was off) FIRST, so
        // mirroring the cloud list down below can't drop them — otherwise turning sync
        // on would overwrite the local cache with a cloud list that lacks them.
        await pushUnsyncedFolders();
        const cloud = (await listCloudFolders()).map(toLocalFolder).sort(byCreatedAt);
        writeLocalFolders(cloud); // refresh the local cache for offline + cross-window
        setPersonalFolders(cloud);
        return;
      } catch (e) {
        log.warn("history: cloud folders failed; using local", { error: String(e) });
      }
    }
    setPersonalFolders(listLocalFolders());
  }, []);

  useEffect(() => {
    loadPersonalFolders().catch((error) => log.warn("history: personal folders load failed", { error: String(error) }));
  }, [loadPersonalFolders, signedIn]);

  // Personal folder list can change in another window (or this one) — re-read on the
  // cross-window event and on focus so the sidebar stays in sync.
  useEffect(() => {
    const un = listenForFoldersUpdated(() => {
      loadPersonalFolders().catch((error) =>
        log.warn("history: personal folders reload failed", { error: String(error) }),
      );
    });
    const onFocus = () => {
      loadPersonalFolders().catch((error) =>
        log.warn("history: personal folders focus reload failed", { error: String(error) }),
      );
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      un.then((fn) => fn()).catch((error) =>
        log.warn("history: folders listener cleanup failed", { error: String(error) }),
      );
    };
  }, [loadPersonalFolders]);

  // ── Org folders (lazy per org) ────────────────────────────────────────────────
  // Latest org-folder cache, reachable from the fetch guard without re-creating the
  // callback on every folder change (reading it inside the state updater would make
  // that updater impure — it must only fetch when the cache is cold or a refresh is
  // forced, and otherwise leave state untouched).
  const orgFoldersRef = useRef(orgFolders);
  orgFoldersRef.current = orgFolders;
  const ensureOrgFolders = useCallback((orgId: string, force = false) => {
    if (!force && orgFoldersRef.current[orgId]) return;
    listOrgFolders(orgId)
      .then((fs) => setOrgFolders((p) => ({ ...p, [orgId]: fs.map(toLocalFolder).sort(byCreatedAt) })))
      .catch((e) => log.warn("history: org folders failed", { orgId, error: String(e) }));
  }, []);

  const toggleOrg = useCallback(
    (orgId: string) => {
      setExpanded((prev) => {
        const next = !prev[orgId];
        if (next) ensureOrgFolders(orgId);
        return { ...prev, [orgId]: next };
      });
    },
    [ensureOrgFolders],
  );

  // ── Entries for the selected scope ──────────────────────────────────────────────
  const refresh = useCallback(() => {
    setEntries(null);
    if (selection.kind === "org") {
      const orgId = selection.id;
      listOrgRecordings(orgId)
        .then((recs) => setEntries(recs.map(orgCard)))
        .catch((e) => {
          log.error("history: org list failed", { error: String(e) });
          setEntries([]);
        });
      return;
    }
    listMergedHistory()
      .then(setEntries)
      .catch((e) => {
        log.error("history: list failed", { error: String(e) });
        setEntries([]);
      });
  }, [selection]);

  // Re-list when the SCOPE changes (personal ⇄ a specific org), but NOT when only the
  // selected folder changes — folder filtering happens client-side over `entries`.
  const scopeKey = selection.kind === "org" ? `org:${selection.id}` : "personal";
  useEffect(() => {
    refresh();
    setQuery(""); // a search is scoped; don't carry it into another scope
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  // Keep the latest refresh reachable from the scope-keyed sweep below without making
  // the sweep re-run on every folder click (refresh changes with the selected folder).
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Background: push folders + any unsynced entries, then re-list so badges flip.
  // Runs once per personal-scope entry (not on folder navigation); no-op when sync off.
  useEffect(() => {
    if (isOrg) return;
    let alive = true;
    setSyncing(true);
    async function syncInBackground() {
      // loadPersonalFolders push-uploads local-only folders, then mirrors the cloud
      // list down — so a synced recording's folderId always resolves to a live folder.
      await loadPersonalFolders();
      const n = await pushUnsyncedToCloud().catch((e) => {
        log.warn("history: background sync failed", { error: String(e) });
        return 0;
      });
      if (alive && n) refreshRef.current();
    }
    syncInBackground().finally(() => {
      if (alive) setSyncing(false);
    });
    return () => {
      alive = false;
    };
  }, [isOrg, loadPersonalFolders]);

  // Cross-window: settings (theme/language) + entry re-analysis updates.
  useEffect(() => {
    const un = listenForSettings();
    return () => {
      un.then((fn) => fn()).catch((error) =>
        log.warn("history: settings listener cleanup failed", { error: String(error) }),
      );
    };
  }, []);
  useEffect(() => {
    const un = listenForHistoryUpdated(() => refresh());
    return () => {
      un.then((fn) => fn()).catch((error) =>
        log.warn("history: update listener cleanup failed", { error: String(error) }),
      );
    };
  }, [refresh]);

  // ── Folder visibility (the orphan→root rule) ────────────────────────────────────
  const scopeFolders = selection.kind === "org" ? orgFolders[selection.id] ?? [] : personalFolders;
  const liveFolderIds = new Set(scopeFolders.map((f) => f.id));
  const searchQuery = query.trim().toLowerCase();
  const visible = (entries ?? []).filter((e) => {
    // A search spans the whole scope regardless of the selected folder.
    if (searchQuery) {
      return (
        e.title.toLowerCase().includes(searchQuery) ||
        (e.snippet ?? "").toLowerCase().includes(searchQuery)
      );
    }
    const fid = e.folderId ?? null;
    if (selection.folderId === null) {
      // Root: entries with no folder OR whose folder isn't a live folder of this
      // scope (deleted, or tagged for another scope) — so nothing ever disappears.
      return fid === null || !liveFolderIds.has(fid);
    }
    return fid === selection.folderId;
  });

  // ── Open / delete / rename / share (recordings) ─────────────────────────────────
  const openItem = useCallback(
    async (item: HistoryCardItem) => {
      if (selection.kind === "org") {
        await emitHistoryOpenOrg(selection.id, item.id);
      } else {
        if (item.sync === "cloud" || item.sync === "stale") {
          setDownloadingId(item.id);
          try {
            await downloadCloudEntry(item);
          } catch (e) {
            log.error("history: download failed", { id: item.id, error: String(e) });
            toast.error(t("history.sync.downloadFailed", { error: errText(e) }));
            setDownloadingId(null);
            return;
          }
          setDownloadingId(null);
        }
        await emitHistoryOpen(item.id);
      }
      if (isTauri()) {
        try {
          await getCurrentWindow().close();
        } catch (e) {
          log.warn("history: close window failed", { error: String(e) });
        }
      }
    },
    [selection, t],
  );

  const remove = useCallback(
    async (item: HistoryCardItem) => {
      setBusyId(item.id);
      try {
        if (selection.kind === "org") {
          await deleteOrgRecording(selection.id, item.id);
        } else {
          if (item.sync !== "local") await deleteCloudRecording(item.id);
          if (item.sync !== "cloud") await deleteHistoryEntry(item.id);
        }
        setEntries((prev) => prev?.filter((e) => e.id !== item.id) ?? null);
      } catch (e) {
        log.error("history: delete failed", { id: item.id, error: String(e) });
        const key = selection.kind === "org" ? "history.org.removeFailed" : "history.sync.deleteFailed";
        toast.error(t(key, { error: errText(e) }));
      } finally {
        setBusyId(null);
      }
    },
    [selection, t],
  );

  const rename = useCallback(
    async (id: string, title: string) => {
      const clean = title.trim();
      if (!clean) return;
      try {
        await renameHistoryEntry(id, clean);
        setEntries((prev) => prev?.map((e) => (e.id === id ? { ...e, title: clean } : e)) ?? null);
      } catch (e) {
        log.error("history: rename failed", { id, error: String(e) });
        toast.error(t("history.renameFailed", { error: errText(e) }));
      }
    },
    [t],
  );

  const share = useCallback(
    async (item: HistoryCardItem, org: CloudOrg) => {
      setSharingId(item.id);
      try {
        await shareRecordingToOrg(item.id, org.id);
        toast.success(t("history.share.success", { org: org.name }));
      } catch (e) {
        log.error("history: share failed", { id: item.id, error: String(e) });
        toast.error(t("history.share.failed", { error: errText(e) }));
      } finally {
        setSharingId(null);
      }
    },
    [t],
  );

  // ── Folder mutations ────────────────────────────────────────────────────────────
  const createPersonalFolder = useCallback((name: string) => {
    const clean = name.trim();
    if (!clean) return;
    const f = createLocalFolder(clean);
    setPersonalFolders(listLocalFolders());
    setNewFolderScope(null);
    if (CLOUD_ENABLED && syncEnabled()) {
      createCloudFolder(f).catch((e) =>
        toast.error(t("history.folder.createFailed", { error: errText(e) })),
      );
    }
    emitFoldersUpdated().catch((error) => log.warn("history: folders update emit failed", { error: String(error) }));
  }, [t]);

  const renamePersonalFolder = useCallback((id: string, name: string) => {
    const clean = name.trim();
    if (!clean) return;
    renameLocalFolder(id, clean);
    setPersonalFolders(listLocalFolders());
    if (CLOUD_ENABLED && syncEnabled()) {
      renameCloudFolder(id, clean).catch((e) =>
        toast.error(t("history.folder.renameFailed", { error: errText(e) })),
      );
    }
    emitFoldersUpdated().catch((error) => log.warn("history: folders update emit failed", { error: String(error) }));
  }, [t]);

  const deletePersonalFolder = useCallback(
    (folder: LocalFolder) => {
      if (!window.confirm(t("history.folder.deleteConfirm", { name: folder.name }))) return;
      deleteLocalFolder(folder.id);
      setPersonalFolders(listLocalFolders());
      if (selection.kind === "personal" && selection.folderId === folder.id) {
        setSelection({ kind: "personal", folderId: null });
      }
      if (CLOUD_ENABLED && syncEnabled()) {
        deleteCloudFolder(folder.id).catch((e) =>
          toast.error(t("history.folder.deleteFailed", { error: errText(e) })),
        );
      }
      emitFoldersUpdated().catch((error) => log.warn("history: folders update emit failed", { error: String(error) }));
    },
    [selection, t],
  );

  const createOrgFolderUI = useCallback(
    async (orgId: string, name: string) => {
      const clean = name.trim();
      if (!clean) return;
      setNewFolderScope(null);
      try {
        await createOrgFolder(orgId, clean);
        ensureOrgFolders(orgId, true);
      } catch (e) {
        toast.error(t("history.folder.createFailed", { error: errText(e) }));
      }
    },
    [ensureOrgFolders, t],
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
    [ensureOrgFolders, t],
  );

  const deleteOrgFolderUI = useCallback(
    async (orgId: string, folder: LocalFolder) => {
      if (!window.confirm(t("history.folder.deleteConfirm", { name: folder.name }))) return;
      try {
        await deleteOrgFolder(orgId, folder.id);
        ensureOrgFolders(orgId, true);
        if (selection.kind === "org" && selection.id === orgId && selection.folderId === folder.id) {
          setSelection({ kind: "org", id: orgId, name: selection.name, folderId: null });
        }
        if (selection.kind === "org" && selection.id === orgId) refresh();
      } catch (e) {
        toast.error(t("history.folder.deleteFailed", { error: errText(e) }));
      }
    },
    [selection, refresh, t],
  );

  // ── Drag-and-drop ───────────────────────────────────────────────────────────────
  // Retag a personal card to a folder / root (a folderId reassignment on disk).
  const movePersonalCard = useCallback(
    async (item: HistoryCardItem, folderId: string | null) => {
      if ((item.folderId ?? null) === folderId) return;
      // A cloud-only card has no local meta to retag; a "stale" card would re-push
      // its OLDER local meta and clobber the newer cloud re-analysis. In both cases
      // tell the user to open it first (which downloads / pulls the latest).
      if (item.sync === "cloud" || item.sync === "stale") {
        toast.message(t("history.move.needsDownload"));
        return;
      }
      try {
        await setEntryFolder(item.id, folderId);
        setEntries((prev) =>
          prev?.map((e) => (e.id === item.id ? { ...e, folderId } : e)) ?? null,
        );
      } catch (e) {
        log.error("history: move failed", { id: item.id, error: String(e) });
        toast.error(t("history.move.failed", { error: errText(e) }));
      }
    },
    [t],
  );

  // Retag an org card to a folder / root within the same org.
  const moveOrgCard = useCallback(
    async (orgId: string, item: HistoryCardItem, folderId: string | null) => {
      if ((item.folderId ?? null) === folderId) return;
      try {
        await setOrgRecordingFolder(orgId, item.id, folderId);
        setEntries((prev) =>
          prev?.map((e) => (e.id === item.id ? { ...e, folderId } : e)) ?? null,
        );
      } catch (e) {
        log.error("history: org move failed", { id: item.id, error: String(e) });
        toast.error(t("history.move.failed", { error: errText(e) }));
      }
    },
    [t],
  );

  const handleDrop = useCallback(
    async (target: DropTarget) => {
      const item = dragItem;
      setDragItem(null);
      setDropKey(null);
      if (!item) return;

      if (selection.kind === "personal") {
        if (target.scope === "personal") {
          await movePersonalCard(item, target.folderId);
        } else {
          // Personal → org: ask copy-or-move.
          const org = orgs.find((o) => o.id === target.orgId);
          if (org) setMovePrompt({ item, org, folderId: target.folderId });
        }
        return;
      }

      // Source is an org. Only same-org folder reassignment is supported (v1).
      if (target.scope === "org" && target.orgId === selection.id) {
        await moveOrgCard(selection.id, item, target.folderId);
      }
    },
    [dragItem, selection, orgs, movePersonalCard, moveOrgCard],
  );

  const resolveMove = useCallback(
    async (mode: "copy" | "move") => {
      const p = movePrompt;
      setMovePrompt(null);
      if (!p) return;
      setBusyId(p.item.id);
      try {
        if (mode === "copy") {
          await shareRecordingToOrg(p.item.id, p.org.id, p.folderId);
          toast.success(t("history.move.copied", { org: p.org.name }));
        } else {
          await moveRecordingToOrg(p.item.id, p.org.id, p.folderId);
          setEntries((prev) => prev?.filter((e) => e.id !== p.item.id) ?? null);
          toast.success(t("history.move.moved", { org: p.org.name }));
        }
      } catch (e) {
        log.error("history: move-to-org failed", { id: p.item.id, error: String(e) });
        toast.error(t("history.move.failed", { error: errText(e) }));
      } finally {
        setBusyId(null);
      }
    },
    [movePrompt, t],
  );

  // Drop-target props shared by every droppable sidebar row.
  const dropProps = useCallback(
    (target: DropTarget) => ({
      isDropTarget: dropKey === dropKeyOf(target),
      onDragOver: (ev: React.DragEvent) => {
        if (!dragItem) return;
        ev.preventDefault();
        setDropKey(dropKeyOf(target));
      },
      onDragLeave: () => setDropKey((k) => (k === dropKeyOf(target) ? null : k)),
      onDrop: (ev: React.DragEvent) => {
        ev.preventDefault();
        handleDrop(target).catch((dropError) => log.error("history: drop failed", { error: String(dropError) }));
      },
    }),
    [dragItem, dropKey, handleDrop],
  );

  if (!isTauri()) {
    return (
      <div className="flex h-screen items-center justify-center bg-background px-6 text-center text-sm text-muted-foreground">
        {t("history.browserOnly")}
      </div>
    );
  }

  let headerLabel: string;
  if (selection.kind === "org") {
    headerLabel = selection.name;
  } else if (selection.folderId) {
    headerLabel = personalFolders.find((f) => f.id === selection.folderId)?.name ?? t("history.title");
  } else {
    headerLabel = t("history.title");
  }
  const selectedFolderName =
    selection.folderId != null
      ? scopeFolders.find((f) => f.id === selection.folderId)?.name ?? null
      : null;

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* ── Sidebar: personal tree (always) + shared org trees (cloud edition) ── */}
      <aside className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-2">
        <SidebarRow
          icon={<FolderClosed className="size-4" />}
          label={t("history.sidebar.personal")}
          active={view === "library" && selection.kind === "personal" && selection.folderId === null}
          onSelect={() => selectLibrary({ kind: "personal", folderId: null })}
          {...dropProps({ scope: "personal", folderId: null })}
        />
        {personalFolders.map((f) => (
          <SidebarRow
            key={f.id}
            depth={1}
            icon={<Folder className="size-4" />}
            label={f.name}
            active={view === "library" && selection.kind === "personal" && selection.folderId === f.id}
            onSelect={() => selectLibrary({ kind: "personal", folderId: f.id })}
            onRename={(name) => renamePersonalFolder(f.id, name)}
            onDelete={() => deletePersonalFolder(f)}
            {...dropProps({ scope: "personal", folderId: f.id })}
          />
        ))}
        {newFolderScope === "personal" ? (
          <NewFolderInput depth={1} onCommit={createPersonalFolder} onCancel={() => setNewFolderScope(null)} />
        ) : (
          <AddFolderButton depth={1} onClick={() => setNewFolderScope("personal")} />
        )}

        {/* Voice-typing dictation log — a sibling library, not a meetings folder. */}
        <SidebarRow
          icon={<Mic className="size-4" />}
          label={t("history.sidebar.voiceTyping")}
          active={view === "voice"}
          onSelect={() => setView("voice")}
        />

        {signedIn && (
          <>
            <div className="mt-3 px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
              {t("history.sidebar.shared")}
            </div>
            {orgs.map((o) => (
              <Fragment key={o.id}>
                <SidebarRow
                  icon={<UsersRound className="size-4" />}
                  label={o.name}
                  active={view === "library" && selection.kind === "org" && selection.id === o.id && selection.folderId === null}
                  expandable
                  expanded={!!expanded[o.id]}
                  onToggle={() => toggleOrg(o.id)}
                  onSelect={() => {
                    ensureOrgFolders(o.id);
                    setExpanded((p) => ({ ...p, [o.id]: true }));
                    selectLibrary({ kind: "org", id: o.id, name: o.name, folderId: null });
                  }}
                  {...dropProps({ scope: "org", orgId: o.id, folderId: null })}
                />
                {expanded[o.id] &&
                  (orgFolders[o.id] ?? []).map((f) => (
                    <SidebarRow
                      key={f.id}
                      depth={2}
                      icon={<Folder className="size-4" />}
                      label={f.name}
                      active={view === "library" && selection.kind === "org" && selection.id === o.id && selection.folderId === f.id}
                      onSelect={() => selectLibrary({ kind: "org", id: o.id, name: o.name, folderId: f.id })}
                      onRename={(name) => renameOrgFolderUI(o.id, f.id, name)}
                      onDelete={() => deleteOrgFolderUI(o.id, f)}
                      {...dropProps({ scope: "org", orgId: o.id, folderId: f.id })}
                    />
                  ))}
                {expanded[o.id] &&
                  (newFolderScope === o.id ? (
                    <NewFolderInput
                      depth={2}
                      onCommit={(name) =>
                        createOrgFolderUI(o.id, name).catch((error) =>
                          log.error("history: org folder create failed", { error: String(error), orgId: o.id }),
                        )
                      }
                      onCancel={() => setNewFolderScope(null)}
                    />
                  ) : (
                    <AddFolderButton depth={2} onClick={() => setNewFolderScope(o.id)} />
                  ))}
              </Fragment>
            ))}
            {orgs.length === 0 && (
              <p className="px-2 py-1 text-[11px] leading-snug text-muted-foreground/70">
                {t("history.org.noOrgs")}
              </p>
            )}
            <button
              type="button"
              onClick={() => openSettingsWindow().catch((error) => log.error("settings: open failed", { error: String(error) }))}
              className="mt-1 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Plus className="size-3.5" />
              {t("history.sidebar.manageOrgs")}
            </button>
          </>
        )}
      </aside>

      {/* ── Content: the meetings grid, or the voice-typing dictation log ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {view === "voice" ? (
          <VoiceTypingHistory locale={locale} />
        ) : (
          <LibraryContent
            selection={selection}
            headerLabel={headerLabel}
            selectedFolderName={selectedFolderName}
            entries={entries}
            visible={visible}
            query={query}
            onQueryChange={setQuery}
            syncing={syncing}
            locale={locale}
            signedIn={signedIn}
            orgs={orgs}
            busyId={busyId}
            downloadingId={downloadingId}
            sharingId={sharingId}
            onRefresh={refresh}
            openItem={openItem}
            remove={remove}
            rename={rename}
            share={share}
            onDragStart={setDragItem}
            onDragEnd={() => {
              setDragItem(null);
              setDropKey(null);
            }}
          />
        )}
      </div>

      {movePrompt && (
        <MoveDialog
          orgName={movePrompt.org.name}
          target={
            movePrompt.folderId
              ? `${movePrompt.org.name} / ${
                  (orgFolders[movePrompt.org.id] ?? []).find((f) => f.id === movePrompt.folderId)?.name ??
                  t("history.move.rootLabel")
                }`
              : `${movePrompt.org.name} ${t("history.move.rootLabel")}`
          }
          onCopy={() => resolveMove("copy").catch((error) => log.error("history: copy to org failed", { error: String(error) }))}
          onMove={() => resolveMove("move").catch((error) => log.error("history: move to org failed", { error: String(error) }))}
          onCancel={() => setMovePrompt(null)}
        />
      )}
      <Toaster />
    </div>
  );
}

/**
 * The meetings library pane: header (scope + breadcrumb), count, refresh, and the
 * card grid for the selected folder. Split out of HistoryApp so the voice-typing
 * log can swap into the content area without nesting this whole tree.
 */
function LibraryContent({
  selection,
  headerLabel,
  selectedFolderName,
  entries,
  visible,
  query,
  onQueryChange,
  syncing,
  locale,
  signedIn,
  orgs,
  busyId,
  downloadingId,
  sharingId,
  onRefresh,
  openItem,
  remove,
  rename,
  share,
  onDragStart,
  onDragEnd,
}: Readonly<{
  selection: Selection;
  headerLabel: string;
  selectedFolderName: string | null;
  entries: HistoryCardItem[] | null;
  visible: HistoryCardItem[];
  query: string;
  onQueryChange: (query: string) => void;
  syncing: boolean;
  locale: string;
  signedIn: boolean;
  orgs: CloudOrg[];
  busyId: string | null;
  downloadingId: string | null;
  sharingId: string | null;
  onRefresh: () => void;
  openItem: (item: HistoryCardItem) => Promise<void>;
  remove: (item: HistoryCardItem) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  share: (item: HistoryCardItem, org: CloudOrg) => Promise<void>;
  onDragStart: (item: HistoryCardItem) => void;
  onDragEnd: () => void;
}>) {
  const { t } = useI18n();
  const isOrg = selection.kind === "org";
  const searching = query.trim().length > 0;

  let emptyTitle: string;
  if (searching) emptyTitle = t("history.searchEmpty");
  else if (selection.folderId) emptyTitle = t("history.folder.empty");
  else if (isOrg) emptyTitle = t("history.org.empty");
  else emptyTitle = t("history.empty");

  let emptyHint: string;
  if (searching) emptyHint = t("history.searchEmptyHint");
  else if (selection.folderId) emptyHint = t("history.folder.emptyHint");
  else if (isOrg) emptyHint = t("history.org.emptyHint");
  else emptyHint = t("history.emptyHint");

  let body;
  if (entries === null) {
    body = (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        {t("history.loading")}
      </div>
    );
  } else if (visible.length === 0) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
        <p className="text-sm text-muted-foreground">{emptyTitle}</p>
        <p className="text-xs text-muted-foreground/70">{emptyHint}</p>
      </div>
    );
  } else {
    body = (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
        {visible.map((entry) => (
          <HistoryCard
            key={entry.id}
            entry={entry}
            locale={locale}
            signedIn={signedIn}
            isOrgContext={isOrg}
            orgs={orgs}
            busy={busyId === entry.id}
            downloading={downloadingId === entry.id}
            sharing={sharingId === entry.id}
            onOpen={() => {
              openItem(entry).catch((error) =>
                log.error("history: open failed", { id: entry.id, error: String(error) }),
              );
            }}
            onDelete={() => {
              remove(entry).catch((error) =>
                log.error("history: delete failed", { id: entry.id, error: String(error) }),
              );
            }}
            onRename={(title) => {
              rename(entry.id, title).catch((error) =>
                log.error("history: rename failed", { id: entry.id, error: String(error) }),
              );
            }}
            onShare={(org) => {
              share(entry, org).catch((error) =>
                log.error("history: share failed", {
                  id: entry.id,
                  orgId: org.id,
                  error: String(error),
                }),
              );
            }}
            onDragStart={() => onDragStart(entry)}
            onDragEnd={onDragEnd}
          />
        ))}
      </div>
    );
  }

  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        {isOrg ? (
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold tracking-tight">
            <UsersRound className="size-4 text-sky-500" />
            {selection.name}
            {selectedFolderName && (
              <>
                <ChevronRight className="size-3.5 text-muted-foreground" />
                <span className="inline-flex items-center gap-1">
                  <Folder className="size-3.5 text-muted-foreground" />
                  {selectedFolderName}
                </span>
              </>
            )}
          </span>
        ) : (
          <h1 className="inline-flex items-center gap-1.5 text-sm font-semibold tracking-tight">
            {headerLabel}
          </h1>
        )}
        <span className="text-xs text-muted-foreground">{t("history.count", { count: visible.length })}</span>
        {!isOrg && syncing && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        <div className="relative ml-auto w-48 min-w-0 shrink">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
          <input
            value={query}
            onChange={(ev) => onQueryChange(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === "Escape") onQueryChange("");
            }}
            placeholder={t("history.searchPlaceholder")}
            className="h-7 w-full rounded-md border bg-background pl-7 pr-6 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-primary"
          />
          {searching && (
            <button
              type="button"
              aria-label={t("history.searchClear")}
              onClick={() => onQueryChange("")}
              className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => void importRecording()}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Plus className="size-3.5" />
          {t("history.import")}
        </button>
        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <RefreshCw className="size-3.5" />
          {t("history.refresh")}
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">{body}</div>
    </>
  );
}

/**
 * A sidebar row: a scope root, an org, or a folder. Handles selection, drop-target
 * highlighting, an optional expand chevron, and (for folders) inline rename +
 * delete on hover. Indented by `depth`.
 */
function SidebarRow({
  icon,
  label,
  depth = 0,
  active,
  onSelect,
  expandable,
  expanded,
  onToggle,
  isDropTarget,
  onDragOver,
  onDragLeave,
  onDrop,
  onRename,
  onDelete,
}: Readonly<{
  icon: ReactNode;
  label: string;
  depth?: number;
  active: boolean;
  onSelect: () => void;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  isDropTarget?: boolean;
  onDragOver?: (ev: React.DragEvent) => void;
  onDragLeave?: () => void;
  onDrop?: (ev: React.DragEvent) => void;
  onRename?: (name: string) => void;
  onDelete?: () => void;
}>) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setDraft(label);
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.select());
  }
  function commit() {
    setEditing(false);
    if (draft.trim() && draft.trim() !== label) onRename?.(draft);
  }

  const pad = { paddingLeft: `${0.5 + depth * 0.85}rem` };

  if (editing) {
    return (
      <div className="flex items-center gap-1 rounded-md px-2 py-1" style={pad}>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
          onBlur={commit}
          className="min-w-0 flex-1 rounded border bg-background px-1.5 py-0.5 text-sm outline-none focus:border-primary"
        />
      </div>
    );
  }

  return (
    <div
      className={`group/row flex items-center rounded-md transition-colors ${
        active
          ? "bg-muted font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      } ${isDropTarget ? "ring-2 ring-primary ring-inset" : ""}`}
      style={pad}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {expandable && (
        <button
          type="button"
          aria-label={label}
          onClick={(e) => {
            e.stopPropagation();
            onToggle?.();
          }}
          className="grid size-5 shrink-0 place-items-center text-muted-foreground/70 hover:text-foreground"
        >
          <ChevronRight className={`size-3.5 transition-transform ${expanded ? "rotate-90" : ""}`} />
        </button>
      )}
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={onRename ? startEdit : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left text-sm"
      >
        <span className="shrink-0">{icon}</span>
        <span className="truncate">{label}</span>
      </button>
      {(onRename || onDelete) && (
        <div className="flex shrink-0 items-center gap-0.5 pr-1 opacity-0 transition group-hover/row:opacity-100">
          {onRename && (
            <button
              type="button"
              aria-label={t("history.folder.rename")}
              title={t("history.folder.rename")}
              onClick={(e) => {
                e.stopPropagation();
                startEdit();
              }}
              className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Pencil className="size-3" />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              aria-label={t("history.folder.delete")}
              title={t("history.folder.delete")}
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="size-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Inline "+ new folder" composer shown in the sidebar. */
function NewFolderInput({
  depth = 0,
  onCommit,
  onCancel,
}: Readonly<{
  depth?: number;
  onCommit: (name: string) => void;
  onCancel: () => void;
}>) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div
      className="flex items-center gap-1 rounded-md px-2 py-1"
      style={{ paddingLeft: `${0.5 + depth * 0.85}rem` }}
    >
      <input
        ref={ref}
        value={value}
        placeholder={t("history.folder.namePlaceholder")}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (value.trim()) onCommit(value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => (value.trim() ? onCommit(value) : onCancel())}
        className="min-w-0 flex-1 rounded border bg-background px-1.5 py-0.5 text-sm outline-none focus:border-primary"
      />
      <button
        type="button"
        aria-label={t("history.folder.create")}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (value.trim() ? onCommit(value) : onCancel())}
        className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
      >
        <Check className="size-3.5" />
      </button>
    </div>
  );
}

/** The "+ 新增資料夾" trigger row. */
function AddFolderButton({ depth = 0, onClick }: Readonly<{ depth?: number; onClick: () => void }>) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ paddingLeft: `${0.5 + depth * 0.85}rem` }}
      className="flex items-center gap-1.5 rounded-md py-1 pr-2 text-left text-xs text-muted-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
    >
      <FolderPlus className="size-3.5" />
      {t("history.folder.new")}
    </button>
  );
}

/** A small dropdown that copies a personal recording into one of the user's orgs. */
function ShareMenu({
  orgs,
  sharing,
  onShare,
}: Readonly<{
  orgs: CloudOrg[];
  sharing: boolean;
  onShare: (org: CloudOrg) => void;
}>) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        aria-label={t("history.share.button")}
        title={t("history.share.button")}
        disabled={sharing}
        onClick={(ev) => {
          ev.stopPropagation();
          setOpen((v) => !v);
        }}
        className="grid size-6 place-items-center rounded-md bg-background/70 text-muted-foreground backdrop-blur transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
      >
        {sharing ? <Loader2 className="size-3.5 animate-spin" /> : <Share2 className="size-3.5" />}
      </button>
      {open && (
        <>
          <div
            role="button"
            tabIndex={0}
            aria-label={t("common.cancel")}
            className="fixed inset-0 z-30"
            onClick={(ev) => {
              ev.stopPropagation();
              setOpen(false);
            }}
            onKeyDown={(ev) => {
              if (ev.key === "Enter" || ev.key === " " || ev.key === "Escape") {
                ev.preventDefault();
                ev.stopPropagation();
                setOpen(false);
              }
            }}
          />
          <div
            role="presentation"
            className="absolute right-0 top-7 z-40 min-w-40 rounded-md border bg-popover p-1 shadow-md"
            onClick={(ev) => ev.stopPropagation()}
            onKeyDown={(ev) => ev.stopPropagation()}
          >
            <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
              {t("history.share.menuTitle")}
            </div>
            {orgs.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  setOpen(false);
                  onShare(o);
                }}
                className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-muted"
              >
                <UsersRound className="size-3 shrink-0" />
                <span className="truncate">{o.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** The copy-or-move prompt shown when a personal card is dropped onto an org. */
function MoveDialog({
  orgName,
  target,
  onCopy,
  onMove,
  onCancel,
}: Readonly<{
  orgName: string;
  target: string;
  onCopy: () => void;
  onMove: () => void;
  onCancel: () => void;
}>) {
  const { t } = useI18n();
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t("history.move.cancel")}
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-6"
      onClick={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " " || e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <div
        role="presentation"
        className="w-full max-w-sm rounded-lg border bg-popover p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
          <UsersRound className="size-4 text-sky-500" />
          {t("history.move.title", { org: orgName })}
        </div>
        <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
          {t("history.move.body", { target })}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            <X className="mr-1 size-3.5" />
            {t("history.move.cancel")}
          </Button>
          <Button variant="outline" size="sm" onClick={onCopy}>
            {t("history.move.copy")}
          </Button>
          <Button size="sm" onClick={onMove}>
            {t("history.move.move")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function HistoryCard({
  entry,
  locale,
  signedIn,
  isOrgContext,
  orgs,
  busy,
  downloading,
  sharing,
  onOpen,
  onDelete,
  onRename,
  onShare,
  onDragStart,
  onDragEnd,
}: Readonly<{
  entry: HistoryCardItem;
  locale: string;
  signedIn: boolean;
  isOrgContext: boolean;
  orgs: CloudOrg[];
  busy: boolean;
  downloading: boolean;
  sharing: boolean;
  onOpen: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
  onShare: (org: CloudOrg) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}>) {
  const { t } = useI18n();
  const isLive = entry.source === "live";
  const isCloudOnly = !isOrgContext && entry.sync === "cloud";
  const canShare = !isOrgContext && signedIn && orgs.length > 0;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.title);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setDraft(entry.title);
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.select());
  }
  function commit() {
    setEditing(false);
    if (draft.trim() && draft.trim() !== entry.title) onRename(draft);
  }
  const body = (
    <>
      <span
        className={`inline-flex w-fit items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
          isLive ? "bg-red-500/15 text-red-500" : "bg-sky-500/15 text-sky-500"
        }`}
      >
        {isLive ? <Mic className="size-2.5" /> : <Upload className="size-2.5" />}
        {isLive ? t("history.badge.live") : t("history.badge.upload")}
      </span>

      {editing ? (
        <div className="flex items-center gap-1">
          <input
            ref={inputRef}
            value={draft}
            onChange={(ev) => setDraft(ev.target.value)}
            onKeyDown={(ev) => {
              ev.stopPropagation();
              if (ev.key === "Enter") {
                ev.preventDefault();
                commit();
              } else if (ev.key === "Escape") {
                ev.preventDefault();
                setDraft(entry.title);
                setEditing(false);
              }
            }}
            onBlur={commit}
            className="min-w-0 flex-1 rounded border bg-background px-1.5 py-1 text-sm font-medium outline-none focus:border-primary"
          />
          <button
            type="button"
            aria-label={t("history.renameSave")}
            onMouseDown={(ev) => ev.preventDefault()}
            onClick={commit}
            className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground"
          >
            <Check className="size-3.5" />
          </button>
        </div>
      ) : (
        <div className="line-clamp-2 text-sm font-medium leading-snug">{entry.title}</div>
      )}
      <div className="text-[11px] text-muted-foreground">{formatDate(entry.createdAt, locale)}</div>

      {entry.snippet && <p className="line-clamp-2 text-xs text-muted-foreground/80">{entry.snippet}</p>}

      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1 tabular-nums">
          <Clock className="size-3" />
          {formatDuration(entry.durationMs)}
        </span>
        <span className="inline-flex items-center gap-1">
          <Users className="size-3" />
          {entry.speakerCount}
        </span>
        <span className="inline-flex items-center gap-1">
          <Sparkles className="size-3" />
          {t("history.findings", { count: entry.findingsCount })}
        </span>
        {typeof entry.actionItemsCount === "number" && (
          <span className="inline-flex items-center gap-1">
            <ListChecks className="size-3" />
            {t("history.actions", { count: entry.actionItemsCount })}
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-2">
          {!isOrgContext && <SyncIcon sync={entry.sync} signedIn={signedIn} />}
          {entry.hasAudio && (
            <span className="inline-flex" title={t("history.hasAudio")}>
              <Volume2 className="size-3" />
            </span>
          )}
        </span>
      </div>
    </>
  );
  return (
    <div
      draggable={!editing}
      onDragStart={(ev) => {
        // Native DnD needs payload set for a drag to begin; the actual item is held
        // in HistoryApp state (richer than a string), so this is just a marker.
        ev.dataTransfer.setData("text/plain", entry.id);
        ev.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={`group relative flex flex-col gap-2 rounded-lg border bg-card p-3 text-left transition hover:border-foreground/25 hover:shadow-sm ${
        isCloudOnly ? "border-dashed" : ""
      }`}
    >
      {!editing && (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
          {canShare && <ShareMenu orgs={orgs} sharing={sharing} onShare={onShare} />}
          {!isCloudOnly && !isOrgContext && (
            <button
              type="button"
              aria-label={t("history.rename")}
              title={t("history.rename")}
              onClick={(ev) => {
                ev.stopPropagation();
                startEdit();
              }}
              className="grid size-6 place-items-center rounded-md bg-background/70 text-muted-foreground backdrop-blur transition-colors hover:bg-muted hover:text-foreground"
            >
              <Pencil className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            aria-label={isOrgContext ? t("history.org.remove") : t("history.delete")}
            title={isOrgContext ? t("history.org.remove") : t("history.delete")}
            disabled={busy}
            onClick={(ev) => {
              ev.stopPropagation();
              onDelete();
            }}
            className="grid size-6 place-items-center rounded-md bg-background/70 text-muted-foreground backdrop-blur transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      )}

      {editing ? (
        <div className={isCloudOnly ? "flex flex-col gap-2 opacity-70" : "flex flex-col gap-2"}>{body}</div>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className={`flex flex-col gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            isCloudOnly ? "opacity-70" : ""
          }`}
        >
          {body}
        </button>
      )}

      {downloading && (
        <div className="absolute inset-0 z-20 grid place-items-center rounded-lg bg-background/60 backdrop-blur-sm">
          <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {t("history.sync.downloading")}
          </span>
        </div>
      )}
    </div>
  );
}
