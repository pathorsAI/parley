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
  isCloudGoneError,
  listMergedHistory,
  listOrgRecordings,
  moveRecordingToOrg,
  pushUnsyncedToCloud,
  shareRecordingToOrg,
  type HistoryCardItem,
} from "../../lib/cloud/sync";
import { buildOwnershipIndex, inFolderNode, inNode, nodeKey } from "../../lib/library/scope";
import { newestFirst } from "../../lib/library/timeline";
import { log } from "../../lib/log";
import { markGettingStarted } from "../../lib/onboarding/gettingStarted";
import { isTauri } from "../../lib/tauriEvents";
import { VoiceTypingHistory } from "../../history/VoiceTypingHistory";
import { LibraryCard, LibraryCardsSkeleton } from "./LibraryCards";
import { DestinationSheet } from "../DestinationSheet";
import { ConfirmDialog } from "../shell/ConfirmDialog";
import { RecordingTimeline, RecordingTimelineSkeleton } from "./RecordingTimeline";
import { useRenderWindow } from "./useRenderWindow";
import type { LibraryTree } from "../shell/useLibraryTree";
import { filingChoices, type Folder as LocalFolder } from "../../lib/history/folders";
import type { CloudRecordingSummary } from "../../lib/cloud/types";
import type { LibraryDestination, OrgHandoffMode } from "../../lib/library/destination";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Map a cloud org recording to the card shape the list renders. */
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

/** Which "nothing here" copy fits the open scope. */
function emptyStateCopy(
  t: Translate,
  scope: Readonly<{ searching: boolean; hasFolder: boolean; isOrg: boolean; isAll: boolean }>
): { title: string; hint: string } {
  if (scope.searching) {
    return { title: t("history.searchEmpty"), hint: t("history.searchEmptyHint") };
  }
  if (scope.hasFolder) {
    return { title: t("history.folder.empty"), hint: t("history.folder.emptyHint") };
  }
  if (scope.isOrg) return { title: t("history.org.empty"), hint: t("history.org.emptyHint") };
  // Empty here means empty everywhere — there is no folder left to go and look in.
  if (scope.isAll) return { title: t("library.all.empty"), hint: t("library.all.emptyHint") };
  return { title: t("library.unassigned.empty"), hint: t("library.unassigned.emptyHint") };
}

/** The delete dialog's words: in an org scope the action is "remove from the
 *  org", everywhere else it is a delete. */
function deleteDialogCopy(
  t: Translate,
  isOrg: boolean,
  title: string
): { title: string; body: string; confirmLabel: string } {
  if (isOrg) {
    return {
      title: t("history.org.remove"),
      body: t("history.org.removeConfirm", { title }),
      confirmLabel: t("history.org.remove"),
    };
  }
  return {
    title: t("history.delete"),
    body: t("history.deleteConfirm", { title }),
    confirmLabel: t("common.delete"),
  };
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
 * Where a card in this scope can be MOVED, which is not the same list as what
 * exists: an archived personal folder is still a home for what is already in it,
 * but nothing new gets filed into one. The folder currently OPEN stays offered
 * even when archived, so a card sitting in it still shows the check beside its
 * own home. Org folders carry no archive state and pass straight through.
 */
function moveTargetFolders(
  selection: LibrarySelection,
  scopeFolders: LocalFolder[]
): LocalFolder[] {
  if (selection.kind !== "personal") return scopeFolders;
  const open = selection.node.kind === "folder" ? selection.node.folderId : null;
  return filingChoices(scopeFolders, open);
}

/**
 * Which action a destination means for a card: a refile inside the open org,
 * a personal folder change, or a handoff into an org.
 */
function routeFiling(
  inOrg: boolean,
  item: HistoryCardItem,
  destination: LibraryDestination,
  mode: OrgHandoffMode | null,
  actions: Readonly<{
    moveInOrg: (item: HistoryCardItem, folderId: string | null) => Promise<void>;
    move: (item: HistoryCardItem, folderId: string | null) => Promise<void>;
    handOffToOrg: (
      item: HistoryCardItem,
      orgId: string,
      folderId: string | null,
      mode: OrgHandoffMode
    ) => Promise<void>;
  }>
): Promise<void> {
  if (inOrg) return actions.moveInOrg(item, destination.folderId);
  if (destination.scope === "personal") return actions.move(item, destination.folderId);
  return actions.handOffToOrg(item, destination.orgId, destination.folderId, mode ?? "move");
}

/** Where a card lives: its folder in the open org, or in Personal. */
function cardLocation(selection: LibrarySelection, item: HistoryCardItem): LibraryDestination {
  if (selection.kind === "org") return { scope: "org", orgId: selection.id, folderId: item.folderId ?? null };
  return { scope: "personal", folderId: item.folderId ?? null };
}

/** What the open list is a list OF — the scope, the node within it, the search.
 *  A change starts the render window (useRenderWindow) back on its first page. */
function listKey(selection: LibrarySelection, searchQuery: string): string {
  let where = "";
  if (selection.kind === "org") where = `org:${selection.id}:${selection.folderId ?? ""}`;
  else if (selection.kind === "personal") where = `personal:${nodeKey(selection.node)}`;
  return `${where}|${searchQuery}`;
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
  /** The delete waiting on an answer. Both doors onto the action — the card's
   *  trash button and the timeline row's — go through here, so only one dialog
   *  can ever be on screen. */
  const [pendingDelete, setPendingDelete] = useState<HistoryCardItem | null>(null);
  /** The card whose destination sheet is open. Every door onto filing — the
   *  card's toolbar, its context menu, the timeline row — goes through here. */
  const [fileItem, setFileItem] = useState<HistoryCardItem | null>(null);
  const closeFiling = useCallback((open: boolean) => {
    if (!open) setFileItem(null);
  }, []);

  const isOrg = selection.kind === "org";
  const isVoice = selection.kind === "voice";
  const node = selection.kind === "personal" ? selection.node : null;
  const isAll = node?.kind === "all";

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

  // ── Node visibility ───────────────────────────────────────────────────────
  const scopeFolders =
    selection.kind === "org" ? tree.orgFolders[selection.id] ?? [] : tree.personalFolders;
  const moveFolders = moveTargetFolders(selection, scopeFolders);
  const liveFolderIds = new Set(scopeFolders.map((f) => f.id));
  const index = buildOwnershipIndex(tree.personalFolders);
  const searchQuery = query.trim().toLowerCase();
  const visible = newestFirst(entries ?? []).filter((e) => {
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

  // Mount the list a page at a time — see useRenderWindow. The count in the
  // header still reads off `visible`: it is what's in the node, not what's mounted.
  const { shown, sentinel } = useRenderWindow(visible, listKey(selection, searchQuery));

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
      // Same guard as `move` below, for the same reason: a cloud-only card has no
      // local meta to rename, and a "stale" one would push its OLDER local meta
      // (title, filing suggestion and all) over the newer cloud copy. Open it
      // first — that pulls the latest — then rename.
      const item = entries?.find((e) => e.id === id);
      if (item && (item.sync === "cloud" || item.sync === "stale")) {
        toast.message(t("history.rename.needsDownload"));
        return;
      }
      try {
        await renameHistoryEntry(id, clean);
        setEntries((prev) => prev?.map((e) => (e.id === id ? { ...e, title: clean } : e)) ?? null);
      } catch (e) {
        log.error("library: rename failed", { id, error: String(e) });
        toast.error(t("history.renameFailed", { error: errText(e) }));
      }
    },
    [entries, t]
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
        if (folderId) markGettingStarted("filed");
        await emitHistoryUpdated(item.id);
        // A folder node shows one node's worth, so a re-filed recording leaves
        // it. The all node shows every node's worth, so the same recording
        // stays put and only its folder chip changes — dropping it there would
        // make filing something look like deleting it.
        setEntries((prev) => {
          if (!prev) return null;
          if (isAll) return prev.map((e) => (e.id === item.id ? { ...e, folderId } : e));
          return prev.filter((e) => e.id !== item.id);
        });
        tree.reloadSummaries();
      } catch (e) {
        log.error("library: move failed", { id: item.id, error: String(e) });
        toast.error(t("history.move.failed", { error: errText(e) }));
      }
    },
    [isAll, t, tree]
  );

  /** The org grid files into org folders, which are a different registry. */
  const moveInOrg = useCallback(
    async (item: HistoryCardItem, target: string | null) => {
      if (selection.kind !== "org" || (item.folderId ?? null) === target) return;
      try {
        await setOrgRecordingFolder(selection.id, item.id, target);
        if (target) markGettingStarted("filed");
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

  /** Hand a personal recording to an org: a copy, or a move that drops the
   *  personal original once the org copy is in. */
  const handOffToOrg = useCallback(
    async (item: HistoryCardItem, orgId: string, folderId: string | null, mode: OrgHandoffMode) => {
      const orgName = tree.orgs.find((o) => o.id === orgId)?.name ?? "";
      setSharingId(item.id);
      try {
        if (mode === "copy") {
          await shareRecordingToOrg(item.id, orgId, folderId);
          toast.success(t("history.move.copied", { org: orgName }));
        } else {
          await moveRecordingToOrg(item.id, orgId, folderId);
          setEntries((prev) => prev?.filter((e) => e.id !== item.id) ?? null);
          toast.success(t("history.move.moved", { org: orgName }));
        }
        markGettingStarted("filed");
        tree.reloadSummaries();
      } catch (e) {
        log.error("library: org handoff failed", { id: item.id, error: String(e) });
        toast.error(
          isCloudGoneError(e)
            ? t("history.move.cloudGone")
            : t("history.move.failed", { error: errText(e) })
        );
      } finally {
        setSharingId(null);
      }
    },
    [t, tree]
  );

  /** The destination sheet's answer for a card, routed to the action it means. */
  const fileTo = useCallback(
    (item: HistoryCardItem, destination: LibraryDestination, mode: OrgHandoffMode | null) => {
      routeFiling(selection.kind === "org", item, destination, mode, {
        moveInOrg,
        move,
        handOffToOrg,
      }).catch(() => {});
    },
    [selection, moveInOrg, move, handOffToOrg]
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
  const empty = emptyStateCopy(t, { searching, hasFolder: !!folderName, isOrg, isAll });

  let body;
  if (entries === null) {
    // Rows in the list's own shape, from the top, so the list lands in place
    // instead of replacing a spinner centred in the pane.
    body = <ListSkeleton timeline={isAll} label={t("history.loading")} />;
  } else if (visible.length === 0) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
        <p className="text-sm text-muted-foreground">{empty.title}</p>
        <p className="max-w-80 text-xs text-muted-foreground/70">{empty.hint}</p>
      </div>
    );
  } else if (isAll) {
    // A different question deserves a different shape — see RecordingTimeline.
    body = (
      <>
        <RecordingTimeline
          entries={shown}
          locale={locale}
          signedIn={tree.signedIn}
          orgs={tree.orgs}
          busyId={busyId}
          downloadingId={downloadingId}
          sharingId={sharingId}
          folders={moveFolders}
          onOpen={(entry) => {
            openItem(entry).catch((error) =>
              log.error("library: open failed", { id: entry.id, error: String(error) })
            );
          }}
          onDelete={(entry) => setPendingDelete(entry)}
          onRename={(id, title) => {
            rename(id, title).catch(() => {});
          }}
          onFile={setFileItem}
        />
        {sentinel}
      </>
    );
  } else {
    body = (
      <>
        <div className="flex flex-col divide-y divide-border">
          {shown.map((entry) => (
            <LibraryCard
              key={entry.id}
              entry={entry}
              locale={locale}
              signedIn={tree.signedIn}
              isOrgContext={isOrg}
              orgs={tree.orgs}
              busy={busyId === entry.id}
              downloading={downloadingId === entry.id}
              sharing={sharingId === entry.id}
              folders={moveFolders}
              onOpen={() => {
                openItem(entry).catch((error) =>
                  log.error("library: open failed", { id: entry.id, error: String(error) })
                );
              }}
              onDelete={() => setPendingDelete(entry)}
              onRename={(title) => {
                rename(entry.id, title).catch(() => {});
              }}
              onFile={() => setFileItem(entry)}
            />
          ))}
        </div>
        {sentinel}
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <ScopeTitle
          isOrg={isOrg}
          orgName={selection.kind === "org" ? selection.name : null}
          folderName={folderName}
          rootLabel={isAll ? t("library.all") : t("library.unassigned")}
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


      {/* The timeline's date headers are sticky, so it owns its own top padding
          — rows must slide under the header, not through a gap above it. */}
      <div className={`min-h-0 flex-1 overflow-y-auto ${isAll ? "px-4 pb-4" : "p-4"}`}>{body}</div>

      {pendingDelete && (
        <ConfirmDialog
          // The trash button's own label doubles as the title, so the action
          // has one name whether it is read off a tooltip or off this dialog.
          {...deleteDialogCopy(t, isOrg, pendingDelete.title)}
          cancelLabel={t("common.cancel")}
          onConfirm={() => {
            const item = pendingDelete;
            setPendingDelete(null);
            remove(item).catch(() => {});
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      <DestinationSheet
        open={!!fileItem}
        onOpenChange={closeFiling}
        title={t("library.menu.move")}
        verb="move"
        current={fileItem ? cardLocation(selection, fileItem) : null}
        lockWorkspace={selection.kind === "org" ? selection.id : undefined}
        onConfirm={(destination, mode) => {
          if (fileItem) fileTo(fileItem, destination, mode);
        }}
      />
    </div>
  );
}

/** The loading rows, in the shape of whichever list is about to land. */
function ListSkeleton({ timeline, label }: Readonly<{ timeline: boolean; label: string }>) {
  return timeline ? <RecordingTimelineSkeleton label={label} /> : <LibraryCardsSkeleton label={label} />;
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
        <UsersRound className="size-4 text-muted-foreground" />
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
