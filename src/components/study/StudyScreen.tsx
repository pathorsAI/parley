import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Clock, Loader2, MessageCircleQuestion, X } from "lucide-react";
import { useStore } from "../../lib/store";
import { hasProviderKey } from "../../lib/ai/settings";
import { useBriefQueued } from "../../lib/analysis/studyPipeline";
import { persistStudyOutputs } from "../../lib/history/history";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import type { IntelState, MeetingType } from "../../lib/types";
import { ReplayScreen } from "../replay/ReplayScreen";
import { ReportContent } from "../sidebar/ReportContent";
import { DeliveryPanel } from "../delivery/DeliveryPanel";
import { IntelSections } from "../live/IntelligenceBoard";
import { slotCatalog } from "../../lib/intel/boards";
import type { SlotDef } from "../../lib/accounts/bundleFile";
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

/** The report's section anchors (order = page order = TOC-rail order). */
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
  const [activeId, setActiveId] = useState<string>(SECTIONS[0].id);

  // The section that owns the viewport: the last heading that has crossed the
  // top edge. Scrolled-to-bottom pins the last section, which may be too short
  // to ever reach the top on its own.
  useEffect(() => {
    const viewport = scrollRef.current?.closest("[data-slot='scroll-area-viewport']");
    if (!viewport) return;
    const onScroll = () => {
      const viewportTop = viewport.getBoundingClientRect().top;
      let current: string = SECTIONS[0].id;
      for (const s of SECTIONS) {
        const el = viewport.querySelector(`#${s.id}`);
        if (el && el.getBoundingClientRect().top - viewportTop <= 96) current = s.id;
      }
      if (viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 4)
        current = SECTIONS[SECTIONS.length - 1].id;
      setActiveId(current);
    };
    onScroll();
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, []);

  const jumpTo = (id: string) => {
    scrollRef.current
      ?.querySelector(`#${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="relative min-h-0 flex-1">
      <ScrollArea className="h-full">
        <div ref={scrollRef} className="mx-auto max-w-2xl px-6 py-5">
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
      <ReportToc activeId={activeId} onJump={jumpTo} />
    </div>
  );
}

/** Notion-style TOC rail: tick marks hugging the right edge — one per section,
 *  the active one emphasized — that expand into a jump list on hover (or on
 *  keyboard focus). An overlay, so the centered report column never reflows and
 *  narrow windows keep it. */
function ReportToc({
  activeId,
  onJump,
}: Readonly<{ activeId: string; onJump: (id: string) => void }>) {
  const { t } = useI18n();
  return (
    <nav
      aria-label={t("study.toc")}
      className="group absolute right-1.5 top-1/2 z-20 -translate-y-1/2"
    >
      {/* Collapsed: the where-am-I glance. */}
      <div className="flex flex-col items-end gap-2 px-2 py-3 transition-opacity duration-150 group-focus-within:opacity-0 group-hover:opacity-0">
        {SECTIONS.map((s) => (
          <span
            key={s.id}
            className={`h-0.5 rounded-full transition-all duration-200 ${
              s.id === activeId ? "w-5 bg-foreground/80" : "w-3 bg-muted-foreground/35"
            }`}
          />
        ))}
      </div>
      {/* Expanded: the jump list. Invisible buttons stay tabbable, so keyboard
          focus reveals the card via group-focus-within. */}
      <div className="pointer-events-none absolute right-0 top-1/2 min-w-36 -translate-y-1/2 rounded-lg border bg-popover/95 p-1 opacity-0 shadow-lg backdrop-blur transition-opacity duration-150 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onJump(s.id)}
            className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
              s.id === activeId
                ? "bg-muted/60 font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            }`}
          >
            <span
              className={`h-3 w-0.5 shrink-0 rounded-full ${
                s.id === activeId ? "bg-primary" : "bg-transparent"
              }`}
            />
            {t(s.key)}
          </button>
        ))}
      </div>
    </nav>
  );
}

function ReportSection({
  id,
  title,
  children,
}: Readonly<{ id: string; title: string; children: ReactNode }>) {
  return (
    <section id={id} className="scroll-mt-4">
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

/** Anything to show from the pre-C per-type sections (legacy recordings) or
 *  the ledgers IntelSections still owns (objections)? */
function legacyHasContent(intel: IntelState): boolean {
  const some = (a?: unknown[]) => (a?.length ?? 0) > 0;
  return (
    some(intel.numbers) ||
    some(intel.concessionsMe) ||
    some(intel.concessionsThem) ||
    some(intel.agreed) ||
    some(intel.open) ||
    Boolean(intel.budget || intel.timeline || intel.decisionMaker) ||
    some(intel.objections) ||
    some(intel.commitments) ||
    some(intel.competitors) ||
    some(intel.theyHave) ||
    some(intel.theyNeed) ||
    some(intel.leverage) ||
    some(intel.give) ||
    some(intel.get)
  );
}

/** id → slot def across everything the type can produce (async: sales reads
 *  the stage-bundle file). A recording only records which slots it FILLED, not
 *  which stage was live — labels must resolve across all stages. */
function useSlotCatalog(type: MeetingType): Map<string, SlotDef> | null {
  const settings = useStore((s) => s.settings);
  const [catalog, setCatalog] = useState<Map<string, SlotDef> | null>(null);
  useEffect(() => {
    let on = true;
    void slotCatalog(type, settings).then((c) => {
      if (on) setCatalog(c);
    });
    return () => {
      on = false;
    };
  }, [type, settings]);
  return catalog;
}

/** The recording's slot board, read-only: every FILLED slot with its
 *  accumulated fills — the study face of the live board. */
function BoardReadout({ intel }: Readonly<{ intel: IntelState }>) {
  const { t } = useI18n();
  const catalog = useSlotCatalog(intel.meetingType);
  if (!catalog) return null;
  const fills = intel.slotFills ?? [];
  const bySlot = new Map<string, typeof fills>();
  for (const f of fills) bySlot.set(f.slotId, [...(bySlot.get(f.slotId) ?? []), f]);
  // Catalog order first; unknown ids (deleted custom stages) render last, raw.
  const ordered = [
    ...[...catalog.keys()].filter((id) => bySlot.has(id)),
    ...[...bySlot.keys()].filter((id) => !catalog.has(id)),
  ];
  return (
    <div className="flex flex-col gap-2.5">
      {ordered.map((id) => (
        <div key={id} className="flex flex-col gap-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            {catalog.get(id)?.label ?? id}
          </span>
          {(bySlot.get(id) ?? []).map((f, i) => (
            <div key={i} className="flex items-baseline gap-1.5 text-xs">
              <span
                className={`shrink-0 text-[10px] ${
                  f.speaker === "me"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-sky-600 dark:text-sky-400"
                }`}
              >
                {f.speaker === "me" ? t("speaker.you") : t("speaker.them")}
              </span>
              <span className="min-w-0 flex-1 leading-snug">{f.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
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

  const current = intel && intel.meetingType === meetingType ? intel : null;
  const hasBoard = (current?.slotFills?.length ?? 0) > 0;
  const hasLegacy = current ? legacyHasContent(current) : false;
  const allEmpty = current !== null && !hasBoard && !hasLegacy;

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
          {current && !allEmpty && (
            /* Bento (from #133): each card flows into two masonry columns when
               width allows. The slot-board readout is the primary card (C);
               IntelSections renders whatever legacy/ledger entries exist. */
            <div className="columns-1 gap-4 sm:columns-2 [&>div]:mb-4 [&>div]:break-inside-avoid [&>div]:rounded-xl [&>div]:border [&>div]:bg-background/60 [&>div]:p-3.5">
              {hasBoard && <BoardReadout intel={current} />}
              {hasLegacy && <IntelSections />}
            </div>
          )}
          {allEmpty && (
            <p className="rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground">
              {t("study.intel.allEmpty")}
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
