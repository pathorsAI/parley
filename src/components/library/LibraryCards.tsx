import {
  CloudCheck,
  CloudDownload,
  CloudOff,
  FolderInput,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useI18n } from "../../i18n";
import type { Folder as LocalFolder } from "../../lib/history/folders";
import type { HistorySyncState } from "../../lib/cloud/sync";

/**
 * The pieces a recording row is built from — its sync indicator, its action
 * toolbar and the rule for which actions it can offer. The card that used to
 * live here (lifted out of the old standalone History window, issue #195) is
 * gone: every library scope now renders the rows of RecordingTimeline.
 *
 * One thing never came along from that window: dragging a recording onto a
 * sidebar folder. The main window has Tauri's native drag-drop ON (it is how an
 * audio file is dropped into the ingest wizard), and that handler swallows the
 * webview's dragover/drop events. Every move a drag could do is on the row's
 * own 移到資料夾 button and menu.
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

/** Per-recording cloud-sync indicator. Hidden when signed out (sync not in use). */
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
 * Which of the four actions a given row can actually offer.
 *
 * Shared because a row exposes them twice — its buttons and the right-click
 * menu — and a rule that lived in only one of them would let the menu offer a
 * rename the toolbar already knows is impossible.
 */
export function cardCapabilities(
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
 * The hover toolbar: file, rename, delete. A row that keeps its 移到資料夾
 * button on screen at all times passes `showFile={false}` so the toolbar does
 * not offer it a second time.
 *
 * Filing is ONE button: a folder in Personal and a folder in an org are the
 * same question, answered in the destination sheet (#577). It used to be two
 * menus — move (personal folders) and share (orgs), then a copy-or-move dialog.
 */
export function CardActions({
  className = "absolute right-2 top-2 z-10 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100",
  showFile = true,
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
  /** Where the toolbar sits. Defaults to the top-right corner of its parent. */
  className?: string;
  /** Offer filing here; off when the row shows its own always-visible button. */
  showFile?: boolean;
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
      {showFile && (canMove || canShare) && (
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
