import { useRef, useState } from "react";
import {
  AudioLines,
  Check,
  Clock,
  CloudCheck,
  CloudDownload,
  CloudOff,
  FolderInput,
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
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "../../i18n";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
  openMenuFromKeyboard,
  preventFocusRestore,
} from "@/components/ui/context-menu";
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

/** Per-recording cloud-sync indicator. Hidden when signed out (sync not in use).
 *  Shared with the all-recordings timeline so a row and a card say the same thing. */
export function SyncIcon({ sync, signedIn }: Readonly<{ sync: HistorySyncState; signedIn: boolean }>) {
  const { t } = useI18n();
  if (!signedIn) return null;
  if (sync === "synced")
    return (
      <span className="inline-flex" title={t("history.sync.synced")}>
        <CloudCheck className="size-3 text-success-foreground" />
      </span>
    );
  if (sync === "stale")
    return (
      <span className="inline-flex" title={t("history.sync.stale")}>
        <RefreshCw className="size-3 text-warning-foreground" />
      </span>
    );
  if (sync === "cloud")
    return (
      <span className="inline-flex" title={t("history.sync.cloudOnly")}>
        <CloudDownload className="size-3 text-info-foreground" />
      </span>
    );
  return (
    <span className="inline-flex" title={t("history.sync.local")}>
      <CloudOff className="size-3 text-muted-foreground/70" />
    </span>
  );
}

/**
 * Which of the four actions a given card can actually offer.
 *
 * Shared because a card now exposes them twice — the hover toolbar and the
 * right-click menu — and a rule that lived in only one of them would let the
 * menu offer a rename the toolbar already knows is impossible.
 */
function cardCapabilities(
  o: Readonly<{ isOrgContext: boolean; isCloudOnly: boolean; folderCount: number }>
): { canMove: boolean; canRename: boolean } {
  return {
    // An org card files into org folders (so it needs at least one); a personal
    // one needs local meta to retag, which a cloud-only card does not have.
    canMove: o.isOrgContext ? o.folderCount > 0 : !o.isCloudOnly,
    canRename: !o.isCloudOnly && !o.isOrgContext,
  };
}

/**
 * The hover toolbar: file, rename, delete.
 *
 * Exported because the all-recordings timeline (#330) offers exactly the same
 * actions on a row — filing something you just found is the whole point of a
 * view that spans every folder. Only the placement differs, which is what
 * `className` is for: a card pins it to the top-right corner, a row sits it in
 * the flow at the end of the line.
 *
 * Filing is ONE button: a folder in Personal and a folder in an org are the
 * same question, answered in the destination sheet (#577). It used to be two
 * menus — move (personal folders) and share (orgs), then a copy-or-move dialog.
 */
export function CardActions({
  className = "absolute right-2 top-2 z-10 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100",
  isOrgContext,
  isCloudOnly,
  canShare,
  busy,
  filing,
  folders,
  onDelete,
  onRenameStart,
  onFile,
}: Readonly<{
  /** Where the toolbar sits. Defaults to a card's top-right corner. */
  className?: string;
  isOrgContext: boolean;
  isCloudOnly: boolean;
  /** An org exists to file into. */
  canShare: boolean;
  busy: boolean;
  /** A handoff to an org is in flight. */
  filing: boolean;
  folders: LocalFolder[];
  onDelete: () => void;
  onRenameStart: () => void;
  onFile: () => void;
}>) {
  const { t } = useI18n();
  const { canMove, canRename } = cardCapabilities({
    isOrgContext,
    isCloudOnly,
    folderCount: folders.length,
  });
  const deleteLabel = isOrgContext ? t("history.org.remove") : t("history.delete");
  return (
    <div className={className}>
      {(canMove || canShare) && (
        <button
          type="button"
          aria-label={t("library.menu.move")}
          title={t("library.menu.move")}
          disabled={filing}
          onClick={(ev) => {
            ev.stopPropagation();
            onFile();
          }}
          className="grid size-6 place-items-center rounded-md bg-background/70 text-muted-foreground backdrop-blur transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          {filing ? <Loader2 className="size-3.5 animate-spin" /> : <FolderInput className="size-3.5" />}
        </button>
      )}
      {canRename && (
        <button
          type="button"
          aria-label={t("history.rename")}
          title={t("history.rename")}
          onClick={(ev) => {
            ev.stopPropagation();
            onRenameStart();
          }}
          className="grid size-6 place-items-center rounded-md bg-background/70 text-muted-foreground backdrop-blur transition-colors hover:bg-muted hover:text-foreground"
        >
          <Pencil className="size-3.5" />
        </button>
      )}
      <button
        type="button"
        aria-label={deleteLabel}
        title={deleteLabel}
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
  onFile,
}: Readonly<{
  entry: HistoryCardItem;
  locale: string;
  signedIn: boolean;
  isOrgContext: boolean;
  orgs: CloudOrg[];
  busy: boolean;
  downloading: boolean;
  /** A handoff to an org is in flight. */
  sharing: boolean;
  /** The open scope's folders — one customer, one folder. */
  folders: LocalFolder[];
  onOpen: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
  /** Open the destination sheet for this card. */
  onFile: () => void;
}>) {
  const { t } = useI18n();
  const isLive = entry.source === "live";
  const isCloudOnly = !isOrgContext && entry.sync === "cloud";
  const canShare = !isOrgContext && signedIn && orgs.length > 0;
  const { canMove, canRename } = cardCapabilities({
    isOrgContext,
    isCloudOnly,
    folderCount: folders.length,
  });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  // The menu's close handler runs from a listener Radix registered on an earlier
  // render, so reading `editing` through the closure can report the stale value
  // and steal focus back off the name input.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const handingOffRef = useRef(false);

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
          isLive ? "bg-info text-info-foreground" : "bg-muted text-muted-foreground"
        }`}
      >
        {isLive ? <Mic className="size-2.5" /> : <Upload className="size-2.5" />}
        {isLive ? t("history.badge.live") : t("history.badge.upload")}
      </span>

      {editing ? (
        <div className="flex items-center gap-1">
          <input
            ref={inputRef}
            // Right-clicking a text field has to reach the webview's own edit
            // menu; without this the card's menu swallows cut/copy/paste.
            onContextMenu={(ev) => ev.stopPropagation()}
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
  const card = (
    <div
      // A row in a hairline-separated list, not a boxed card: the list's
      // dividers do the separating (cloud-only reads as dimmed, below).
      className="group relative flex flex-col gap-2 px-2 py-3 text-left transition-colors hover:bg-muted/60"
    >
      {!editing && (
        <CardActions
          isOrgContext={isOrgContext}
          isCloudOnly={isCloudOnly}
          canShare={canShare}
          busy={busy}
          filing={sharing}
          folders={folders}
          onDelete={onDelete}
          onRenameStart={startEdit}
          onFile={onFile}
        />
      )}

      {editing ? (
        <div className={isCloudOnly ? "flex flex-col gap-2 opacity-70" : "flex flex-col gap-2"}>
          {body}
        </div>
      ) : (
        <button
          ref={openRef}
          type="button"
          onClick={onOpen}
          // The card's only focusable element, so it is where a keyboard user is
          // standing when they ask for the menu; the event bubbles to the trigger.
          onKeyDown={openMenuFromKeyboard}
          className={`flex flex-col gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            isCloudOnly ? "opacity-70" : ""
          }`}
        >
          {body}
        </button>
      )}

      {downloading && (
        <div className="absolute inset-0 z-20 grid place-items-center bg-background/60 backdrop-blur-sm">
          <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {t("history.sync.downloading")}
          </span>
        </div>
      )}
    </div>
  );

  // A second way to reach the toolbar's own actions, not a second set of them —
  // one that does not depend on noticing icons that only appear on hover, and
  // that a keyboard can summon at all.
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={(event) => {
          preventFocusRestore(event);
          // Closing without renaming should leave the keyboard where it was, and
          // Radix's own restore aims at the trigger — a plain <div>, which
          // cannot take focus, so it would drop to the body instead.
          if (handingOffRef.current) {
            handingOffRef.current = false;
            return;
          }
          if (!editingRef.current) openRef.current?.focus();
        }}
      >
        <ContextMenuLabel>{entry.title}</ContextMenuLabel>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onOpen}>
          <AudioLines className="size-3.5" />
          {t("library.menu.open")}
        </ContextMenuItem>
        {canRename && (
          <ContextMenuItem onSelect={startEdit}>
            <Pencil className="size-3.5" />
            {t("library.menu.rename")}
          </ContextMenuItem>
        )}
        {(canMove || canShare) && (
          <ContextMenuItem
            onSelect={() => {
              // The sheet takes focus; don't pull it back to the card.
              handingOffRef.current = true;
              onFile();
            }}
          >
            <FolderInput className="size-3.5" />
            {t("library.menu.move")}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        {/* No confirmation, deliberately: deleting a recording never had one —
            the toolbar's trash icon goes straight through — and inventing one
            here would make the same action behave differently depending on
            which way you reached it. */}
        <ContextMenuItem variant="destructive" disabled={busy} onSelect={onDelete}>
          <Trash2 className="size-3.5" />
          {isOrgContext ? t("library.menu.removeFromOrg") : t("library.menu.delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The list while it loads: rows in {@link LibraryCard}'s own shape — badge,
 *  title, date, snippet, the stats footer — under the same dividers, so the
 *  real list lands in place. `label` is announced, not shown. */
export function LibraryCardsSkeleton({ label }: Readonly<{ label: string }>) {
  return (
    <div className="flex flex-col divide-y divide-border" aria-busy="true">
      <output className="sr-only">
        {label}
      </output>
      {["w-3/5", "w-2/5", "w-1/2", "w-2/3", "w-1/3"].map((w) => (
        <div key={w} className="flex flex-col gap-2 px-2 py-3" aria-hidden="true">
          <Skeleton className="h-[19px] w-14 rounded-full" />
          <Skeleton className={`my-0.5 h-4 ${w}`} />
          <Skeleton className="my-0.5 h-3 w-28" />
          <Skeleton className="my-0.5 h-3 w-4/5" />
          <div className="flex items-center gap-3 pt-1">
            {["w-10", "w-6", "w-14"].map((m) => (
              <Skeleton key={m} className={`h-3 ${m}`} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
