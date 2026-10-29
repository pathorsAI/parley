import { useMemo, useRef, useState } from "react";
import {
  AudioLines,
  Check,
  Clock,
  Folder,
  FolderClosed,
  FolderInput,
  Loader2,
  Mic,
  Pencil,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { useI18n } from "../../i18n";
import { Skeleton } from "@/components/ui/skeleton";
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
import { groupByDate, type TimelineBucket } from "../../lib/library/timeline";
import { CardActions, cardCapabilities, formatDuration, SyncIcon } from "./LibraryCards";
import type { HistoryCardItem } from "../../lib/cloud/sync";
import type { Folder as LocalFolder } from "../../lib/history/folders";
import type { CloudOrg } from "../../lib/cloud/types";

/**
 * Every library list — 所有錄音, a folder, 還沒歸檔, an archived folder and an
 * org's shared recordings — as one calendar of rows, newest first.
 *
 * It began as the all-recordings view only (issue #330), beside a card grid for
 * the folder nodes. The v2 board draws the same rows for every scope, and one
 * shape means one place for the actions: open, rename, file, delete, each on
 * the row and again on its right-click menu. Rows are read down a column, the
 * sticky date headers give the eye somewhere to stop, and roughly twice as many
 * recordings fit on screen as cards did.
 */
export function RecordingTimeline({
  entries,
  locale,
  signedIn,
  isOrgContext,
  orgs,
  busyId,
  downloadingId,
  sharingId,
  folders,
  folderNames,
  onOpen,
  onDelete,
  onRename,
  onFile,
}: Readonly<{
  entries: HistoryCardItem[];
  locale: string;
  signedIn: boolean;
  /** An org's shared list: no folder chip, no sync badge, delete means remove. */
  isOrgContext: boolean;
  orgs: CloudOrg[];
  busyId: string | null;
  downloadingId: string | null;
  sharingId: string | null;
  /** Where a row can be filed — the scope's folders, archived ones left out. */
  folders: LocalFolder[];
  /** Every personal folder, archived included — what names a row's chip. */
  folderNames: LocalFolder[];
  onOpen: (entry: HistoryCardItem) => void;
  onDelete: (entry: HistoryCardItem) => void;
  onRename: (id: string, title: string) => void;
  /** Open the destination sheet for a row. */
  onFile: (entry: HistoryCardItem) => void;
}>) {
  const { t } = useI18n();
  // Grouped against the render's own clock. Recomputing when the list changes is
  // enough: a recording landing is what moves the "今天" boundary in practice,
  // and re-bucketing on a timer would reshuffle the page under the user.
  const groups = useMemo(() => groupByDate(entries, Date.now()), [entries]);
  const folderName = (id: string | null | undefined) =>
    id ? folderNames.find((f) => f.id === id)?.name : undefined;

  return (
    <div className="flex flex-col">
      {groups.map((group) => (
        <section key={group.key} className="flex flex-col">
          {/* Sticky so the band you are reading keeps saying which one it is. */}
          <h2 className="sticky top-0 z-10 bg-background/95 py-1.5 text-[11px] font-semibold text-muted-foreground backdrop-blur">
            {groupLabel(group.bucket, locale, t)}
          </h2>
          {group.items.map((entry) => (
            <TimelineRow
              key={entry.id}
              entry={entry}
              bucket={group.bucket}
              locale={locale}
              signedIn={signedIn}
              isOrgContext={isOrgContext}
              canShare={!isOrgContext && signedIn && orgs.length > 0}
              folders={folders}
              folderLabel={folderName(entry.folderId)}
              busy={busyId === entry.id}
              downloading={downloadingId === entry.id}
              sharing={sharingId === entry.id}
              onOpen={() => onOpen(entry)}
              onDelete={() => onDelete(entry)}
              onRename={(title) => onRename(entry.id, title)}
              onFile={() => onFile(entry)}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

/** The date band's heading: 今天 / 昨天 / 本週稍早, then one band per month,
 *  which drops the year while it is the current one. */
function groupLabel(
  bucket: TimelineBucket,
  locale: string,
  t: ReturnType<typeof useI18n>["t"]
): string {
  switch (bucket.kind) {
    case "today":
      return t("library.timeline.today");
    case "yesterday":
      return t("library.timeline.yesterday");
    case "thisWeek":
      return t("library.timeline.thisWeek");
    case "month": {
      // zh-TW spells it from the number (「10 月」); English wants the name.
      const vars = {
        month: bucket.month + 1,
        year: bucket.year,
        name: new Date(bucket.year, bucket.month, 1).toLocaleDateString(locale, { month: "long" }),
      };
      return bucket.year === new Date().getFullYear()
        ? t("library.timeline.month", vars)
        : t("library.timeline.monthYear", vars);
    }
  }
}

/**
 * The leading column, which says whatever its band leaves unsaid: inside 今天 or
 * 昨天 the day is already known, so the useful fact is the time; inside 本週稍早
 * it is the weekday; inside a month it is the date.
 */
function leadLabel(bucket: TimelineBucket, createdAt: number, locale: string): string {
  const d = new Date(createdAt);
  if (bucket.kind === "month") return d.toLocaleDateString(locale, { month: "numeric", day: "numeric" });
  if (bucket.kind === "thisWeek") return d.toLocaleDateString(locale, { weekday: "short" });
  return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
}

function TimelineRow({
  entry,
  bucket,
  locale,
  signedIn,
  isOrgContext,
  canShare,
  folders,
  folderLabel,
  busy,
  downloading,
  sharing,
  onOpen,
  onDelete,
  onRename,
  onFile,
}: Readonly<{
  entry: HistoryCardItem;
  bucket: TimelineBucket;
  locale: string;
  signedIn: boolean;
  isOrgContext: boolean;
  /** An org exists to file into. */
  canShare: boolean;
  folders: LocalFolder[];
  /** The folder this recording is filed in, or undefined for 還沒歸檔. */
  folderLabel: string | undefined;
  busy: boolean;
  downloading: boolean;
  sharing: boolean;
  onOpen: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
  onFile: () => void;
}>) {
  const { t } = useI18n();
  const isCloudOnly = !isOrgContext && entry.sync === "cloud";
  const { canMove, canRename } = cardCapabilities({
    isOrgContext,
    isCloudOnly,
    folderCount: folders.length,
  });
  const canFile = canMove || canShare;
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

  const stats = (
    <span className="flex shrink-0 items-center gap-3 text-[11px] tabular-nums text-muted-foreground">
      <span
        className="inline-flex items-center gap-1"
        title={t("history.speakers", { count: entry.speakerCount })}
      >
        <Users className="size-3" />
        {entry.speakerCount}
      </span>
      <span className="inline-flex items-center gap-1 tabular-nums">
        <Clock className="size-3" />
        {formatDuration(entry.durationMs)}
      </span>
      {!isOrgContext && <SyncIcon sync={entry.sync} signedIn={signedIn} />}
    </span>
  );

  const row = (
    // Rows are split by hairlines, not boxed.
    <div className="group relative flex min-h-9 items-center gap-2.5 border-b border-border px-2 py-2 transition-colors last:border-b-0 hover:bg-muted/60">
      <span
        className="w-11 shrink-0 text-[11px] tabular-nums text-muted-foreground"
        title={new Date(entry.createdAt).toLocaleString(locale)}
      >
        {leadLabel(bucket, entry.createdAt, locale)}
      </span>
      <span
        className="shrink-0 text-muted-foreground/70"
        title={entry.source === "live" ? t("history.badge.live") : t("history.badge.upload")}
      >
        {entry.source === "live" ? <Mic className="size-3" /> : <Upload className="size-3" />}
      </span>

      {editing ? (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <input
            ref={inputRef}
            // Right-clicking a text field has to reach the webview's own edit
            // menu; without this the row's menu swallows cut/copy/paste.
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
            className="min-w-0 flex-1 rounded border bg-background px-1.5 py-0.5 text-sm outline-none focus:border-primary"
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
        <button
          ref={openRef}
          type="button"
          onClick={onOpen}
          // The row's main focusable element, so it is where a keyboard user is
          // standing when they ask for the menu; the event bubbles to the trigger.
          onKeyDown={openMenuFromKeyboard}
          className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            isCloudOnly ? "opacity-70" : ""
          }`}
        >
          <span className="min-w-0 truncate text-sm font-medium">{entry.title}</span>
          {/* Solid when filed, dashed while it is still waiting for a folder.
              An org list has no personal folders to name. */}
          {!isOrgContext && (
            <span
              className={`hidden h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-[10px] text-muted-foreground sm:inline-flex ${
                folderLabel ? "" : "border-dashed border-muted-foreground/30"
              }`}
            >
              {folderLabel ? <Folder className="size-2.5" /> : <FolderClosed className="size-2.5" />}
              {folderLabel ?? t("library.unassigned")}
            </span>
          )}
          {/* Eats the slack so the stats stay pinned to the right edge. */}
          <span className="min-w-0 flex-1" />
        </button>
      )}

      {downloading ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {t("history.sync.downloading")}
        </span>
      ) : (
        stats
      )}

      {!editing && (
        <CardActions
          className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100"
          showFile={false}
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

      {/* Filing stays on screen: putting a recording where it belongs is what
          these lists are for. Rename and delete wait for hover. */}
      {canFile && (
        <button
          type="button"
          aria-label={t("library.menu.move")}
          title={t("library.menu.move")}
          disabled={sharing}
          onClick={(ev) => {
            ev.stopPropagation();
            onFile();
          }}
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          {sharing ? <Loader2 className="size-3.5 animate-spin" /> : <FolderInput className="size-3.5" />}
        </button>
      )}
    </div>
  );

  // A second way to reach the row's own actions, not a second set of them — one
  // that does not depend on noticing icons that only appear on hover, and that a
  // keyboard can summon at all.
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
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
        {canFile && (
          <ContextMenuItem
            onSelect={() => {
              // The sheet takes focus; don't pull it back to the row.
              handingOffRef.current = true;
              onFile();
            }}
          >
            <FolderInput className="size-3.5" />
            {t("library.menu.move")}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        {/* Same path as the trash button: both go through the library's one
            delete dialog. */}
        <ContextMenuItem variant="destructive" disabled={busy} onSelect={onDelete}>
          <Trash2 className="size-3.5" />
          {isOrgContext ? t("library.menu.removeFromOrg") : t("library.menu.delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The list while it loads: one date band of rows in {@link TimelineRow}'s
 *  shape — lead time, source icon, title, stats — so the real bands land in
 *  place. `label` is announced, not shown. */
export function RecordingTimelineSkeleton({ label }: Readonly<{ label: string }>) {
  return (
    <div className="flex flex-col" aria-busy="true">
      <output className="sr-only">
        {label}
      </output>
      <div className="flex h-[28.5px] items-center" aria-hidden="true">
        <Skeleton className="h-3 w-12" />
      </div>
      {["w-2/5", "w-1/2", "w-1/3", "w-3/5", "w-2/5 sm:w-1/4", "w-1/2 sm:w-2/5"].map((w) => (
        <div
          key={w}
          className="flex h-9 items-center gap-2.5 border-b border-border px-2 last:border-b-0"
          aria-hidden="true"
        >
          <Skeleton className="h-3 w-11 shrink-0" />
          <Skeleton className="size-3 shrink-0 rounded-full" />
          <Skeleton className={`h-3.5 ${w}`} />
          <span className="min-w-0 flex-1" />
          <Skeleton className="h-3 w-20 shrink-0" />
        </div>
      ))}
    </div>
  );
}
