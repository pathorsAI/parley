import { useState } from "react";
import { FileText } from "lucide-react";
import { useStore } from "../lib/store";
import { useI18n } from "../i18n";
import { Button } from "@/components/ui/button";
import { MeetingContextDialog } from "./MeetingContextDialog";
import { MeetingLinkSection } from "./accounts/MeetingLinkSection";

/**
 * Compact button that opens a dialog to edit the PER-MEETING context — background
 * specific to this conversation/recording (who's here, the deal, the direction we
 * want), distinct from the global self-profile in Settings. It feeds every
 * analysis prompt. Button form so the input isn't always taking up space; a dot
 * marks when context has been entered.
 */
export function MeetingContextButton({ className }: Readonly<{ className?: string }>) {
  const { t } = useI18n();
  const hasContext = useStore((s) => !!s.meetingContext.trim());
  const meetingType = useStore((s) => s.settings.meetingType);
  const businessType = meetingType === "sales" || meetingType === "negotiation" || meetingType === "partnership";
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground ${className ?? ""}`}
      >
        <FileText className="size-3.5" />
        {t("meeting.contextButton")}
        {hasContext && <span className="size-1.5 rounded-full bg-emerald-400" />}
      </button>
      {open && (
        <MeetingContextDialog
          onClose={() => setOpen(false)}
          closeLabel={t("common.done")}
          footer={
            <Button size="sm" className="h-8" onClick={() => setOpen(false)}>
              {t("common.done")}
            </Button>
          }
        >
          {businessType && <MeetingLinkSection />}
        </MeetingContextDialog>
      )}
    </>
  );
}
