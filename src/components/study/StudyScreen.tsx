import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Clock, Loader2, MessageCircleQuestion, X } from "lucide-react";
import { useStore } from "../../lib/store";
import { hasProviderKey } from "../../lib/ai/settings";
import { useBriefQueued } from "../../lib/analysis/studyPipeline";
import { useI18n } from "../../i18n";
import { ReplayScreen } from "../replay/ReplayScreen";
import { ReportContent } from "../sidebar/ReportContent";
import { DeliveryPanel } from "../delivery/DeliveryPanel";
import { ActionItemsPanel } from "../replay/ActionItemsPanel";
import { AskPanel } from "../sidebar/AskPanel";
import { StudyLinkBar } from "./StudyLinkBar";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

/** The report's section anchors (order = page order = TOC-rail order). */
const SECTIONS = [
  { id: "study-brief", key: "study.brief" },
  { id: "study-actions", key: "actionItems.title" },
  { id: "study-delivery", key: "study.delivery" },
] as const;

/**
 * The STUDY tense: a loaded recording, viewed through two pages (titlebar-center
 * tabs) — the REPORT (brief + action items + delivery, one scroll, read the
 * outcome) and the REPLAY workbench (player + transcript + findings, check
 * the evidence). Ask rides along both as a slide-over drawer.
 */
export function StudyScreen() {
  const tab = useStore((s) => s.studyTab);
  // The LLM pipeline (analysis → action items ∥ delivery → brief)
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
 *  delivery. Every piece is restored from the saved entry; only a missing
 *  brief generates (once) and is saved back. */
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
          <StudyLinkBar />
          <div className="flex flex-col gap-8 pb-10">
            <ReportSection id="study-brief" title={t("study.brief")}>
              <BriefSection onSeek={seek} />
            </ReportSection>

            <ReportSection id="study-actions" title={t("actionItems.title")}>
              <ActionItemsPanel onSeek={seek} embedded />
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
