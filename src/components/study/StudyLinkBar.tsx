import { useState } from "react";
import { Building2, MoreHorizontal } from "lucide-react";
import { useStore } from "../../lib/store";
import { useAccounts, threadsOf } from "../../lib/accounts/store";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MeetingLinkPicker } from "../accounts/MeetingLinkPicker";
import { MeetingContextSheet } from "../MeetingContextButton";

/**
 * The report page's link bar: a recording saved without a company link could
 * never reach the post-meeting review (its titlebar button only shows when
 * linked), with nothing explaining why — this row is the after-the-fact link
 * point, plus the study-side door into the meeting-context editor. Read-only
 * org recordings can't be written back, so they get no link affordances.
 */
export function StudyLinkBar() {
  const { t } = useI18n();
  const readOnly = useStore((s) => s.replayReadOnly);
  const companyId = useStore((s) => s.meetingCompanyId);
  const threadId = useStore((s) => s.meetingThreadId);
  const acc = useAccounts();
  const company = acc.companies.find((c) => c.id === companyId) ?? null;
  // All statuses, not just active: the chip must still name a since-closed thread.
  const thread = company ? threadsOf(acc, company.id).find((x) => x.id === threadId) ?? null : null;

  const [pickerOpen, setPickerOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);

  return (
    <div className="mb-6 flex items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2">
      <Building2 className="size-4 shrink-0 text-muted-foreground" />
      {company ? (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <span className="max-w-full truncate rounded-full border bg-background px-2 py-0.5 text-xs font-medium">
            {company.name}
          </span>
          {thread && (
            <span className="max-w-full truncate rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
              {thread.name}
            </span>
          )}
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

      {/* Edit flow → Sheet (repo rule). The picker self-persists onto the
          loaded entry, so "done" is just closing. */}
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
            <MeetingLinkPicker />
          </div>
        </SheetContent>
      </Sheet>

      <MeetingContextSheet open={contextOpen} onOpenChange={setContextOpen} />
    </div>
  );
}
