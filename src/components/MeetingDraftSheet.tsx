import { Eraser, Mic, X } from "lucide-react";
import { isMeetingActive, useStore } from "../lib/store";
import { beginMeeting } from "../lib/meeting/start";
import { ensureNotificationPermission } from "../lib/meeting/reminder";
import { useI18n } from "../i18n";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { DestinationField } from "./DestinationSheet";
import { MeetingContextField } from "./MeetingContextField";
import { TodoAddForm, TodoRow } from "./sidebar/TodosPanel";
import { useMeetingDestination } from "./useMeetingDestination";

/** Lead times the draft offers, in minutes before the start. */
const LEAD_CHOICES = [0, 5, 10, 15, 30] as const;

/** epoch ms ⇄ the `datetime-local` input's local "YYYY-MM-DDTHH:mm". */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** The draft's name, start time and how long before it to be reminded. */
function MeetingWhenFields() {
  const { t } = useI18n();
  const title = useStore((s) => s.meetingTitle);
  const setTitle = useStore((s) => s.setMeetingTitle);
  const meetingAt = useStore((s) => s.meetingAt);
  const setMeetingAt = useStore((s) => s.setMeetingAt);
  const lead = useStore((s) => s.reminderLeadMin);
  const setLead = useStore((s) => s.setReminderLeadMin);

  function pickTime(value: string) {
    const at = fromLocalInput(value);
    setMeetingAt(at);
    // The first time a time is set is when asking makes sense.
    if (at != null) void ensureNotificationPermission();
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium">{t("floating.titleLabel")}</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("floating.untitled")}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium">{t("draft.when")}</span>
        <div className="flex items-center gap-2">
          <input
            type="datetime-local"
            aria-label={t("draft.when")}
            value={meetingAt == null ? "" : toLocalInput(meetingAt)}
            onChange={(e) => pickTime(e.target.value)}
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          {meetingAt != null && (
            <button
              type="button"
              aria-label={t("draft.whenClear")}
              title={t("draft.whenClear")}
              onClick={() => setMeetingAt(null)}
              className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        {meetingAt != null && (
          <select
            aria-label={t("draft.lead")}
            value={lead}
            onChange={(e) => setLead(Number(e.target.value))}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm outline-none"
          >
            {LEAD_CHOICES.map((m) => (
              <option key={m} value={m}>
                {m === 0 ? t("draft.lead.atStart") : t("draft.lead.before", { minutes: String(m) })}
              </option>
            ))}
          </select>
        )}
        <span className="text-[11px] text-muted-foreground">
          {meetingAt == null ? t("draft.whenHint") : t("draft.whenSet")}
        </span>
      </div>
    </div>
  );
}

/**
 * The meeting draft ("新增會議草稿"): the per-meeting prep — context, folder,
 * agenda — filled in before recording, opened from the title bar and the home
 * screen via `setDraftOpen(true)`. Recording then starts with it.
 *
 * Nothing here is new state: every field edits the prep slice the live meeting
 * already reads, so closing the sheet keeps the draft (it is still the prep),
 * and 清除草稿 is the slice's one reset path.
 */
export function MeetingDraftSheet() {
  const { t } = useI18n();
  const open = useStore((s) => s.draftOpen);
  const setDraftOpen = useStore((s) => s.setDraftOpen);
  const todos = useStore((s) => s.todos);
  const resetPrep = useStore((s) => s.resetPrep);
  const meetingActive = useStore((s) => isMeetingActive(s.meetingStatus));
  const finalizing = useStore((s) => s.isFinalizingMeeting);
  // Same test the title bar uses to offer its "clear prep" item.
  const hasDraft = useStore(
    (s) =>
      !!s.meetingFolderId ||
      s.meetingAt != null ||
      !!s.meetingTitle.trim() ||
      !!s.meetingContext.trim() ||
      !!s.meetingTarget.trim() ||
      s.todos.length > 0
  );
  const { destination, mode, fresh, pickDestination } = useMeetingDestination();

  /** Close first, then start — the same call as 直接錄音, which rides
   *  whatever prep is set. A refusal (missing key, meeting already running)
   *  surfaces as its own toast, and the draft is still there to reopen. */
  function start() {
    setDraftOpen(false);
    void beginMeeting();
  }

  return (
    <Sheet open={open} onOpenChange={setDraftOpen}>
      <SheetContent
        closeLabel={t("common.done")}
        title={t("draft.title")}
        description={t("draft.description")}
        footer={
          <>
            <Button
              size="sm"
              variant="ghost"
              className="mr-auto h-8 text-muted-foreground"
              disabled={!hasDraft || meetingActive}
              onClick={resetPrep}
            >
              <Eraser className="size-3.5" />
              {t("draft.clear")}
            </Button>
            <Button
              size="sm"
              className="h-8"
              disabled={meetingActive || finalizing}
              onClick={start}
            >
              <Mic className="size-3.5" />
              {t("draft.start")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5 px-4 py-3">
          <MeetingWhenFields />

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">{t("dest.title.save")}</span>
            <DestinationField
              gateOnSync
              verb="save"
              title={t("dest.title.save")}
              value={destination}
              mode={mode}
              fresh={fresh}
              onChange={pickDestination}
            />
          </div>

          <MeetingContextField rows={5} />

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">{t("draft.agenda")}</span>
            <div className="overflow-hidden rounded-md border">
              {todos.length === 0 ? (
                <p className="px-3 py-3 text-xs text-muted-foreground">{t("todos.empty")}</p>
              ) : (
                <div className="flex flex-col gap-0.5 p-1.5">
                  {todos.map((todo) => (
                    <TodoRow key={todo.id} todo={todo} />
                  ))}
                </div>
              )}
              <TodoAddForm />
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
