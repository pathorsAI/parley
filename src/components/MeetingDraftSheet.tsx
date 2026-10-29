import { BellRing, CalendarDays, CalendarPlus, Eraser, FolderOpen, NotebookPen, Save, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { isMeetingActive, useStore } from "../lib/store";
import { ensureNotificationPermission } from "../lib/meeting/reminder";
import { useI18n } from "../i18n";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { DestinationField } from "./DestinationSheet";
import { FieldHint, FieldLabel, FieldPanel, FORM_INPUT_CLASS, FormSection } from "./FormSection";
import { MeetingContextField } from "./MeetingContextField";
import { MeetingTimePicker, defaultMeetingTime } from "./MeetingTimePicker";
import { TodoAddForm, TodoRow } from "./sidebar/TodosPanel";
import { useMeetingDestination } from "./useMeetingDestination";

/** Lead times the draft offers, in minutes before the start. */
const LEAD_CHOICES = [0, 5, 10, 15, 30] as const;

/** The draft's name, start time and how long before it to be reminded:
 *  the 會議資訊 section's panels. */
function MeetingWhenFields() {
  const { t } = useI18n();
  const title = useStore((s) => s.meetingTitle);
  const setTitle = useStore((s) => s.setMeetingTitle);
  const meetingAt = useStore((s) => s.meetingAt);
  const setMeetingAt = useStore((s) => s.setMeetingAt);
  const setMeetingEndAt = useStore((s) => s.setMeetingEndAt);
  const lead = useStore((s) => s.reminderLeadMin);
  const setLead = useStore((s) => s.setReminderLeadMin);

  function addTime() {
    const { start, end } = defaultMeetingTime();
    setMeetingAt(start);
    setMeetingEndAt(end);
    // The first time a time is set is when asking makes sense.
    void ensureNotificationPermission();
  }

  function clearTime() {
    setMeetingAt(null);
    setMeetingEndAt(null);
  }

  return (
    <>
      <FieldPanel>
        <FieldLabel label={t("floating.titleLabel")} htmlFor="draft-title" />
        <input
          id="draft-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("floating.untitled")}
          className={FORM_INPUT_CLASS}
        />
        <FieldHint>{t("draft.titleHint")}</FieldHint>
      </FieldPanel>
      <FieldPanel>
        <FieldLabel label={t("draft.when")} />
        {meetingAt == null ? (
          <button
            type="button"
            onClick={addTime}
            className="flex h-9 items-center gap-1.5 self-start rounded-[10px] border border-dashed border-[#dadee5] bg-background px-3 text-sm text-muted-foreground transition-colors hover:text-foreground dark:border-input"
          >
            <CalendarPlus className="size-3.5" />
            {t("draft.addTime")}
          </button>
        ) : (
          <>
            <div className="flex items-center gap-1">
              <div className="min-w-0 flex-1">
                <MeetingTimePicker />
              </div>
              <button
                type="button"
                aria-label={t("draft.whenClear")}
                title={t("draft.whenClear")}
                onClick={clearTime}
                className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted"
              >
                <X className="size-3.5" />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <BellRing className="size-3.5 shrink-0 text-muted-foreground" />
              <select
                aria-label={t("draft.lead")}
                value={lead}
                onChange={(e) => setLead(Number(e.target.value))}
                className="h-8 rounded-[10px] border border-[#dadee5] bg-background px-2 text-sm outline-none dark:border-input"
              >
                {LEAD_CHOICES.map((m) => (
                  <option key={m} value={m}>
                    {m === 0 ? t("draft.lead.atStart") : t("draft.lead.before", { minutes: String(m) })}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
        <FieldHint>{meetingAt == null ? t("draft.whenHint") : t("draft.whenSet")}</FieldHint>
      </FieldPanel>
    </>
  );
}

/**
 * The meeting draft ("新增會議草稿"): the per-meeting prep — name, time,
 * context, folder, agenda — filled in ahead of a meeting. 儲存草稿 files it
 * into the saved drafts (總覽's 即將開始) and clears the fields for the next;
 * a saved draft opens here again from that list (editingDraftId).
 *
 * The fields are the prep slice the live meeting reads, so a new draft closed
 * unsaved is still the prep 直接錄音 rides. Closing while editing a saved one
 * leaves that draft as it was.
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

  const editingId = useStore((s) => s.editingDraftId);
  const language = useStore((s) => s.settings.language);

  /** File the draft into 即將開始 and close. Recording it is a separate act:
   *  開始 on 總覽, or 開始錄音 on its reminder. */
  function save() {
    const saved = useStore.getState().saveDraft();
    setDraftOpen(false);
    if (!saved) return;
    const meetingAt = saved.meetingAt;
    toast.success(
      meetingAt == null
        ? t("draft.saved")
        : t("draft.savedWithTime", {
            time: new Date(meetingAt).toLocaleString(language === "en" ? "en-US" : "zh-TW", {
              month: "numeric",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            }),
          }),
    );
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setDraftOpen(next);
        // Closing a saved draft without saving leaves it as it was.
        if (!next) useStore.getState().discardDraftEdit();
      }}
    >
      <SheetContent
        closeLabel={t("common.close")}
        title={editingId ? t("draft.editTitle") : t("draft.title")}
        description={t("draft.description")}
        footer={
          <>
            {editingId ? (
              <Button
                size="sm"
                variant="ghost"
                className="mr-auto h-8 text-destructive hover:text-destructive"
                disabled={meetingActive}
                onClick={() => {
                  useStore.getState().deleteDraft(editingId);
                  setDraftOpen(false);
                  toast.success(t("draft.deleted"));
                }}
              >
                <Trash2 className="size-3.5" />
                {t("draft.delete")}
              </Button>
            ) : (
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
            )}
            <Button size="sm" className="h-8" disabled={!hasDraft || meetingActive || finalizing} onClick={save}>
              <Save className="size-3.5" />
              {t("draft.save")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4 px-4 py-4">
          <FormSection
            icon={<CalendarDays className="size-3.5" />}
            label={t("draft.section.meeting")}
            note={t("draft.section.meetingNote")}
          >
            <MeetingWhenFields />
          </FormSection>

          <FormSection
            icon={<NotebookPen className="size-3.5" />}
            label={t("draft.section.prep")}
            note={t("draft.section.prepNote")}
          >
            <MeetingContextField form rows={4} />
            <FieldPanel>
              <FieldLabel label={t("draft.agenda")} />
              {todos.length > 0 && (
                <div className="-mx-1.5 flex flex-col gap-0.5">
                  {todos.map((todo) => (
                    <TodoRow key={todo.id} todo={todo} />
                  ))}
                </div>
              )}
              <TodoAddForm bare />
              {todos.length === 0 && <FieldHint>{t("todos.empty")}</FieldHint>}
            </FieldPanel>
          </FormSection>

          <FormSection
            icon={<FolderOpen className="size-3.5" />}
            label={t("draft.section.filing")}
            note={t("draft.section.filingNote")}
          >
            <FieldPanel>
              <FieldLabel label={t("dest.title.save")} />
              <DestinationField
                gateOnSync
                verb="save"
                title={t("dest.title.save")}
                value={destination}
                mode={mode}
                fresh={fresh}
                onChange={pickDestination}
              />
            </FieldPanel>
          </FormSection>
        </div>
      </SheetContent>
    </Sheet>
  );
}
