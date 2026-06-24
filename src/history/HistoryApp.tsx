import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check, Clock, Mic, Pencil, RefreshCw, Sparkles, Trash2, Upload, Users, Volume2, ZapOff } from "lucide-react";
import { toast } from "sonner";
import { useThemePreference } from "../lib/theme";
import { isTauri } from "../lib/tauriEvents";
import { log } from "../lib/log";
import { useI18n } from "../i18n";
import { deleteHistoryEntry, emitHistoryOpen, listHistory, renameHistoryEntry } from "../lib/history/history";
import { listenForSettings } from "../lib/settingsSync";
import type { HistoryEntrySummary } from "../lib/history/types";
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

/**
 * Standalone History window (Tauri multi-window, like Settings / Field Log).
 * Lists every saved session as a grid of cards; clicking one asks the main
 * window to load it into replay, the trash icon deletes it.
 */
export function HistoryApp() {
  useThemePreference();
  const { t, language } = useI18n();
  const locale = language === "en" ? "en-US" : "zh-TW";
  const [entries, setEntries] = useState<HistoryEntrySummary[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listHistory()
      .then(setEntries)
      .catch((e) => {
        log.error("history: list failed", { error: String(e) });
        setEntries([]);
      });
  }, []);

  useEffect(refresh, [refresh]);

  // This is a separate webview with its own store, so it only hydrates settings at
  // open time. Subscribe to cross-window settings changes (mirrors App.tsx) so
  // theme + language switched in the Settings window apply here live too.
  useEffect(() => {
    const un = listenForSettings();
    return () => void un.then((fn) => fn());
  }, []);

  const open = useCallback(async (id: string) => {
    await emitHistoryOpen(id);
    // Close this window so the user lands back on the (now-loaded) main window.
    if (isTauri()) {
      try {
        await getCurrentWindow().close();
      } catch (e) {
        log.warn("history: close window failed", { error: String(e) });
      }
    }
  }, []);

  const remove = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await deleteHistoryEntry(id);
        setEntries((prev) => prev?.filter((e) => e.id !== id) ?? null);
      } catch (e) {
        log.error("history: delete failed", { id, error: String(e) });
      } finally {
        setBusyId(null);
      }
    },
    [],
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
        toast.error(t("history.renameFailed", { error: e instanceof Error ? e.message : String(e) }));
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
                busy={busyId === e.id}
                onOpen={() => void open(e.id)}
                onDelete={() => void remove(e.id)}
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
  busy,
  onOpen,
  onDelete,
  onRename,
}: {
  entry: HistoryEntrySummary;
  locale: string;
  busy: boolean;
  onOpen: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}) {
  const { t } = useI18n();
  const isLive = entry.source === "live";
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
      className="group relative flex cursor-pointer flex-col gap-2 rounded-lg border bg-card p-3 text-left transition hover:border-foreground/25 hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {/* Hover actions, tucked into the top-right corner so they don't crowd the meta. */}
      {!editing && (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
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
        {entry.hasAudio && (
          <span className="ml-auto inline-flex items-center gap-1" title={t("history.hasAudio")}>
            <Volume2 className="size-3" />
          </span>
        )}
      </div>
    </div>
  );
}
