import { useEffect, useState } from "react";
import { CalendarClock, Folder, Plus } from "lucide-react";
import { toast } from "sonner";
import { useStore } from "../../lib/store";
import { sortDrafts, type MeetingDraft } from "../../lib/store/prep";
import { beginMeeting } from "../../lib/meeting/start";
import { startOfDay, untilStart } from "../../lib/meeting/timeSlots";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";

/** The row's lead column: 16:00 today, 10/31 another day, 未定 without a time. */
function leadLabel(d: MeetingDraft, now: number, locale: string, t: ReturnType<typeof useI18n>["t"]): string {
  if (d.meetingAt == null) return t("home.upcoming.unscheduled");
  if (startOfDay(d.meetingAt) === startOfDay(now)) {
    return new Date(d.meetingAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return new Date(d.meetingAt).toLocaleDateString(locale, { month: "numeric", day: "numeric" });
}

/** Record a saved draft: it becomes the prep, then the meeting starts. */
function startDraft(id: string) {
  if (!useStore.getState().takeDraft(id)) return;
  beginMeeting().catch((e) => {
    log.error("home: start from draft failed", { error: String(e) });
    toast.error(String(e instanceof Error ? e.message : e));
  });
}

/**
 * 總覽's 即將開始: every saved meeting draft, soonest first — when, what,
 * which folder, how soon — each one click from editing or recording. Always
 * shown, so the place to find a prepared meeting is never a guess.
 */
export function UpcomingMeetings({
  folderName,
  style,
}: Readonly<{ folderName: (id: string | null) => string | undefined; style?: React.CSSProperties }>) {
  const { t, language } = useI18n();
  const drafts = useStore((s) => s.drafts);
  const [now, setNow] = useState(() => Date.now());
  const locale = language === "en" ? "en-US" : "zh-TW";

  // "in 25 min" keeps itself current.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const rows = sortDrafts(drafts);

  return (
    <section className="animate-fade-up flex flex-col gap-1.5" style={style}>
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-semibold text-muted-foreground">{t("home.upcoming.title")}</h2>
        {rows.length > 0 && <span className="text-[11px] tabular-nums text-muted-foreground">{rows.length}</span>}
        <button
          type="button"
          onClick={() => useStore.getState().setDraftOpen(true)}
          className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded px-1 text-xs text-primary transition-colors hover:text-primary/80"
        >
          <Plus className="size-3" />
          {t("home.newDraft")}
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-5 text-center text-xs text-muted-foreground">
          {t("home.upcoming.empty")}
        </p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((d) => {
            const until = d.meetingAt == null ? null : untilStart(d.meetingAt, now);
            const soon =
              until == null
                ? null
                : until.unit === "started"
                  ? t("home.upcoming.started")
                  : t(`home.upcoming.in.${until.unit}`, { n: String(until.value) });
            const folder = folderName(d.meetingFolderId);
            return (
              <li key={d.id} className="flex min-h-11 items-center gap-2.5 border-b px-2 py-1.5">
                <span className="w-11 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {leadLabel(d, now, locale, t)}
                </span>
                <CalendarClock className="size-3.5 shrink-0 text-muted-foreground/70" />
                <button
                  type="button"
                  title={t("home.upcoming.edit")}
                  onClick={() => useStore.getState().editDraft(d.id)}
                  className="min-w-0 cursor-pointer truncate text-left text-sm font-medium text-foreground hover:underline"
                >
                  {d.title || t("floating.untitled")}
                </button>
                {folder && (
                  <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-[10px] text-muted-foreground">
                    <Folder className="size-2.5" />
                    {folder}
                  </span>
                )}
                {soon && <span className="shrink-0 text-[11px] text-muted-foreground">{soon}</span>}
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => startDraft(d.id)}
                  className="h-7 shrink-0 cursor-pointer rounded-lg border bg-background px-2.5 text-xs font-medium transition-colors hover:bg-muted"
                >
                  {t("home.upcoming.start")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
