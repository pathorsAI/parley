import { useState } from "react";
import { FileText, Plus, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useStore, formatClock } from "../../lib/store";
import { loadHistoryEntry } from "../../lib/history/history";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SlotRow } from "../live/SlotBoard";
import { BriefingSheet } from "../accounts/BriefingSheet";
import { useMeetingSetup } from "./useMeetingSetup";
import { Column, EmptyState, SectionTitle } from "./bits";

/** How many past meetings with this company are worth a glance pre-call. */
const RECENT_MEETINGS = 3;

/**
 * Pre-flight column ②: what the last calls with this company established.
 *
 * Everything here is a read-only projection of the accounts layer — red lines,
 * open questions, the stage gap board, past meetings. It used to require
 * leaving the live screen for the accounts workspace, which is also blocked
 * once recording starts, so in practice nobody reviewed anything.
 */
export function ReviewPanel() {
  const { t } = useI18n();
  // Past meetings come from the shared setup rather than a second listHistory()
  // here: the copilot counts them for "第 N 次" and this column lists the newest
  // few, and two independent reads meant two disk hits per company switch.
  const { company, scenario, stageId, claims, rows, meetings: allMeetings } = useMeetingSetup();
  const meetings = allMeetings.slice(0, RECENT_MEETINGS);

  const addTodo = useStore((s) => s.addTodo);

  const [briefingOpen, setBriefingOpen] = useState(false);
  /** History id the user is about to open, pending "your prep will be lost". */
  const [leavingTo, setLeavingTo] = useState<string | null>(null);

  const redlines = claims.filter((c) => c.category === "redline");
  const openQuestions = claims.filter((c) => c.category === "openq");

  if (!company) {
    return (
      <Column step="②" title={t("preflight.review.title")}>
        <EmptyState
          glyph="radar"
          title={t("preflight.review.emptyTitle")}
          hint={
            scenario ? t("preflight.review.emptyHint") : t("preflight.review.emptyHintGeneral")
          }
        />
      </Column>
    );
  }

  // A board always HAS rows (they're the stage's slots) — "we know nothing
  // about this company" is about whether any of them carry a card.
  const hasAnything =
    meetings.length > 0 ||
    redlines.length > 0 ||
    openQuestions.length > 0 ||
    rows.some((r) => r.claims.length > 0);

  /** Opening a past recording switches the app into replay AND reloads that
   *  meeting's own context/link over the current prep, so anything typed here
   *  would vanish without warning. Ask first when there IS something to lose. */
  function openMeeting(id: string) {
    const s = useStore.getState();
    if (s.meetingContext.trim() || s.todos.length > 0) {
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
        {!hasAnything && (
          <EmptyState
            glyph="notes"
            title={t("preflight.review.freshTitle")}
            hint={t("preflight.review.freshHint")}
          />
        )}

        {meetings.length > 0 && (
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

        {redlines.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <SectionTitle>⚠ {t("preflight.review.redlines")}</SectionTitle>
            {redlines.map((c) => (
              <p
                key={c.id}
                className="rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-1.5 text-xs leading-snug text-red-700 dark:text-red-300"
              >
                {c.text}
              </p>
            ))}
            <p className="text-[10px] text-muted-foreground">{t("preflight.review.redlinesHint")}</p>
          </div>
        )}

        {openQuestions.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <SectionTitle>{t("preflight.review.openq")}</SectionTitle>
            {openQuestions.map((c) => (
              <div
                key={c.id}
                className="group flex items-start gap-2 rounded-md border px-2.5 py-1.5"
              >
                <p className="min-w-0 flex-1 text-xs leading-snug">{c.text}</p>
                <button
                  type="button"
                  title={t("preflight.review.addToAgenda")}
                  aria-label={t("preflight.review.addToAgenda")}
                  onClick={() => {
                    addTodo(c.text);
                    toast.success(t("preflight.review.addedToAgenda"));
                  }}
                  className="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Plus className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {rows.length > 0 && (
          <div className="flex flex-col gap-1">
            <SectionTitle>
              {t("preflight.review.board")}
              {stageId && scenario?.names[stageId] ? ` · ${scenario.names[stageId]}` : ""}
            </SectionTitle>
            {rows.map(({ slot, claims: cards, state }) => (
              <SlotRow
                key={slot.id}
                state={state}
                label={slot.label}
                content={
                  [...cards].sort((a, b) => b.lastSupportedAt - a.lastSupportedAt)[0]?.text ?? ""
                }
                count={cards.length}
              />
            ))}
            <p className="px-1.5 pt-0.5 text-[10px] text-muted-foreground">
              {t("preflight.review.boardHint")}
            </p>
          </div>
        )}

        <Button
          size="sm"
          variant="outline"
          className="h-8 self-start"
          disabled={claims.length === 0}
          title={claims.length === 0 ? t("accounts.noClaims") : undefined}
          onClick={() => setBriefingOpen(true)}
        >
          <Sparkles className="size-3.5" />
          {t("accounts.briefing.generate")}
        </Button>
      </div>

      {briefingOpen && (
        <BriefingSheet company={company} open onOpenChange={setBriefingOpen} />
      )}

      <AlertDialog open={!!leavingTo} onOpenChange={(o) => !o && setLeavingTo(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>{t("preflight.review.leaveTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("preflight.review.leaveBody")}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("accounts.cancel")}</AlertDialogCancel>
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
