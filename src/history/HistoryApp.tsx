import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Check,
  Clock,
  CloudCheck,
  CloudDownload,
  CloudOff,
  FolderClosed,
  ListChecks,
  Loader2,
  Mic,
  Pencil,
  Plus,
  RefreshCw,
  Share2,
  Sparkles,
  Trash2,
  Upload,
  Users,
  UsersRound,
  Volume2,
  ZapOff,
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
} from "../lib/history/history";
import {
  deleteCloudRecording,
  deleteOrgRecording,
  downloadCloudEntry,
  listMergedHistory,
  listOrgRecordings,
  pushUnsyncedToCloud,
  shareRecordingToOrg,
  type HistoryCardItem,
  type HistorySyncState,
} from "../lib/cloud/sync";
import { listMyOrgs } from "../lib/cloud/orgs";
import { listenForSettings, openSettingsWindow } from "../lib/settingsSync";
import { useStore } from "../lib/store";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import type { CloudOrg, CloudRecordingSummary } from "../lib/cloud/types";

/** Which context (left sidebar) is selected: the personal library, or an org. */
type Selection = { kind: "personal" } | { kind: "org"; id: string; name: string };

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
    sync: "cloud",
    cloudUpdatedAt: c.updatedAt,
  };
}

/** Per-card cloud-sync indicator. Hidden when signed out (sync not in use). */
function SyncIcon({ sync, signedIn }: { sync: HistorySyncState; signedIn: boolean }) {
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
 * Left sidebar = contexts: the **personal** library (local ∪ own cloud) and, when
 * signed in, one **shared** folder per org the user belongs to. The two never mix:
 * personal recordings only appear under "個人", org recordings only under their org
 * — a recording's home is decided purely by which context it lives in. Sharing is
 * an explicit copy (the personal original stays); auto-saved meetings always land
 * in personal, never an org.
 */
export function HistoryApp() {
  useThemePreference();
  const { t, language } = useI18n();
  const locale = language === "en" ? "en-US" : "zh-TW";
  const signedIn = useStore((s) => !!s.cloudAuth);
  const [orgs, setOrgs] = useState<CloudOrg[]>([]);
  const [selection, setSelection] = useState<Selection>({ kind: "personal" });
  const [entries, setEntries] = useState<HistoryCardItem[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const isOrg = selection.kind === "org";

  // Re-fetch the orgs the user belongs to (for the sidebar + share menu).
  const reloadOrgs = useCallback(() => {
    if (!signedIn) return;
    listMyOrgs()
      .then(setOrgs)
      .catch((e) => log.warn("history: list orgs failed", { error: String(e) }));
  }, [signedIn]);

  // Load orgs on sign-in; clear + snap back to personal on sign-out so an org
  // context can't linger after the session ends.
  useEffect(() => {
    if (!signedIn) {
      setOrgs([]);
      setSelection({ kind: "personal" });
      return;
    }
    reloadOrgs();
  }, [signedIn, reloadOrgs]);

  // The org list can change in the Settings window (create / accept an invite).
  // Re-fetch it when this window regains focus so a new Shared folder shows up
  // without needing to reopen the window.
  useEffect(() => {
    const onFocus = () => reloadOrgs();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reloadOrgs]);

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

  useEffect(refresh, [refresh]);

  // Background: push any local entries the cloud doesn't have yet, then re-list so
  // their badges flip local → synced. Personal context only; no-op when signed out.
  useEffect(() => {
    if (isOrg) return;
    let alive = true;
    setSyncing(true);
    pushUnsyncedToCloud()
      .then((n) => {
        if (alive && n) refresh();
      })
      .catch((e) => log.warn("history: background sync failed", { error: String(e) }))
      .finally(() => {
        if (alive) setSyncing(false);
      });
    return () => {
      alive = false;
    };
  }, [refresh, isOrg]);

  // Separate webview with its own store → only hydrates settings at open time.
  // Subscribe to cross-window settings changes so theme + language apply live.
  useEffect(() => {
    const un = listenForSettings();
    return () => void un.then((fn) => fn());
  }, []);

  // Re-list when the main window overwrites an entry (re-analysis), so the grid's
  // findings count / snippet don't go stale while this window stays open.
  useEffect(() => {
    const un = listenForHistoryUpdated(() => refresh());
    return () => void un.then((fn) => fn());
  }, [refresh]);

  const openItem = useCallback(
    async (item: HistoryCardItem) => {
      if (selection.kind === "org") {
        // Org recording: the main window fetches it from the cloud and loads it
        // read-only (never persisted locally). Just hand off + close this window.
        await emitHistoryOpenOrg(selection.id, item.id);
      } else {
        // Cloud-only: download it first. Stale: re-pull so the newer cloud version
        // (re-analyzed on another device) replaces the local copy before opening.
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
      // Close this window so the user lands back on the (now-loaded) main window.
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
          // Cloud FIRST: if it fails we abort before destroying the (recoverable)
          // local copy, rather than deleting local and dangling the cloud entry.
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

  if (!isTauri()) {
    return (
      <div className="flex h-screen items-center justify-center bg-background px-6 text-center text-sm text-muted-foreground">
        {t("history.browserOnly")}
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* ── Sidebar: personal + shared (org) contexts ── */}
      <aside className="flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-2">
        <SidebarItem
          icon={<FolderClosed className="size-4" />}
          label={t("history.sidebar.personal")}
          active={!isOrg}
          onClick={() => setSelection({ kind: "personal" })}
        />
        {signedIn && (
          <>
            <div className="mt-3 px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
              {t("history.sidebar.shared")}
            </div>
            {orgs.map((o) => (
              <SidebarItem
                key={o.id}
                icon={<UsersRound className="size-4" />}
                label={o.name}
                active={isOrg && selection.id === o.id}
                onClick={() => setSelection({ kind: "org", id: o.id, name: o.name })}
              />
            ))}
            {orgs.length === 0 && (
              <p className="px-2 py-1 text-[11px] leading-snug text-muted-foreground/70">
                {t("history.org.noOrgs")}
              </p>
            )}
            <button
              type="button"
              onClick={() => void openSettingsWindow()}
              className="mt-1 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Plus className="size-3.5" />
              {t("history.sidebar.manageOrgs")}
            </button>
          </>
        )}
      </aside>

      {/* ── Content: the selected context's grid ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
          {isOrg ? (
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold tracking-tight">
              <UsersRound className="size-4 text-sky-500" />
              {selection.name}
            </span>
          ) : (
            <h1 className="text-sm font-semibold tracking-tight">{t("history.title")}</h1>
          )}
          {entries && (
            <span className="text-[11px] text-muted-foreground">
              {t("history.count", { count: entries.length })}
            </span>
          )}
          {syncing && !isOrg && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          <Button
            size="icon"
            variant="ghost"
            className="ml-auto h-8 w-8"
            aria-label={t("history.refresh")}
            title={t("history.refresh")}
            onClick={() => {
              refresh();
              reloadOrgs();
            }}
          >
            <RefreshCw className="size-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {entries === null ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t("history.loading")}
            </div>
          ) : entries.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
              <ZapOff className="size-8 opacity-40" />
              <p className="text-sm">{isOrg ? t("history.org.empty") : t("history.empty")}</p>
              <p className="max-w-xs text-xs opacity-70">
                {isOrg ? t("history.org.emptyHint") : t("history.emptyHint")}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
              {entries.map((e) => (
                <HistoryCard
                  key={e.id}
                  entry={e}
                  locale={locale}
                  signedIn={signedIn}
                  isOrgContext={isOrg}
                  orgs={orgs}
                  busy={busyId === e.id}
                  downloading={downloadingId === e.id}
                  sharing={sharingId === e.id}
                  onOpen={() => void openItem(e)}
                  onDelete={() => void remove(e)}
                  onRename={(title) => void rename(e.id, title)}
                  onShare={(org) => void share(e, org)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      <Toaster />
    </div>
  );
}

function SidebarItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
        active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      }`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

/** A small dropdown that copies a personal recording into one of the user's orgs. */
function ShareMenu({
  orgs,
  sharing,
  onShare,
}: {
  orgs: CloudOrg[];
  sharing: boolean;
  onShare: (org: CloudOrg) => void;
}) {
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
          {/* Click-away backdrop. */}
          <div
            className="fixed inset-0 z-30"
            onClick={(ev) => {
              ev.stopPropagation();
              setOpen(false);
            }}
          />
          <div
            className="absolute right-0 top-7 z-40 min-w-40 rounded-md border bg-popover p-1 shadow-md"
            onClick={(ev) => ev.stopPropagation()}
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
}: {
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
}) {
  const { t } = useI18n();
  const isLive = entry.source === "live";
  // A personal cloud-only card isn't on disk yet (dashed); org cards are always
  // remote, so they render solid (being remote is expected in a shared folder).
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
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        if (!editing) onOpen();
      }}
      onKeyDown={(ev) => {
        if (editing) return; // while renaming, the input owns the keyboard
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          onOpen();
        }
      }}
      className={`group relative flex cursor-pointer flex-col gap-2 rounded-lg border bg-card p-3 text-left transition hover:border-foreground/25 hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        isCloudOnly ? "border-dashed" : ""
      }`}
    >
      {/* Hover actions, tucked into the top-right corner so they don't crowd the meta. */}
      {!editing && (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
          {canShare && <ShareMenu orgs={orgs} sharing={sharing} onShare={onShare} />}
          {/* Cloud-only / org cards aren't on local disk, so they can't be renamed here. */}
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

      <div className={isCloudOnly ? "flex flex-col gap-2 opacity-70" : "flex flex-col gap-2"}>
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

        {entry.snippet && (
          <p className="line-clamp-2 text-xs text-muted-foreground/80">{entry.snippet}</p>
        )}

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
      </div>

      {/* Downloading a cloud-only entry — block + show progress over the card. */}
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
