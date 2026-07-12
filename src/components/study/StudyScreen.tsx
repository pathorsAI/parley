import { useCallback, useRef, useState, type ReactNode } from "react";
import { Clock, Loader2, MessageCircleQuestion, X } from "lucide-react";
import { useStore } from "../../lib/store";
import { hasProviderKey } from "../../lib/ai/settings";
import { useBriefQueued } from "../../lib/analysis/studyPipeline";
import { persistStudyOutputs } from "../../lib/history/history";
import { useI18n, type TranslationKey } from "../../i18n";
import { log } from "../../lib/log";
import type { IntelState, MeetingType } from "../../lib/types";
import { ReplayScreen } from "../replay/ReplayScreen";
import { ReportContent } from "../sidebar/ReportContent";
import { DeliveryPanel } from "../delivery/DeliveryPanel";
import { IntelSections } from "../live/IntelligenceBoard";
import { ActionItemsPanel } from "../replay/ActionItemsPanel";
import { AskPanel } from "../sidebar/AskPanel";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const TYPES: MeetingType[] = ["general", "negotiation", "sales", "partnership"];
/** The typed templates offered by the intel section's picker cards. */
const TYPED: Exclude<MeetingType, "general">[] = ["negotiation", "sales", "partnership"];

/** The report's section anchors (order = page order = nav-pill order). */
const SECTIONS = [
  { id: "study-brief", key: "study.brief" },
  { id: "study-actions", key: "actionItems.title" },
  { id: "study-intel", key: "study.intel" },
  { id: "study-delivery", key: "study.delivery" },
] as const;

/**
 * The STUDY tense: a loaded recording, viewed through two pages (titlebar-center
 * tabs) — the REPORT (brief + action items + intel + delivery, one scroll, read
 * the outcome) and the REPLAY workbench (player + transcript + findings, check
 * the evidence). Ask rides along both as a slide-over drawer.
 */
export function StudyScreen() {
  const tab = useStore((s) => s.studyTab);
  // The LLM pipeline (analysis → action items ∥ delivery → brief, plus intel)
  // is NOT mounted here — it's a store subscription (initStudyPipeline, see
  // lib/analysis/studyPipeline.ts) that runs no matter which screen is up.
  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      {tab === "replay" ? <ReplayScreen /> : <ReportPage />}
      <AskDrawer />
    </div>
  );
}

/** Jump to a moment on the recording: park the playhead, then switch to the
 *  replay tab — its player aligns to the store playhead on mount. */
function useSeekToReplay(): (ms: number) => void {
  return useCallback((ms: number) => {
    const s = useStore.getState();
    s.setReplayPlayhead(Math.max(0, ms));
    s.bumpReplaySeek();
    s.setStudyTab("replay");
  }, []);
}

/** 報告: the whole post-meeting report on one scroll — brief, action items,
 *  intel, delivery. Every piece is restored from the saved entry; only a
 *  missing brief/intel generates (once) and is saved back. */
function ReportPage() {
  const { t } = useI18n();
  const seek = useSeekToReplay();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const jumpTo = (id: string) => {
    scrollRef.current
      ?.querySelector(`#${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div ref={scrollRef} className="mx-auto max-w-2xl px-6 py-5">
        {/* Anchor pills — the report is one scroll; these are shortcuts, not tabs. */}
        <div className="sticky top-0 z-10 -mx-2 mb-4 flex gap-1.5 bg-background/95 px-2 py-2 backdrop-blur">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => jumpTo(s.id)}
              className="rounded-full border px-2.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              {t(s.key)}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-8 pb-10">
          <ReportSection id="study-brief" title={t("study.brief")}>
            <BriefSection onSeek={seek} />
          </ReportSection>

          <ReportSection id="study-actions" title={t("actionItems.title")}>
            <ActionItemsPanel onSeek={seek} embedded />
          </ReportSection>

          <ReportSection id="study-intel" title={t("study.intel")}>
            <IntelSection />
          </ReportSection>

          <ReportSection id="study-delivery" title={t("study.delivery")}>
            <DeliveryPanel mode="replay" variant="full" />
          </ReportSection>
        </div>
      </div>
    </ScrollArea>
  );
}

function ReportSection({
  id,
  title,
  children,
}: Readonly<{ id: string; title: string; children: ReactNode }>) {
  return (
    <section id={id} className="scroll-mt-12">
      <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** The auto-generated debrief. Store-backed + persisted onto the entry, so it
 *  generates ONCE per recording — scrolling away and reopening render the saved
 *  text. Generation AND regeneration are owned by the study pipeline + the
 *  titlebar's analysis chip; this section only renders the pipeline's state —
 *  including "queued" while the upstream analysis / action items still run, so
 *  the wait is never a silent blank. Timestamp clicks jump to replay. */
function BriefSection({ onSeek }: Readonly<{ onSeek: (ms: number) => void }>) {
  const { t } = useI18n();
  const brief = useStore((s) => s.brief);
  const status = useStore((s) => s.briefStatus);
  const saved = useStore((s) => !!s.loadedHistoryId);
  const keyMissing = useStore((s) => !hasProviderKey(s.settings, "deep"));
  const queued = useBriefQueued();

  return (
    <div>
      {status === "done" && saved && !!brief && (
        <p className="mb-2 text-[11px] text-muted-foreground/70">{t("study.brief.saved")}</p>
      )}
      {keyMissing && <p className="text-sm text-muted-foreground">{t("study.brief.missingKey")}</p>}
      {queued && !brief && (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Clock className="size-3.5" />
          {t("study.brief.queued")}
        </p>
      )}
      {status === "running" && !brief && (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {t("study.brief.generating")}
        </p>
      )}
      {status === "error" && (
        <p className="text-sm text-muted-foreground">{t("study.brief.error")}</p>
      )}
      {brief && <ReportContent markdown={brief} onTimestamp={onSeek} />}
    </div>
  );
}

/** The sections of `intel` that came back with nothing, as their i18n title
 *  keys. Every template has exactly four sections, so `length === 4` means the
 *  whole extraction was empty. */
function emptySectionKeys(intel: IntelState): TranslationKey[] {
  const empty: TranslationKey[] = [];
  const none = (a?: unknown[]) => !a || a.length === 0;
  if (intel.meetingType === "negotiation") {
    if (none(intel.numbers)) empty.push("board.sec.numbers");
    if (none(intel.concessionsMe) && none(intel.concessionsThem))
      empty.push("board.sec.concessions");
    if (none(intel.agreed)) empty.push("board.sec.agreed");
    if (none(intel.open)) empty.push("board.sec.open");
  } else if (intel.meetingType === "sales") {
    if (!intel.budget && !intel.timeline && !intel.decisionMaker) empty.push("board.sec.bant");
    if (none(intel.objections)) empty.push("board.sec.objections");
    if (none(intel.commitments)) empty.push("board.sec.commitments");
    if (none(intel.competitors)) empty.push("board.sec.competitors");
  } else if (intel.meetingType === "partnership") {
    if (none(intel.theyHave)) empty.push("board.sec.theyHave");
    if (none(intel.theyNeed)) empty.push("board.sec.theyNeed");
    if (none(intel.leverage)) empty.push("board.sec.leverage");
    if (none(intel.give) && none(intel.get)) empty.push("board.sec.giveGet");
  }
  return empty;
}

/** 情報: the intelligence board run over the full recording. The meeting type is
 *  PER-RECORDING (store.studyMeetingType, persisted on the entry) — switching it
 *  here never touches the global live default or other recordings. */
function IntelSection() {
  const { t } = useI18n();
  const meetingType = useStore((s) => s.studyMeetingType);
  const setStudyMeetingType = useStore((s) => s.setStudyMeetingType);
  const intel = useStore((s) => s.intel);
  const intelStatus = useStore((s) => s.intelStatus);
  const running = intelStatus === "running";

  // Extraction is owned by the study pipeline (studyPipeline.ts), which runs
  // whenever the picked type has no matching board — this section only picks
  // the type (switching it re-extracts automatically); the manual re-run lives
  // in the titlebar's analysis chip.
  const pickType = (v: MeetingType) => {
    setStudyMeetingType(v);
    // Remember the choice on the entry right away (extraction saves again later).
    void persistStudyOutputs().catch((e) =>
      log.warn("study: meeting-type persist failed", { error: String(e) })
    );
  };

  const emptyKeys = intel && intel.meetingType === meetingType ? emptySectionKeys(intel) : [];
  const allEmpty = emptyKeys.length === 4;

  return (
    <div>
      {meetingType !== "general" && (
        <div className="mb-3 flex items-center gap-2">
          <Select value={meetingType} onValueChange={(v) => pickType(v as MeetingType)}>
            <SelectTrigger className="h-7 w-52 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPES.map((v) => (
                <SelectItem key={v} value={v}>
                  {t(`board.type.${v}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {running && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
        </div>
      )}
      {meetingType === "general" ? (
        // No template picked yet: the empty state is the type picker, not a dead end.
        <div className="flex flex-col gap-2">
          <p className="mb-1 text-sm text-muted-foreground">{t("study.intel.pick")}</p>
          {TYPED.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => pickType(v)}
              className="rounded-lg border bg-muted/20 px-4 py-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
            >
              <div className="text-sm font-medium">{t(`board.type.${v}`)}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {t(`study.intel.type.${v}.desc`)}
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {!intel && (
            <p className="text-sm text-muted-foreground">
              {running ? t("board.extracting") : t("board.empty")}
            </p>
          )}
          {intel?.meetingType === meetingType && !allEmpty && (
            /* Bento (from #133): each section becomes a card, flowing into two
               masonry columns when the width allows — the narrow-rail
               components read terribly stretched across one wide column. */
            <div className="columns-1 gap-4 sm:columns-2 [&>div]:mb-4 [&>div]:break-inside-avoid [&>div]:rounded-xl [&>div]:border [&>div]:bg-background/60 [&>div]:p-3.5">
              <IntelSections />
            </div>
          )}
          {/* "Scanned but found nothing" ≠ "didn't run": name the empty sections. */}
          {intel?.meetingType === meetingType && allEmpty && (
            <p className="rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground">
              {t("study.intel.allEmpty")}
            </p>
          )}
          {intel?.meetingType === meetingType && !allEmpty && emptyKeys.length > 0 && (
            <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
              {t("study.intel.scannedNone")}
              {emptyKeys.map((k) => t(k)).join("・")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Ask, freed from the replay screen's third-level tab: a floating button that
 *  opens a right slide-over, available on BOTH study pages. The panel stays
 *  mounted while closed so the conversation survives toggling. */
function AskDrawer() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <>
      {!open && (
        <Button
          size="sm"
          className="absolute bottom-4 right-4 z-30 h-9 rounded-full px-3.5 shadow-lg"
          onClick={() => setOpen(true)}
        >
          <MessageCircleQuestion className="size-4" />
          {t("work.ask")}
        </Button>
      )}
      {open && (
        <button
          type="button"
          aria-label={t("common.close")}
          className="absolute inset-0 z-30 bg-black/30"
          onClick={() => setOpen(false)}
        />
      )}
      <div
        className={`absolute inset-y-0 right-0 z-40 flex w-[380px] max-w-[85vw] flex-col border-l bg-background shadow-xl transition-transform duration-200 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!open}
      >
        <div className="flex h-9 shrink-0 items-center justify-between border-b px-3">
          <span className="text-xs font-medium">{t("work.ask")}</span>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setOpen(false)}
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <AskPanel />
        </div>
      </div>
    </>
  );
}
