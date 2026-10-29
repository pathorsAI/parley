import { BellRing, Mic, X } from "lucide-react";
import { isMeetingActive, useStore } from "../lib/store";
import { beginMeeting } from "../lib/meeting/start";
import { reminderHeadline, useReminderDue } from "../lib/meeting/reminder";
import { useI18n } from "../i18n";
import { Button } from "@/components/ui/button";

/** 14:30 — the drafted meeting's start, in the user's clock. */
function clockLabel(ms: number, locale: string): string {
  return new Date(ms).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

/**
 * The reminder, inside the app: what the system notification points back to.
 * Start records with the draft's prepared context; 查看草稿 opens it first.
 */
export function MeetingReminderCard() {
  const { t } = useI18n();
  const dueAt = useReminderDue((s) => s.dueAt);
  const dismiss = useReminderDue((s) => s.dismiss);
  const title = useStore((s) => s.meetingTitle);
  const language = useStore((s) => s.settings.language);
  const setDraftOpen = useStore((s) => s.setDraftOpen);
  const busy = useStore((s) => isMeetingActive(s.meetingStatus) || s.isFinalizingMeeting);

  if (dueAt == null || busy) return null;
  const minutes = Math.max(0, Math.round((dueAt - Date.now()) / 60_000));

  return (
    <div
      role="alertdialog"
      aria-label={t("reminder.label")}
      className="fixed right-4 bottom-4 z-[80] flex w-80 flex-col gap-3 rounded-xl border bg-background p-4 shadow-xl"
    >
      <div className="flex items-start gap-2.5">
        <BellRing className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-semibold text-foreground">{reminderHeadline(language, title, minutes)}</span>
          <span className="text-xs text-muted-foreground">
            {t("reminder.at", { time: clockLabel(dueAt, language === "en" ? "en-US" : "zh-TW") })}
          </span>
        </div>
        <button
          type="button"
          aria-label={t("reminder.later")}
          onClick={dismiss}
          className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          onClick={() => {
            dismiss();
            setDraftOpen(true);
          }}
        >
          {t("reminder.openDraft")}
        </Button>
        <Button
          size="sm"
          className="h-8"
          onClick={() => {
            dismiss();
            void beginMeeting();
          }}
        >
          <Mic className="size-3.5" />
          {t("draft.start")}
        </Button>
      </div>
    </div>
  );
}
