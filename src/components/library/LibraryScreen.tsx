import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Folder, Loader2, Plus, RefreshCw, Search, UsersRound, X } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "../../i18n";
import { useStore, type LibrarySelection } from "../../lib/store";
import {
  deleteHistoryEntry,
  loadHistoryEntry,
  loadOrgEntry,
  listenForHistoryUpdated,
  renameHistoryEntry,
  setEntryFolder,
  emitHistoryUpdated,
} from "../../lib/history/history";
import { setOrgRecordingFolder } from "../../lib/cloud/folders";
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
} from "../../lib/cloud/sync";
import { buildOwnershipIndex, inFolderNode, inNode } from "../../lib/library/scope";
import { log } from "../../lib/log";
import { isTauri } from "../../lib/tauriEvents";
import { VoiceTypingHistory } from "../../history/VoiceTypingHistory";
import { LibraryCard, MoveDialog } from "./LibraryCards";
import type { LibraryTree } from "../shell/useLibraryTree";
import type { Folder as LocalFolder } from "../../lib/history/folders";
import type { CloudOrg, CloudRecordingSummary } from "../../lib/cloud/types";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

type Translate = ReturnType<typeof useI18n>["t"];

/** The name of the folder the selection points at, or null at a scope root. */
function openFolderName(selection: LibrarySelection, folders: LocalFolder[]): string | null {
  let id: string | null = null;
  if (selection.kind === "org") id = selection.folderId;
  else if (selection.kind === "personal" && selection.node.kind === "folder") {
    id = selection.node.folderId;
  }
  if (!id) return null;
  return folders.find((f) => f.id === id)?.name ?? null;
}

/** "Pathors AI / 和運租車" or "Pathors AI （根目錄）" — the dialog says exactly
 *  where the copy is about to land. */
function handoffTarget(
  t: Translate,
  prompt: Readonly<{ org: CloudOrg; folderId: string | null }> | null,
  orgFolders: Record<string, LocalFolder[]>
): string {
  if (!prompt) return "";
  const folder = prompt.folderId
    ? (orgFolders[prompt.org.id] ?? []).find((f) => f.id === prompt.folderId)
    : undefined;
  if (folder) return `${prompt.org.name} / ${folder.name}`;
  return `${prompt.org.name} ${t("history.move.rootLabel")}`;
}

/** Which "nothing here" copy fits the open scope. */
function emptyStateCopy(
  t: Translate,
  scope: Readonly<{ searching: boolean; hasFolder: boolean; isOrg: boolean }>
): { title: string; hint: string } {
  if (scope.searching) {
    return { title: t("history.searchEmpty"), hint: t("history.searchEmptyHint") };
  }
  if (scope.hasFolder) {
    return { title: t("history.folder.empty"), hint: t("history.folder.emptyHint") };
  }
  if (scope.isOrg) return { title: t("history.org.empty"), hint: t("history.org.emptyHint") };
  return { title: t("library.unassigned.empty"), hint: t("library.unassigned.emptyHint") };
}

/** "+ Import": the shared import flow (R7) — audio → ingest wizard, .txt →
 *  transcript import. Lazy-loaded so the ingest module stays out of the
 *  initial bundle. Importing while a folder is open pre-picks that folder: the
 *  answer is already on screen, so asking again is noise. */
async function importRecording(folderId: string | null): Promise<void> {
  try {
    const { startImportFlow } = await import("../../lib/replay/ingest");
    await startImportFlow({ folderId });
  } catch (e) {
    log.error("library: import failed", { error: String(e) });
    toast.error(e instanceof Error ? e.message : String(e));
  }
}

/**
 * The recordings library — what used to be the standalone History window's
 * right-hand pane (issue #195). The tree that selects into it lives in the app
 * shell, so "這家公司的錄音" and "這個資料夾" are one node instead of two trees
 * in two windows.
 */
export function LibraryScreen({ tree }: Readonly<{ tree: LibraryTree }>) {
  const { t, language } = useI18n();
  const locale = language === "en" ? "en-US" : "zh-TW";
  const selection = useStore((s) => s.librarySelection);

  const [entries, setEntries] = useState<HistoryCardItem[] | null>(null);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  /** A pending hand-off to an org: which recording, which org, and which of its
   *  folders (null = the org root). The copy-or-move answer comes next. */
  const [movePrompt, setMovePrompt] = useState<{
    item: HistoryCardItem;
    org: CloudOrg;
    folderId: string | null;
  } | null>(null);

  const isOrg = selection.kind === "org";
  const isVoice = selection.kind === "voice";
  const node = selection.kind === "personal" ? selection.node : null;

  // ── Entries for the selected scope ────────────────────────────────────────
  const refresh = useCallback(() => {
    if (selection.kind === "voice") return;
    setEntries(null);
    if (selection.kind === "org") {
      const orgId = selection.id;
      listOrgRecordings(orgId)
        .then((recs) => setEntries(recs.map(orgCard)))
        .catch((e) => {
          log.error("library: org list failed", { error: String(e) });
          setEntries([]);
        });
      return;
    }
    listMergedHistory()
      .then(setEntries)
      .catch((e) => {
        log.error("library: list failed", { error: String(e) });
        setEntries([]);
      });
  }, [selection]);

  // Re-list when the SCOPE changes (personal ⇄ a specific org), but NOT when only
  // the folder changes — folder filtering happens client-side over `entries`.
  const scopeKey = selection.kind === "org" ? `org:${selection.id}` : selection.kind;
  useEffect(() => {
    refresh();
    setQuery(""); // a search is scoped; don't carry it into another scope
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  useEffect(() => {
    const un = listenForHistoryUpdated(() => refresh());
    return () => {
      un.then((fn) => fn()).catch(() => {});
    };
  }, [refresh]);

  // Background: push folders + any unsynced entries, then re-list so badges flip.
  useEffect(() => {
    if (scopeKey !== "personal") return;
    let alive = true;
    setSyncing(true);
    async function syncInBackground() {
      await tree.reloadFolders();
      const n = await pushUnsyncedToCloud().catch((e) => {
        log.warn("library: background sync failed", { error: String(e) });
        return 0;
      });
      if (alive && n) refresh();
    }
    syncInBackground().finally(() => {
      if (alive) setSyncing(false);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  // The share menu offers each org's folders, so they have to be loaded before
  // it opens — the org scopes load their own on selection, but a card being
  // shared FROM the personal scope has never touched them.
  const { orgs: allOrgs, ensureOrgFolders } = tree;
  useEffect(() => {
    if (isOrg) return;
    for (const o of allOrgs) ensureOrgFolders(o.id);
  }, [isOrg, allOrgs, ensureOrgFolders]);

  // ── Node visibility ───────────────────────────────────────────────────────
  const scopeFolders =
    selection.kind === "org" ? tree.orgFolders[selection.id] ?? [] : tree.personalFolders;
  const liveFolderIds = new Set(scopeFolders.map((f) => f.id));
  const index = buildOwnershipIndex(tree.personalFolders);
  const searchQuery = query.trim().toLowerCase();
  const visible = (entries ?? []).filter((e) => {
    // A search spans the whole scope regardless of the selected node.
    if (searchQuery) {
      return (
        e.title.toLowerCase().includes(searchQuery) ||
        (e.snippet ?? "").toLowerCase().includes(searchQuery)
      );
    }
    // Same rule the tree counts with (lib/library/scope) — the number on a node
    // and what the node opens can't drift apart.
    if (selection.kind === "org") return inFolderNode(e, selection.folderId, liveFolderIds);
    return !!node && inNode(e, node, index);
  });

  // ── Card actions ──────────────────────────────────────────────────────────
  const openItem = useCallback(
    async (item: HistoryCardItem) => {
      if (selection.kind === "org") {
        await loadOrgEntry(selection.id, item.id);
        return;
      }
      if (item.sync === "cloud" || item.sync === "stale") {
        setDownloadingId(item.id);
        try {
          await downloadCloudEntry(item);
        } catch (e) {
          log.error("library: download failed", { id: item.id, error: String(e) });
          toast.error(t("history.sync.downloadFailed", { error: errText(e) }));
          setDownloadingId(null);
          return;
        }
        setDownloadingId(null);
      }
      await loadHistoryEntry(item.id);
    },
    [selection, t]
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
        tree.reloadSummaries();
      } catch (e) {
        log.error("library: delete failed", { id: item.id, error: String(e) });
        const key =
          selection.kind === "org" ? "history.org.removeFailed" : "history.sync.deleteFailed";
        toast.error(t(key, { error: errText(e) }));
      } finally {
        setBusyId(null);
      }
    },
    [selection, t, tree]
  );

  const rename = useCallback(
    async (id: string, title: string) => {
      const clean = title.trim();
      if (!clean) return;
      try {
        await renameHistoryEntry(id, clean);
        setEntries((prev) => prev?.map((e) => (e.id === id ? { ...e, title: clean } : e)) ?? null);
      } catch (e) {
        log.error("library: rename failed", { id, error: String(e) });
        toast.error(t("history.renameFailed", { error: errText(e) }));
      }
    },
    [t]
  );

  /** File a card into another folder (or take it back to 還沒歸檔). A cloud-only
   *  card has no local meta to retag, and a "stale" one would re-push its OLDER
   *  local meta over a newer cloud re-analysis — in both cases the fix is to
   *  open it first (which pulls the latest). */
  const move = useCallback(
    async (item: HistoryCardItem, folderId: string | null) => {
      if ((item.folderId ?? null) === folderId) return;
      try {
        if (item.sync === "cloud" || item.sync === "stale") {
          toast.message(t("history.move.needsDownload"));
          return;
        }
        await setEntryFolder(item.id, folderId);
        await emitHistoryUpdated(item.id);
        // Drop it from the grid immediately: it now belongs to another node.
        setEntries((prev) => prev?.filter((e) => e.id !== item.id) ?? null);
        tree.reloadSummaries();
      } catch (e) {
        log.error("library: move failed", { id: item.id, error: String(e) });
        toast.error(t("history.move.failed", { error: errText(e) }));
      }
    },
    [t, tree]
  );

  /** The org grid files into org folders, which are a different registry. */
  const moveInOrg = useCallback(
    async (item: HistoryCardItem, target: string | null) => {
      if (selection.kind !== "org" || (item.folderId ?? null) === target) return;
      try {
        await setOrgRecordingFolder(selection.id, item.id, target);
        setEntries((prev) =>
          prev?.map((e) => (e.id === item.id ? { ...e, folderId: target } : e)) ?? null
        );
      } catch (e) {
        log.error("library: org move failed", { id: item.id, error: String(e) });
        toast.error(t("history.move.failed", { error: errText(e) }));
      }
    },
    [selection, t]
  );

  const resolveOrgHandoff = useCallback(
    async (mode: "copy" | "move") => {
      const p = movePrompt;
      setMovePrompt(null);
      if (!p) return;
      setSharingId(p.item.id);
      try {
        if (mode === "copy") {
          await shareRecordingToOrg(p.item.id, p.org.id, p.folderId);
          toast.success(t("history.move.copied", { org: p.org.name }));
        } else {
          await moveRecordingToOrg(p.item.id, p.org.id, p.folderId);
          setEntries((prev) => prev?.filter((e) => e.id !== p.item.id) ?? null);
          toast.success(t("history.move.moved", { org: p.org.name }));
        }
        tree.reloadSummaries();
      } catch (e) {
        log.error("library: org handoff failed", { id: p.item.id, error: String(e) });
        toast.error(t("history.move.failed", { error: errText(e) }));
      } finally {
        setSharingId(null);
      }
    },
    [movePrompt, t, tree]
  );

  if (!isTauri()) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {t("history.browserOnly")}
      </div>
    );
  }

  if (isVoice) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <VoiceTypingHistory locale={locale} />
      </div>
    );
  }

  // ── Header identity: name the node the way the tree names it ──────────────
  const folderName = openFolderName(selection, scopeFolders);
  const searching = searchQuery.length > 0;
  const promptTarget = handoffTarget(t, movePrompt, tree.orgFolders);
  const empty = emptyStateCopy(t, { searching, hasFolder: !!folderName, isOrg });

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
        <p className="text-sm text-muted-foreground">{empty.title}</p>
        <p className="max-w-80 text-xs text-muted-foreground/70">{empty.hint}</p>
      </div>
    );
  } else {
    body = (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
        {visible.map((entry) => (
          <LibraryCard
            key={entry.id}
            entry={entry}
            locale={locale}
            signedIn={tree.signedIn}
            isOrgContext={isOrg}
            orgs={tree.orgs}
            orgFolders={tree.orgFolders}
            busy={busyId === entry.id}
            downloading={downloadingId === entry.id}
            sharing={sharingId === entry.id}
            folders={scopeFolders}
            onOpen={() => {
              openItem(entry).catch((error) =>
                log.error("library: open failed", { id: entry.id, error: String(error) })
              );
            }}
            onDelete={() => {
              remove(entry).catch(() => {});
            }}
            onRename={(title) => {
              rename(entry.id, title).catch(() => {});
            }}
            onShare={(org, folderId) => setMovePrompt({ item: entry, org, folderId })}
            onMove={(folderId) => {
              const run = isOrg ? moveInOrg(entry, folderId) : move(entry, folderId);
              run.catch(() => {});
            }}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <ScopeTitle
          isOrg={isOrg}
          orgName={selection.kind === "org" ? selection.name : null}
          folderName={folderName}
          rootLabel={t("library.unassigned")}
        />
        <span className="text-xs text-muted-foreground">
          {t("history.count", { count: visible.length })}
        </span>
        {!isOrg && syncing && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        <div className="relative ml-auto w-48 min-w-0 shrink">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
          <input
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === "Escape") setQuery("");
            }}
            placeholder={t("history.searchPlaceholder")}
            className="h-7 w-full rounded-md border bg-background pl-7 pr-6 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-primary"
          />
          {searching && (
            <button
              type="button"
              aria-label={t("history.searchClear")}
              onClick={() => setQuery("")}
              className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => void importRecording(node?.kind === "folder" ? node.folderId : null)}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Plus className="size-3.5" />
          {t("history.import")}
        </button>
        <button
          type="button"
          onClick={refresh}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <RefreshCw className="size-3.5" />
          {t("history.refresh")}
        </button>
      </header>


      <div className="min-h-0 flex-1 overflow-y-auto p-4">{body}</div>

      {movePrompt && (
        <MoveDialog
          orgName={movePrompt.org.name}
          target={promptTarget}
          onCopy={() => {
            resolveOrgHandoff("copy").catch(() => {});
          }}
          onMove={() => {
            resolveOrgHandoff("move").catch(() => {});
          }}
          onCancel={() => setMovePrompt(null)}
        />
      )}
    </div>
  );
}

function ScopeTitle({
  isOrg,
  orgName,
  folderName,
  rootLabel,
}: Readonly<{
  isOrg: boolean;
  orgName: string | null;
  folderName: string | null;
  rootLabel: string;
}>) {
  if (isOrg) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-semibold tracking-tight">
        <UsersRound className="size-4 text-sky-500" />
        {orgName}
        {folderName && (
          <>
            <ChevronRight className="size-3.5 text-muted-foreground" />
            <span className="inline-flex items-center gap-1">
              <Folder className="size-3.5 text-muted-foreground" />
              {folderName}
            </span>
          </>
        )}
      </span>
    );
  }
  return (
    <h1 className="inline-flex items-center gap-1.5 text-sm font-semibold tracking-tight">
      {folderName ? <Folder className="size-4 text-muted-foreground" /> : null}
      {folderName ?? rootLabel}
    </h1>
  );
}
