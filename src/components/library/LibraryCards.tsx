import { useRef, useState } from "react";
import {
  Check,
  Clock,
  CloudCheck,
  CloudDownload,
  CloudOff,
  Folder,
  FolderClosed,
  FolderInput,
  ListChecks,
  Loader2,
  Mic,
  Pencil,
  RefreshCw,
  Share2,
  Sparkles,
  Trash2,
  Upload,
  Users,
  UsersRound,
  Volume2,
  X,
} from "lucide-react";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";
import type { Folder as LocalFolder } from "../../lib/history/folders";
import type { HistoryCardItem, HistorySyncState } from "../../lib/cloud/sync";
import type { CloudOrg } from "../../lib/cloud/types";

/**
 * The recording card and its menus. Lifted out of the old standalone History
 * window (issue #195) so the same cards render inside the main window's library
 * route.
 *
 * One thing did NOT come along: dragging a card onto a sidebar folder. The main
 * window has Tauri's native drag-drop ON (it is how an audio file is dropped
 * into the ingest wizard), and that handler swallows the webview's dragover/
 * drop events — the History window could only offer drag because it opted out
 * with `dragDropEnabled: false`. Every move drag could do is on the card's own
 * folder menu, which was already the documented click alternative.
 */

/** m:ss for short clips, h:mm:ss past an hour. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatDate(ts: number, locale: string): string {
  return new Date(ts).toLocaleString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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
  return (
    <span className="inline-flex" title={t("history.sync.local")}>
      <CloudOff className="size-3 text-muted-foreground/70" />
    </span>
  );
}

/** Shared scrim + popover chrome for the two card menus. */
function MenuShell({
  title,
  onClose,
  children,
}: Readonly<{ title: string; onClose: () => void; children: React.ReactNode }>) {
  const { t } = useI18n();
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label={t("common.cancel")}
        className="fixed inset-0 z-30"
        onClick={(ev) => {
          ev.stopPropagation();
          onClose();
        }}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" || ev.key === " " || ev.key === "Escape") {
            ev.preventDefault();
            ev.stopPropagation();
            onClose();
          }
        }}
      />
      <div
        role="presentation"
        className="absolute right-0 top-7 z-40 max-h-64 min-w-40 overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
        onClick={(ev) => ev.stopPropagation()}
        onKeyDown={(ev) => ev.stopPropagation()}
      >
        <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
          {title}
        </div>
        {children}
      </div>
    </>
  );
}

/**
 * Per-card "move to folder" menu. Since #195 this is the ONLY way to refile a
 * recording (see the note at the top of this file), so it carries a company's
 * folder under the company's own name — the tree and this menu name the same
 * place the same way.
 */
function MoveMenu({
  folders,
  currentFolderId,
  onMove,
}: Readonly<{
  folders: LocalFolder[];
  currentFolderId: string | null;
  onMove: (folderId: string | null) => void;
}>) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const options: { id: string | null; name: string }[] = [
    { id: null, name: t("history.move.rootOption") },
    ...folders.map((f) => ({ id: f.id, name: f.name })),
  ];
  return (
    <div className="relative">
      <button
        type="button"
        aria-label={t("history.move.button")}
        title={t("history.move.button")}
        onClick={(ev) => {
          ev.stopPropagation();
          setOpen((v) => !v);
        }}
        className="grid size-6 place-items-center rounded-md bg-background/70 text-muted-foreground backdrop-blur transition-colors hover:bg-muted hover:text-foreground"
      >
        <FolderInput className="size-3.5" />
      </button>
      {open && (
        <MenuShell title={t("history.move.menuTitle")} onClose={() => setOpen(false)}>
          {options.map((o) => {
            const current = (currentFolderId ?? null) === o.id;
            return (
              <button
                key={o.id ?? "__root"}
                type="button"
                disabled={current}
                onClick={(ev) => {
                  ev.stopPropagation();
                  setOpen(false);
                  onMove(o.id);
                }}
                className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-muted disabled:opacity-60 disabled:hover:bg-transparent"
              >
                {o.id === null ? (
                  <FolderClosed className="size-3 shrink-0" />
                ) : (
                  <Folder className="size-3 shrink-0" />
                )}
                <span className="truncate">{o.name}</span>
                {current && <Check className="ml-auto size-3 shrink-0" />}
              </button>
            );
          })}
        </MenuShell>
      )}
    </div>
  );
}

/** Pick an org to hand this recording to; the copy-or-move choice follows. */
function ShareMenu({
  orgs,
  sharing,
  onPick,
}: Readonly<{ orgs: CloudOrg[]; sharing: boolean; onPick: (org: CloudOrg) => void }>) {
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
        <MenuShell title={t("history.share.menuTitle")} onClose={() => setOpen(false)}>
          {orgs.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={(ev) => {
                ev.stopPropagation();
                setOpen(false);
                onPick(o);
              }}
              className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-muted"
            >
              <UsersRound className="size-3 shrink-0" />
              <span className="truncate">{o.name}</span>
            </button>
          ))}
        </MenuShell>
      )}
    </div>
  );
}

/** Copy (leave the personal one) or move (hand it over) into an org. */
export function MoveDialog({
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

export function LibraryCard({
  entry,
  locale,
  signedIn,
  isOrgContext,
  orgs,
  busy,
  downloading,
  sharing,
  folders,
  onOpen,
  onDelete,
  onRename,
  onShare,
  onMove,
}: Readonly<{
  entry: HistoryCardItem;
  locale: string;
  signedIn: boolean;
  isOrgContext: boolean;
  orgs: CloudOrg[];
  busy: boolean;
  downloading: boolean;
  sharing: boolean;
  /** The current scope's folders (personal or the open org's) for the move menu. */
  folders: LocalFolder[];
  onOpen: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
  onShare: (org: CloudOrg) => void;
  onMove: (folderId: string | null) => void;
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
    </>
  );
  return (
    <div
      className={`group relative flex flex-col gap-2 rounded-lg border bg-card p-3 text-left transition hover:border-foreground/25 hover:shadow-sm ${
        isCloudOnly ? "border-dashed" : ""
      }`}
    >
      {!editing && (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
          {folders.length > 0 && (
            <MoveMenu folders={folders} currentFolderId={entry.folderId ?? null} onMove={onMove} />
          )}
          {canShare && <ShareMenu orgs={orgs} sharing={sharing} onPick={onShare} />}
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
        <div className={isCloudOnly ? "flex flex-col gap-2 opacity-70" : "flex flex-col gap-2"}>
          {body}
        </div>
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
