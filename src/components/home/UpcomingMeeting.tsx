import { useEffect, useState } from "react";
import { CalendarClock, Mic, Pencil } from "lucide-react";
import { toast } from "sonner";
import { useStore } from "../../lib/store";
import { beginMeeting } from "../../lib/meeting/start";
import { untilStart } from "../../lib/meeting/timeSlots";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import { Button } from "@/components/ui/button";

/**
 * 總覽's 即將開始的會議: the saved meeting draft, with when it starts and how
 * soon, so the meeting you prepared is one click from recording. Shown while
 * the draft has a time or was saved.
 */
export function UpcomingMeeting({ style }: Readonly<{ style?: React.CSSProperties }>) {
  const { t, language } = useI18n();
  const startAt = useStore((s) => s.meetingAt);
  const endAt = useStore((s) => s.meetingEndAt);
  const saved = useStore((s) => s.draftSaved);
  const title = useStore((s) => s.meetingTitle);
  const context = useStore((s) => s.meetingContext);
  const todos = useStore((s) => s.todos.length);
  const [now, setNow] = useState(() => Date.now());

  // The "in 25 minutes" line keeps itself current.
  useEffect(() => {
    if (startAt == null) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [startAt]);

  if (startAt == null && !saved) return null;
  const locale = language === "en" ? "en-US" : "zh-TW";

  let when = t("home.upcoming.noTime");
  if (startAt != null) {
    const day = new Date(startAt).toLocaleDateString(locale, { month: "long", day: "numeric", weekday: "short" });
    const time = (ms: number) => new Date(ms).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
    const range = endAt != null && endAt > startAt ? `${time(startAt)} – ${time(endAt)}` : time(startAt);
    const until = untilStart(startAt, now);
    const soon =
      until.unit === "started"
        ? t("home.upcoming.started")
        : t(`home.upcoming.in.${until.unit}`, { n: String(until.value) });
    when = `${day} ${range} · ${soon}`;
  }

  return (
    <section className="animate-fade-up flex flex-col gap-1.5" style={style}>
      <h2 className="text-xs font-semibold text-muted-foreground">{t("home.upcoming.title")}</h2>
      <div className="flex items-start gap-3 rounded-xl border bg-background p-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <CalendarClock className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-semibold text-foreground">
            {title.trim() || t("floating.untitled")}
          </span>
          <span className="text-xs text-muted-foreground">{when}</span>
          {(context.trim() || todos > 0) && (
            <span className="mt-1 line-clamp-2 text-xs text-muted-foreground/90">
              {context.trim() || t("home.upcoming.agenda", { n: String(todos) })}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={() => useStore.getState().setDraftOpen(true)}
          >
            <Pencil className="size-3.5" />
            {t("home.upcoming.edit")}
          </Button>
          <Button
            size="sm"
            className="h-8"
            onClick={() =>
              beginMeeting().catch((e) => {
                log.error("home: start from draft failed", { error: String(e) });
                toast.error(String(e instanceof Error ? e.message : e));
              })
            }
          >
            <Mic className="size-3.5" />
            {t("draft.start")}
          </Button>
        </div>
      </div>
    </section>
  );
}
