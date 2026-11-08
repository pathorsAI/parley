import { useEffect, useState } from "react";
import { CalendarClock, Folder } from "lucide-react";
import { toast } from "sonner";
import { isLiveMeetingActive, useStore } from "../../lib/store";
import { isOver, type MeetingDraft } from "../../lib/store/prep";
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
  // Refused while a meeting records; beginMeeting then says so and brings
  // that meeting's window up.
  if (!useStore.getState().takeDraft(id)) {
    if (isLiveMeetingActive()) void beginMeeting();
    return;
  }
  beginMeeting().catch((e) => {
    log.error("home: start from draft failed", { error: String(e) });
    toast.error(String(e instanceof Error ? e.message : e));
  });
}

/** The clock a draft list reads "in 25 min" off, kept current. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * One saved meeting draft in a list — when, what, which folder, how soon —
 * one click from editing (the title) or recording (開始). Shared by 總覽's
 * 即將開始 and an org's 會議草稿, so the two lists look and act the same.
 */
export function DraftRow({
  draft: d,
  now,
  folder,
}: Readonly<{ draft: MeetingDraft; now: number; folder?: string }>) {
  const { t, language } = useI18n();
  const locale = language === "en" ? "en-US" : "zh-TW";
  const until = d.meetingAt == null ? null : untilStart(d.meetingAt, now);
  // A draft is still a draft once its time comes: nothing has been recorded,
  // so the row never claims the meeting "started". Inside its slot it says the
  // start time has gone by (and 開始 is still the thing to press); once the
  // slot is over too, the draft has simply lapsed.
  let soon: string | null = null;
  let late = false;
  if (until) {
    if (until.unit !== "started") {
      soon = t(`home.upcoming.in.${until.unit}`, { n: String(until.value) });
    } else if (isOver(d, now)) {
      soon = t("home.upcoming.expired");
    } else {
      soon = t("home.upcoming.pastStart");
      late = true;
    }
  }
  return (
    <li className="flex min-h-11 items-center gap-2.5 border-b px-2 py-1.5">
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
      {soon && (
        <span className={`shrink-0 text-[11px] ${late ? "font-medium text-primary" : "text-muted-foreground"}`}>
          {soon}
        </span>
      )}
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
}
