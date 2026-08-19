import { useState } from "react";
import { Folder, MoreHorizontal } from "lucide-react";
import { useStore } from "../../lib/store";
import { listLocalFolders } from "../../lib/history/folders";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DestinationPicker } from "../DestinationPicker";
import { useRefile } from "../useRefile";
import { personalDestination } from "../../lib/library/destination";
import { MeetingContextSheet } from "../MeetingContextButton";

/**
 * The report page's filing bar: a recording saved in a hurry lands in no folder
 * at all, and this is where it gets one after the fact — plus the study-side
 * door into the meeting-context editor. Read-only org recordings can't be
 * written back, so they get no filing affordances.
 */
export function StudyLinkBar() {
  const { t } = useI18n();
  const loadedHistoryId = useStore((s) => s.loadedHistoryId);
  // Nothing to re-file: a read-only org recording can't be written back, and a
  // session with no saved entry (never saved, or just handed over to an org)
  // has nothing for the picker to act on.
  const readOnly = useStore((s) => s.replayReadOnly) || !loadedHistoryId;
  const folderId = useStore((s) => s.replayFolderId);
  const refile = useRefile();
  const folder = folderId ? (listLocalFolders().find((f) => f.id === folderId) ?? null) : null;

  const [pickerOpen, setPickerOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);

  return (
    <div className="mb-6 flex items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2">
      <Folder className="size-4 shrink-0 text-muted-foreground" />
      {folder ? (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <span className="max-w-full truncate rounded-full border bg-background px-2 py-0.5 text-xs font-medium">
            {folder.name}
          </span>
          {!readOnly && (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="cursor-pointer text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              {t("study.link.change")}
            </button>
          )}
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 truncate text-sm text-muted-foreground">
            {t("study.link.unlinked")}
          </span>
          {!readOnly && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 text-xs"
              onClick={() => setPickerOpen(true)}
            >
              {t("study.link.attach")}
            </Button>
          )}
        </div>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t("study.link.menu")}
          className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setContextOpen(true)}>
            {t("study.link.context")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Edit flow → Sheet (repo rule). The move persists as it is picked, so
          "done" is just closing. */}
      <Sheet open={pickerOpen} onOpenChange={setPickerOpen}>
        <SheetContent
          title={t("study.link.attach")}
          closeLabel={t("common.close")}
          footer={
            <Button size="sm" className="h-8" onClick={() => setPickerOpen(false)}>
              {t("common.done")}
            </Button>
          }
        >
          <div className="px-4 py-3">
            <DestinationPicker value={personalDestination(folderId)} onChange={refile} />
          </div>
        </SheetContent>
      </Sheet>

      <MeetingContextSheet open={contextOpen} onOpenChange={setContextOpen} />
    </div>
  );
}
