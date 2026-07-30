import { useState } from "react";
import { FileText } from "lucide-react";
import { useStore } from "../lib/store";
import { useI18n } from "../i18n";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { MeetingContextField } from "./MeetingContextField";
import { MeetingLinkSection } from "./accounts/MeetingLinkSection";

/**
 * Amend the PER-MEETING context mid-call — background specific to this
 * conversation (who's here, the deal, the direction we want), distinct from the
 * global self-profile in Settings. It feeds every analysis prompt. A dot marks
 * when context has been entered.
 *
 * A side sheet, not a modal: this is edited WHILE the transcript runs, and the
 * transcript is half of what you're editing against.
 */
export function MeetingContextButton({ className }: Readonly<{ className?: string }>) {
  const { t } = useI18n();
  const hasContext = useStore((s) => !!s.meetingContext.trim());
  const meetingType = useStore((s) => s.settings.meetingType);
  // Scenario system: every scenario (builtin or custom) can link the mini-CRM;
  // only "general" (no board) stays personal.
  const businessType = meetingType !== "general";
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground ${className ?? ""}`}
      >
        <FileText className="size-3.5" />
        {t("meeting.contextButton")}
        {hasContext && <span className="size-1.5 rounded-full bg-emerald-400" />}
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          closeLabel={t("common.done")}
          title={t("meeting.contextButton")}
          footer={
            <Button size="sm" className="h-8" onClick={() => setOpen(false)}>
              {t("common.done")}
            </Button>
          }
        >
          <div className="px-4 py-3">
            {businessType && <MeetingLinkSection />}
            <MeetingContextField rows={5} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
