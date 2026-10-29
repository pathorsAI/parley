import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useStore } from "../lib/store";
import {
  DEFAULT_DURATION_MIN,
  durationParts,
  endSlots,
  monthGrid,
  nextHalfHour,
  onDay,
  startOfDay,
  startSlots,
} from "../lib/meeting/timeSlots";
import { useI18n } from "../i18n";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const MIN = 60_000;
/** The picker lives in the draft sheet (z-[91]); a popover's default z-50
 *  opened underneath it, where nothing could be seen or clicked. Kept even
 *  now that the lists portal into the sheet, so they sit above its fields. */
const ABOVE_SHEET = "z-[95]";

const triggerClass =
  "flex h-8 items-center rounded-md px-2.5 text-sm text-foreground transition-colors hover:bg-muted data-[state=open]:bg-muted";

/** The UI language's locale for dates and times. */
function useLocale(): string {
  const language = useStore((s) => s.settings.language);
  return language === "en" ? "en-US" : "zh-TW";
}

/** 下午2:00 / 2:00 PM */
function timeLabel(ms: number, locale: string): string {
  return new Date(ms).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

/** A scrolling single-choice list of times, opened on the chosen one. */
function TimeList({
  slots,
  value,
  render,
  onPick,
}: Readonly<{ slots: number[]; value: number; render: (ms: number) => React.ReactNode; onPick: (ms: number) => void }>) {
  const chosen = useRef<HTMLButtonElement | null>(null);
  // Open on the chosen time, or the slot just before it when it falls
  // between slots — never back at midnight.
  const anchor = slots.reduce((best, ms) => (ms <= value ? ms : best), slots[0]);
  useEffect(() => {
    chosen.current?.scrollIntoView({ block: "center" });
  }, []);
  return (
    <div role="listbox" className="flex max-h-64 flex-col overflow-y-auto py-1">
      {slots.map((ms) => (
        <button
          key={ms}
          ref={ms === anchor ? chosen : undefined}
          type="button"
          role="option"
          aria-selected={ms === value}
          onClick={() => onPick(ms)}
          className={`px-3 py-1.5 text-left text-sm whitespace-nowrap transition-colors ${
            ms === value ? "bg-primary/10 font-medium text-primary" : "text-foreground hover:bg-muted"
          }`}
        >
          {render(ms)}
        </button>
      ))}
    </div>
  );
}

/** A month grid to pick the day from. */
function DayGrid({ value, onPick }: Readonly<{ value: number; onPick: (dayMs: number) => void }>) {
  const { t } = useI18n();
  const locale = useLocale();
  const [view, setView] = useState(() => {
    const d = new Date(value);
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const today = startOfDay(Date.now());
  const chosen = startOfDay(value);
  const weeks = monthGrid(view.year, view.month);
  const weekdays = weeks[0].map((ms) => new Date(ms).toLocaleDateString(locale, { weekday: "narrow" }));
  const step = (delta: number) =>
    setView((v) => {
      const d = new Date(v.year, v.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });

  return (
    <div className="flex w-64 flex-col gap-2 p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">
          {new Date(view.year, view.month, 1).toLocaleDateString(locale, { year: "numeric", month: "long" })}
        </span>
        <div className="flex gap-1">
          <button
            type="button"
            aria-label={t("draft.prevMonth")}
            onClick={() => step(-1)}
            className="grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-muted"
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            type="button"
            aria-label={t("draft.nextMonth")}
            onClick={() => step(1)}
            className="grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-muted"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 text-center text-[11px] text-muted-foreground">
        {weekdays.map((w, i) => (
          <span key={i}>{w}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-0.5 text-center">
        {weeks.flat().map((ms) => {
          const d = new Date(ms);
          const inMonth = d.getMonth() === view.month;
          const isChosen = ms === chosen;
          return (
            <button
              key={ms}
              type="button"
              onClick={() => onPick(ms)}
              className={`mx-auto grid size-8 place-items-center rounded-full text-xs transition-colors ${
                isChosen
                  ? "bg-primary text-primary-foreground"
                  : ms === today
                    ? "font-semibold text-primary hover:bg-muted"
                    : inMonth
                      ? "text-foreground hover:bg-muted"
                      : "text-muted-foreground/50 hover:bg-muted"
              }`}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The draft's when, as Google Calendar asks it: a day, then a start and an
 * end time from drop-down lists 15 minutes apart, the end list showing each
 * choice's length. Changing the start keeps the meeting's length.
 */
export function MeetingTimePicker() {
  const { t } = useI18n();
  const locale = useLocale();
  const startAt = useStore((s) => s.meetingAt);
  const endAtRaw = useStore((s) => s.meetingEndAt);
  const setStart = useStore((s) => s.setMeetingAt);
  const setEnd = useStore((s) => s.setMeetingEndAt);
  const [open, setOpen] = useState<"day" | "start" | "end" | null>(null);
  // The lists portal into the picker itself, i.e. into the sheet (see
  // PopoverContent's container).
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  if (startAt == null) return null;
  const endAt = endAtRaw != null && endAtRaw > startAt ? endAtRaw : startAt + DEFAULT_DURATION_MIN * MIN;
  const length = endAt - startAt;

  /** Move the start, carrying the end along so the length holds. */
  function moveStart(next: number) {
    setStart(next);
    setEnd(next + length);
    setOpen(null);
  }

  const duration = (ms: number) => {
    const p = durationParts(Math.round((ms - startAt) / MIN));
    return t(p.unit === "min" ? "draft.duration.min" : "draft.duration.hour", { n: p.value });
  };

  return (
    <div ref={setContainer} className="flex flex-wrap items-center gap-1 rounded-md border border-input bg-background p-0.5">
      <Popover open={open === "day"} onOpenChange={(o) => setOpen(o ? "day" : null)}>
        <PopoverTrigger className={triggerClass}>
          {new Date(startAt).toLocaleDateString(locale, { month: "long", day: "numeric", weekday: "short" })}
        </PopoverTrigger>
        <PopoverContent container={container} align="start" className={`${ABOVE_SHEET} w-auto p-0`}>
          <DayGrid value={startAt} onPick={(day) => moveStart(onDay(day, startAt))} />
        </PopoverContent>
      </Popover>
      <Popover open={open === "start"} onOpenChange={(o) => setOpen(o ? "start" : null)}>
        <PopoverTrigger className={triggerClass} aria-label={t("draft.startTime")}>
          {timeLabel(startAt, locale)}
        </PopoverTrigger>
        <PopoverContent container={container} align="start" className={`${ABOVE_SHEET} w-36 p-0`}>
          <TimeList
            slots={startSlots(startAt)}
            value={startAt}
            render={(ms) => timeLabel(ms, locale)}
            onPick={moveStart}
          />
        </PopoverContent>
      </Popover>
      <span className="text-sm text-muted-foreground">–</span>
      <Popover open={open === "end"} onOpenChange={(o) => setOpen(o ? "end" : null)}>
        <PopoverTrigger className={triggerClass} aria-label={t("draft.endTime")}>
          {timeLabel(endAt, locale)}
        </PopoverTrigger>
        <PopoverContent container={container} align="start" className={`${ABOVE_SHEET} w-48 p-0`}>
          <TimeList
            slots={endSlots(startAt)}
            value={endAt}
            render={(ms) => (
              <>
                {timeLabel(ms, locale)} <span className="text-muted-foreground">({duration(ms)})</span>
              </>
            )}
            onPick={(ms) => {
              setEnd(ms);
              setOpen(null);
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** A new draft's default time: the next half hour, one hour long. */
export function defaultMeetingTime(now = Date.now()): { start: number; end: number } {
  const start = nextHalfHour(now);
  return { start, end: start + DEFAULT_DURATION_MIN * MIN };
}
