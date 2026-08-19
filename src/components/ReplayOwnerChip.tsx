import { useState } from "react";
import { Folder, FolderClosed } from "lucide-react";
import { useStore } from "../lib/store";
import { listLocalFolders } from "../lib/history/folders";
import { useI18n } from "../i18n";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { DestinationPicker } from "./DestinationPicker";
import { useRefile } from "./useRefile";
import { personalDestination } from "../lib/library/destination";

/**
 * The loaded recording's FOLDER, right in the replay titlebar — the
 * "臨時開會、事後歸位" affordance. One folder is one customer, so this is also
 * the "whose call was this" control.
 *
 * Personal recordings only: an unsaved upload or a read-only org recording has
 * no loadedHistoryId (or can't be written back) and renders nothing.
 */
export function ReplayOwnerChip() {
  const { t } = useI18n();
  const loadedHistoryId = useStore((s) => s.loadedHistoryId);
  const readOnly = useStore((s) => s.replayReadOnly);
  const folderId = useStore((s) => s.replayFolderId);
  const [open, setOpen] = useState(false);
  const refile = useRefile();

  if (!loadedHistoryId || readOnly) return null;

  const folder = folderId ? (listLocalFolders().find((f) => f.id === folderId) ?? null) : null;

  return (
    <>
      <button
        type="button"
        title={t("owner.assign")}
        onClick={() => setOpen(true)}
        className={`flex max-w-36 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-[11px] transition-colors hover:bg-muted ${
          folder
            ? "text-muted-foreground hover:text-foreground"
            : "text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
        }`}
      >
        {folder ? (
          <Folder className="size-3 shrink-0" />
        ) : (
          <FolderClosed className="size-3 shrink-0" />
        )}
        <span className="truncate">{folder ? folder.name : t("owner.unassigned")}</span>
      </button>

      {/* Edit flow → Sheet (repo rule). The move persists as it is picked, so
          "done" is just closing. */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          title={t("owner.assign")}
          closeLabel={t("common.close")}
          footer={
            <Button size="sm" className="h-8" onClick={() => setOpen(false)}>
              {t("common.done")}
            </Button>
          }
        >
          <div className="px-4 py-3">
            <DestinationPicker value={personalDestination(folderId)} onChange={refile} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
