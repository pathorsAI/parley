import { useMemo, useRef, useState } from "react";
import {
  Check,
  Clock,
  Folder,
  FolderClosed,
  ListChecks,
  Loader2,
  Mic,
  Upload,
  Users,
  Volume2,
} from "lucide-react";
import { useI18n } from "../../i18n";
import { groupByDate, type TimelineBucket } from "../../lib/library/timeline";
import { CardActions, formatDuration, SyncIcon } from "./LibraryCards";
import type { HistoryCardItem } from "../../lib/cloud/sync";
import type { Folder as LocalFolder } from "../../lib/history/folders";
import type { CloudOrg } from "../../lib/cloud/types";

/**
 * The all-recordings view (issue #330): every personal recording down one
 * calendar, newest first.
 *
 * Deliberately NOT the card grid the folder nodes use. A folder answers "what is
 * in here", and a card — title, snippet, four stats — is the right shape for it.
 * This node answers "what did I sit through lately", which is a scanning
 * question: rows are read down a column, the date headers give the eye somewhere
 * to stop, and roughly twice as many recordings fit on screen. The two live side
 * by side on purpose; nothing about the folder grid changes.
 */
export function RecordingTimeline({
  entries,
  locale,
  signedIn,
  orgs,
  orgFolders,
  busyId,
  downloadingId,
  sharingId,
  folders,
  onOpen,
  onDelete,
  onRename,
  onShare,
  onMove,
}: Readonly<{
  entries: HistoryCardItem[];
  locale: string;
  signedIn: boolean;
  orgs: CloudOrg[];
  orgFolders: Record<string, LocalFolder[]>;
  busyId: string | null;
  downloadingId: string | null;
  sharingId: string | null;
  /** The personal folders — what names a row's folder chip. */
  folders: LocalFolder[];
  onOpen: (entry: HistoryCardItem) => void;
  onDelete: (entry: HistoryCardItem) => void;
  onRename: (id: string, title: string) => void;
  onShare: (entry: HistoryCardItem, org: CloudOrg, folderId: string | null) => void;
  onMove: (entry: HistoryCardItem, folderId: string | null) => void;
}>) {
  const { t } = useI18n();
  // Grouped against the render's own clock. Recomputing when the list changes is
  // enough: a recording landing is what moves the "今天" boundary in practice,
  // and re-bucketing on a timer would reshuffle the page under the user.
  const groups = useMemo(() => groupByDate(entries, Date.now()), [entries]);
  const folderName = (id: string | null | undefined) =>
    id ? folders.find((f) => f.id === id)?.name : undefined;

  return (
    <div className="flex flex-col">
      {groups.map((group) => (
        <section key={group.key} className="flex flex-col">
          {/* Sticky so the band you are reading keeps saying which one it is. */}
          <h2 className="sticky top-0 z-10 bg-background/95 py-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground backdrop-blur">
            {groupLabel(group.bucket, locale, t)}
          </h2>
          {group.items.map((entry) => (
            <TimelineRow
              key={entry.id}
              entry={entry}
              bucket={group.bucket}
              locale={locale}
              signedIn={signedIn}
              orgs={orgs}
              orgFolders={orgFolders}
              folders={folders}
              folderLabel={folderName(entry.folderId)}
              busy={busyId === entry.id}
              downloading={downloadingId === entry.id}
              sharing={sharingId === entry.id}
              onOpen={() => onOpen(entry)}
              onDelete={() => onDelete(entry)}
              onRename={(title) => onRename(entry.id, title)}
              onShare={(org, folderId) => onShare(entry, org, folderId)}
              onMove={(folderId) => onMove(entry, folderId)}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

/** The date band's heading. Months drop the year while it is the current one. */
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
      const sameYear = bucket.year === new Date().getFullYear();
      return new Date(bucket.year, bucket.month, 1).toLocaleDateString(
        locale,
        sameYear ? { month: "long" } : { year: "numeric", month: "long" }
      );
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
  orgs,
  orgFolders,
  folders,
  folderLabel,
  busy,
  downloading,
  sharing,
  onOpen,
  onDelete,
  onRename,
  onShare,
  onMove,
}: Readonly<{
  entry: HistoryCardItem;
  bucket: TimelineBucket;
  locale: string;
  signedIn: boolean;
  orgs: CloudOrg[];
  orgFolders: Record<string, LocalFolder[]>;
  folders: LocalFolder[];
  /** The folder this recording is filed in, or undefined for 還沒歸檔. */
  folderLabel: string | undefined;
  busy: boolean;
  downloading: boolean;
  sharing: boolean;
  onOpen: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
  onShare: (org: CloudOrg, folderId: string | null) => void;
  onMove: (folderId: string | null) => void;
}>) {
  const { t } = useI18n();
  const isCloudOnly = entry.sync === "cloud";
  const canShare = signedIn && orgs.length > 0;
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

  const stats = (
    <span className="flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground">
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
      {typeof entry.actionItemsCount === "number" && entry.actionItemsCount > 0 && (
        <span
          className="inline-flex items-center gap-1"
          title={t("history.actions", { count: entry.actionItemsCount })}
        >
          <ListChecks className="size-3" />
          {entry.actionItemsCount}
        </span>
      )}
      {entry.hasAudio && (
        <span className="inline-flex" title={t("history.hasAudio")}>
          <Volume2 className="size-3" />
        </span>
      )}
      <SyncIcon sync={entry.sync} signedIn={signedIn} />
    </span>
  );

  return (
    <div className="group relative flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/60">
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
          type="button"
          onClick={onOpen}
          className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            isCloudOnly ? "opacity-70" : ""
          }`}
        >
          <span className="min-w-0 truncate text-sm font-medium">{entry.title}</span>
          <span
            className={`hidden shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground sm:inline-flex ${
              folderLabel ? "" : "border-dashed"
            }`}
          >
            {folderLabel ? <Folder className="size-2.5" /> : <FolderClosed className="size-2.5" />}
            {folderLabel ?? t("library.unassigned")}
          </span>
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
          entry={entry}
          className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100"
          isOrgContext={false}
          isCloudOnly={isCloudOnly}
          canShare={canShare}
          orgs={orgs}
          orgFolders={orgFolders}
          busy={busy}
          sharing={sharing}
          folders={folders}
          onDelete={onDelete}
          onRenameStart={startEdit}
          onShare={onShare}
          onMove={onMove}
        />
      )}
    </div>
  );
}
