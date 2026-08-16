import { useState } from "react";
import { FileText } from "lucide-react";
import { useStore, formatClock } from "../../lib/store";
import { loadHistoryEntry } from "../../lib/history/history";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useMeetingSetup } from "./useMeetingSetup";
import { Column, EmptyState, SectionTitle } from "./bits";

/** How many past meetings in this folder are worth a glance pre-call. */
const RECENT_MEETINGS = 8;

/**
 * Pre-flight column ②: the earlier calls with this customer.
 *
 * One folder is one customer, so the folder picked in column ① is also the
 * question "what happened last time" — and the answer is one click from being
 * reopened, without leaving for the library and losing the prep.
 */
export function ReviewPanel() {
  const { t } = useI18n();
  // Past meetings come from the shared setup rather than a second listHistory()
  // here: the copilot counts them for "第 N 次" and this column lists the newest
  // few, and two independent reads meant two disk hits per folder switch.
  const { folder, scenario, meetings: allMeetings } = useMeetingSetup();
  const meetings = allMeetings.slice(0, RECENT_MEETINGS);

  /** History id the user is about to open, pending "your prep will be lost". */
  const [leavingTo, setLeavingTo] = useState<string | null>(null);

  if (!folder) {
    return (
      <Column step="②" title={t("preflight.review.title")}>
        <EmptyState
          glyph="radar"
          title={t("preflight.review.emptyTitle")}
          hint={scenario ? t("preflight.review.emptyHint") : t("preflight.review.emptyHintGeneral")}
        />
      </Column>
    );
  }

  /** Opening a past recording switches the app into the study tense AND
   *  reloads that meeting's own context over the current prep, so anything set
   *  up here would vanish without warning. The chosen folder IS prep too (⑥),
   *  so it gates the confirm the same as typed context. */
  function openMeeting(id: string) {
    const s = useStore.getState();
    if (
      s.meetingContext.trim() ||
      s.todos.length > 0 ||
      s.meetingFolderId ||
      s.meetingTarget.trim()
    ) {
      setLeavingTo(id);
      return;
    }
    void loadHistoryEntry(id).catch((e) =>
      log.warn("preflight: open meeting failed", { error: String(e) })
    );
  }

  return (
    <Column step="②" title={t("preflight.review.title")}>
      <div className="flex flex-col gap-4">
        {meetings.length === 0 ? (
          <EmptyState
            glyph="notes"
            title={t("preflight.review.freshTitle")}
            hint={t("preflight.review.freshHint")}
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            <SectionTitle>{t("preflight.review.lastMeetings")}</SectionTitle>
            {meetings.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => openMeeting(m.id)}
                className="flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted/50"
              >
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{m.title}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                  {new Date(m.createdAt).toLocaleDateString()} · {formatClock(m.durationMs)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <AlertDialog open={!!leavingTo} onOpenChange={(o) => !o && setLeavingTo(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>{t("preflight.review.leaveTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("preflight.review.leaveBody")}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const id = leavingTo;
                setLeavingTo(null);
                if (id) {
                  void loadHistoryEntry(id).catch((e) =>
                    log.warn("preflight: open meeting failed", { error: String(e) })
                  );
                }
              }}
            >
              {t("preflight.review.leaveConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Column>
  );
}
