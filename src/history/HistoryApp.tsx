import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Check,
  Clock,
  CloudCheck,
  CloudDownload,
  CloudOff,
  ListChecks,
  Loader2,
  Mic,
  Pencil,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  Users,
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
  listenForHistoryUpdated,
  renameHistoryEntry,
} from "../lib/history/history";
import {
  deleteCloudRecording,
  downloadCloudEntry,
  listMergedHistory,
  pushLocalEntrySafe,
  pushUnsyncedToCloud,
  type HistoryCardItem,
  type HistorySyncState,
} from "../lib/cloud/sync";
import { listenForSettings } from "../lib/settingsSync";
import { useStore } from "../lib/store";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";

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
 * Lists every saved session as a grid of cards — local ∪ cloud when signed in.
 * Clicking a local card loads it into the main window; a cloud-only card is
 * downloaded first, then loaded. The trash icon deletes locally + from the cloud.
 */
export function HistoryApp() {
  useThemePreference();
  const { t, language } = useI18n();
  const locale = language === "en" ? "en-US" : "zh-TW";
  const signedIn = useStore((s) => !!s.cloudAuth);
  const [entries, setEntries] = useState<HistoryCardItem[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(() => {
    listMergedHistory()
      .then(setEntries)
      .catch((e) => {
        log.error("history: list failed", { error: String(e) });
        setEntries([]);
      });
  }, []);

  useEffect(refresh, [refresh]);

  // Background: push any local entries the cloud doesn't have yet, then re-list so
  // their badges flip local → synced. No-op when signed out (best-effort).
  useEffect(() => {
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
  }, [refresh]);

  // This is a separate webview with its own store, so it only hydrates settings at
  // open time. Subscribe to cross-window settings changes (mirrors App.tsx) so
  // theme + language switched in the Settings window apply here live too.
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
      // Cloud-only: download it to disk first so it loads into replay like any other.
      if (item.sync === "cloud") {
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
      // Close this window so the user lands back on the (now-loaded) main window.
      if (isTauri()) {
        try {
          await getCurrentWindow().close();
        } catch (e) {
          log.warn("history: close window failed", { error: String(e) });
        }
      }
    },
    [t],
  );

  const remove = useCallback(
    async (item: HistoryCardItem) => {
      setBusyId(item.id);
      try {
        // Cloud FIRST: if it fails we abort before destroying the (recoverable) local
        // copy, rather than deleting local and leaving a dangling cloud entry.
        if (item.sync !== "local") await deleteCloudRecording(item.id); // cloud copy
        if (item.sync !== "cloud") await deleteHistoryEntry(item.id); // local copy
        setEntries((prev) => prev?.filter((e) => e.id !== item.id) ?? null);
      } catch (e) {
        log.error("history: delete failed", { id: item.id, error: String(e) });
        toast.error(t("history.sync.deleteFailed", { error: errText(e) }));
      } finally {
        setBusyId(null);
      }
    },
    [t],
  );

  const rename = useCallback(
    async (id: string, title: string) => {
      const clean = title.trim();
      if (!clean) return;
      try {
        await renameHistoryEntry(id, clean);
        setEntries((prev) => prev?.map((e) => (e.id === id ? { ...e, title: clean } : e)) ?? null);
        // Keep the cloud copy's title in step (best-effort; no-op when signed out).
        void pushLocalEntrySafe(id);
      } catch (e) {
        log.error("history: rename failed", { id, error: String(e) });
        toast.error(t("history.renameFailed", { error: errText(e) }));
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
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <h1 className="text-sm font-semibold tracking-tight">{t("history.title")}</h1>
        {entries && (
          <span className="text-[11px] text-muted-foreground">
            {t("history.count", { count: entries.length })}
          </span>
        )}
        {syncing && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        <Button
          size="icon"
          variant="ghost"
          className="ml-auto h-8 w-8"
          aria-label={t("history.refresh")}
          title={t("history.refresh")}
          onClick={refresh}
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
            <p className="text-sm">{t("history.empty")}</p>
            <p className="max-w-xs text-xs opacity-70">{t("history.emptyHint")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            {entries.map((e) => (
              <HistoryCard
                key={e.id}
                entry={e}
                locale={locale}
                signedIn={signedIn}
                busy={busyId === e.id}
                downloading={downloadingId === e.id}
                onOpen={() => void openItem(e)}
                onDelete={() => void remove(e)}
                onRename={(title) => void rename(e.id, title)}
              />
            ))}
          </div>
        )}
      </div>
      <Toaster />
    </div>
  );
}

function HistoryCard({
  entry,
  locale,
  signedIn,
  busy,
  downloading,
  onOpen,
  onDelete,
  onRename,
}: {
  entry: HistoryCardItem;
  locale: string;
  signedIn: boolean;
  busy: boolean;
  downloading: boolean;
  onOpen: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}) {
  const { t } = useI18n();
  const isLive = entry.source === "live";
  const isCloudOnly = entry.sync === "cloud";
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
      onClick={onOpen}
      onKeyDown={(ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          onOpen();
        }
      }}
      className={`group relative flex cursor-pointer flex-col gap-2 rounded-lg border bg-card p-3 text-left transition hover:border-foreground/25 hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        isCloudOnly ? "border-dashed" : ""
      }`}
    >
      {/* Hover actions, tucked into the top-right corner so they don't crowd the meta.
          Cloud-only cards aren't on disk yet, so they can't be renamed in place. */}
      {!editing && (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
          {!isCloudOnly && (
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
            aria-label={t("history.delete")}
            title={t("history.delete")}
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
          <div className="flex items-center gap-1" onClick={(ev) => ev.stopPropagation()}>
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
            <SyncIcon sync={entry.sync} signedIn={signedIn} />
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
