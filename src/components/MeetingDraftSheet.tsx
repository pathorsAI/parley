import { Eraser, Mic } from "lucide-react";
import { isMeetingActive, useStore } from "../lib/store";
import { beginMeeting } from "../lib/meeting/start";
import { useI18n } from "../i18n";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { DestinationField } from "./DestinationSheet";
import { MeetingContextField } from "./MeetingContextField";
import { TodoAddForm, TodoRow } from "./sidebar/TodosPanel";
import { useMeetingDestination } from "./useMeetingDestination";

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
