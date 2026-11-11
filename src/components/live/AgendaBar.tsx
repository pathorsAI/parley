import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, ChevronDown, Square } from "lucide-react";
import { useStore, formatClock } from "../../lib/store";
import { toggleMeetingTodo } from "../../lib/meeting/meetingWindow";
import { agendaCount, agendaProgress, agendaReminderDue } from "../../lib/meeting/agenda";
import { useI18n } from "../../i18n";
import type { TodoItem } from "../../lib/types";

/** How often the end-of-meeting reminder looks at the clock. */
const REMINDER_TICK_MS = 15_000;

/**
 * The floating meeting window's agenda (the draft's `todos`), between the title
 * bar and the tabs, so the meeting's progress shows on every tab. One line by
 * default — 議程 2/3, a thin bar, and the next item still open; a click opens
 * the checklist, where each item can be ticked or unticked and an AI tick's
 * 「AI · mm:ss」 tag jumps to the transcript line that covered it (`onJump`).
 * Renders nothing for a meeting without an agenda.
 */
export function AgendaBar({ onJump }: Readonly<{ onJump: (ms: number) => void }>) {
  const { t } = useI18n();
  const todos = useStore((s) => s.todos);
  const [open, setOpen] = useState(false);
  if (todos.length === 0) return null;
  const p = agendaProgress(todos);

  return (
    <div className="mx-5 mt-4 shrink-0 rounded-lg border bg-background">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-full min-w-0 items-center gap-2.5 px-3 text-left"
      >
        <span className="shrink-0 text-xs font-semibold text-foreground">
          {t("agenda.label")} <span className="tabular-nums">{agendaCount(p)}</span>
        </span>
        <span aria-hidden className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-muted">
          <span className="block h-full rounded-full bg-primary" style={{ width: `${p.fraction * 100}%` }} />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {p.next ? t("agenda.next", { item: p.next.text }) : t("agenda.allDone")}
        </span>
        <ChevronDown
          aria-hidden
          className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto border-t px-1.5 py-1.5">
          {todos.map((item) => (
            <AgendaRow key={item.id} item={item} next={item.id === p.next?.id} onJump={onJump} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One checklist row: the tick, the text (muted and struck through once done,
 *  tinted while it is the next one), and the AI's time tag. */
function AgendaRow({
  item,
  next,
  onJump,
}: Readonly<{ item: TodoItem; next: boolean; onJump: (ms: number) => void }>) {
  const { t } = useI18n();
  const at = item.doneBy === "ai" ? item.doneAtMs : undefined;
  return (
    <li className={`flex items-start gap-2 rounded-md px-1.5 py-1 ${next ? "bg-primary/5" : ""}`}>
      <button
        type="button"
        aria-label={item.done ? t("agenda.untick") : t("agenda.tick")}
        aria-pressed={item.done}
        onClick={() => toggleMeetingTodo(item.id)}
        className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
      >
        {item.done ? <Check className="size-4 text-success-foreground" /> : <Square className="size-4" />}
      </button>
      <span className={`min-w-0 flex-1 text-sm leading-snug ${rowTextTone(item.done, next)}`}>{item.text}</span>
      {item.doneBy === "ai" && <AiTag at={at} onJump={onJump} />}
    </li>
  );
}

function rowTextTone(done: boolean, next: boolean): string {
  if (done) return "text-muted-foreground line-through";
  return next ? "font-medium text-primary" : "text-foreground";
}

/** 「AI · 03:12」: the AI ticked it, here. Clickable when it named a line. */
function AiTag({ at, onJump }: Readonly<{ at: number | undefined; onJump: (ms: number) => void }>) {
  const { t } = useI18n();
  const cls = "mt-0.5 shrink-0 rounded px-1.5 py-px text-[11px] tabular-nums text-muted-foreground";
  if (at == null) return <span className={`${cls} bg-muted`}>{t("agenda.aiTag")}</span>;
  return (
    <button
      type="button"
      title={t("agenda.jump")}
      onClick={() => onJump(at)}
      className={`${cls} bg-muted transition-colors hover:bg-primary/10 hover:text-primary`}
    >
      {t("agenda.aiTagAt", { time: formatClock(at) })}
    </button>
  );
}

/** The mini window's agenda: just the count, beside the clock. */
export function MiniAgendaCount() {
  const { t } = useI18n();
  const todos = useStore((s) => s.todos);
  if (todos.length === 0) return null;
  return (
    <span
      title={t("agenda.label")}
      className="pointer-events-none shrink-0 rounded-md bg-muted/50 px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground"
    >
      {agendaCount(agendaProgress(todos))}
    </span>
  );
}

/**
 * Five minutes before the drafted end, with items still open: one toast naming
 * how many and the first. Once per meeting (by liveMeetingId), never without an
 * end time. Mounted for the whole meeting window, mini or full.
 */
export function useAgendaEndReminder(): void {
  const { t } = useI18n();
  const meetingId = useStore((s) => s.liveMeetingId);
  const endAt = useStore((s) => s.meetingEndAt);
  // Survives the effect re-running (a language change): still once per meeting.
  const shownFor = useRef<string | null>(null);
  // When this window first saw each meeting: the meeting window opens as the
  // meeting starts, so this is its start (see agendaReminderDue).
  const seen = useRef<{ id: string; at: number } | null>(null);

  useEffect(() => {
    if (!meetingId || endAt == null) return;
    if (seen.current?.id !== meetingId) seen.current = { id: meetingId, at: Date.now() };
    const startedAt = seen.current.at;
    const check = () => {
      const { todos } = useStore.getState();
      const alreadyShown = shownFor.current === meetingId;
      if (!agendaReminderDue({ now: Date.now(), meetingEndAt: endAt, todos, alreadyShown, startedAt })) {
        return;
      }
      shownFor.current = meetingId;
      const open = todos.filter((x) => !x.done);
      const key = open.length === 1 ? "agenda.remind.one" : "agenda.remind.other";
      toast(t(key, { n: String(open.length), item: open[0].text }));
    };
    check();
    const timer = setInterval(check, REMINDER_TICK_MS);
    return () => clearInterval(timer);
  }, [meetingId, endAt, t]);
}
