import { useState } from "react";
import { Building2, FolderClosed } from "lucide-react";
import { useStore } from "../lib/store";
import { useAccounts } from "../lib/accounts/store";
import { useI18n } from "../i18n";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { MeetingLinkPicker } from "./accounts/MeetingLinkPicker";

/**
 * The loaded recording's CUSTOMER, right in the replay titlebar — the
 * "臨時開會、事後歸位" affordance.
 *
 * This used to be a folder chip, and that was the bug: it moved the recording
 * between folders without touching its company link, so one click here could
 * put a call in 和運租車's tree node while 和運租車's own page went on not
 * knowing about it. It now opens the SAME picker the study report's link bar
 * opens (MeetingLinkPicker → persistEntryLink), so there is exactly one control
 * deciding who a recording belongs to, reachable from two places.
 *
 * Personal recordings only: an unsaved upload or a read-only org recording has
 * no loadedHistoryId (or can't be written back) and renders nothing.
 */
export function ReplayOwnerChip() {
  const { t } = useI18n();
  const loadedHistoryId = useStore((s) => s.loadedHistoryId);
  const readOnly = useStore((s) => s.replayReadOnly);
  const companyId = useStore((s) => s.meetingCompanyId);
  const companies = useAccounts((s) => s.companies);
  const [open, setOpen] = useState(false);

  if (!loadedHistoryId || readOnly) return null;

  const company = companies.find((c) => c.id === companyId) ?? null;

  return (
    <>
      <button
        type="button"
        title={t("owner.assign")}
        onClick={() => setOpen(true)}
        className={`flex max-w-36 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-[11px] transition-colors hover:bg-muted ${
          company
            ? "text-muted-foreground hover:text-foreground"
            : "text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
        }`}
      >
        {company ? (
          <Building2 className="size-3 shrink-0" />
        ) : (
          <FolderClosed className="size-3 shrink-0" />
        )}
        <span className="truncate">{company ? company.name : t("owner.unassigned")}</span>
      </button>

      {/* Edit flow → Sheet (repo rule). The picker self-persists onto the
          loaded entry, so "done" is just closing. */}
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
            <MeetingLinkPicker />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
