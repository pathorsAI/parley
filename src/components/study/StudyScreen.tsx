import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Clock, MessageCircleQuestion, Pencil, RotateCw, X } from "lucide-react";
import { DEFAULT_GETTING_STARTED, useStore } from "../../lib/store";
import { missingProviderRequirement, providerGateKey } from "../../lib/ai/settings";
import { regenerateArtifact, useBriefQueued, type StudyArtifactKey } from "../../lib/analysis/studyPipeline";
import { normalizeBriefHeadings, splitBrief, type BriefSection as BriefSectionPart } from "../../lib/analysis/briefSections";
import { meetingBackgroundOf, meetingNotesOf } from "../../lib/history/meetingNotes";
import { MeetingContextSheet } from "../MeetingContextButton";
import type { StudyTab } from "../../lib/store/study";
import { useI18n } from "../../i18n";
import { ReplayScreen } from "../replay/ReplayScreen";
import { ReportContent } from "../sidebar/ReportContent";
import { DeliveryPanel } from "../delivery/DeliveryPanel";
import { ActionItemsPanel } from "../replay/ActionItemsPanel";
import { AskPanel } from "../sidebar/AskPanel";
import { StudyHeader, STUDY_TABPANEL_ID, studyTabId } from "./StudyHeader";
import { LapContext, useLapState } from "../../lib/onboarding/lap";
import { GuideBar } from "./GuideBar";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * The STUDY tense: a loaded recording, under one header (its name, where it is
 * filed, the copy menu) and five tabs — 總結 (the brief), 後續行動, 筆記 (the
 * notes typed in the floating window during the meeting; only when there are
 * some), 評分 (delivery) and 回放 (the replay workbench: player + transcript +
 * findings, check the evidence). Ask rides along every tab as a slide-over
 * drawer.
 */
export function StudyScreen({ libraryCount = 0 }: Readonly<{ libraryCount?: number }> = {}) {
  const storedTab = useStore((s) => s.studyTab);
  const gettingStarted = useStore((s) => s.settings.gettingStarted) ?? DEFAULT_GETTING_STARTED;
  const entryId = useStore((s) => s.loadedHistoryId);
  const readOnly = useStore((s) => s.replayReadOnly);
  const notes = useStore((s) => meetingNotesOf(s.meetingContext));
  const background = useStore((s) => meetingBackgroundOf(s.meetingContext));
  const lap = useLapState({ gettingStarted, entryId, readOnly, libraryCount });
  // The destination picker, owned here so the guide bar opens the same sheet
  // as the header's filing row.
  const [pickerOpen, setPickerOpen] = useState(false);
  // A recording without notes (or a background) has no such tab; land on the
  // summary instead.
  const missing = (storedTab === "notes" && !notes) || (storedTab === "context" && !background);
  const tab: StudyTab = missing ? "summary" : storedTab;

  // The LLM pipeline (analysis → action items ∥ delivery → brief)
  // is NOT mounted here — it's a store subscription (initStudyPipeline, see
  // lib/analysis/studyPipeline.ts) that runs no matter which screen is up.
  return (
    <LapContext.Provider value={lap}>
      {/* data-study-root: the stage the lap's confetti is clipped to. */}
      <div data-study-root className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <StudyHeader
          tab={tab}
          notesCount={noteCount(notes)}
          hasContext={!!background}
          pickerOpen={pickerOpen}
          onPickerOpenChange={setPickerOpen}
        />
        {/* Ask floats over the page, so it sits above the guide bar, not on it. */}
        <div
          id={STUDY_TABPANEL_ID}
          role="tabpanel"
          aria-labelledby={studyTabId(tab)}
          className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          {tab === "replay" ? <ReplayScreen /> : <TabPage tab={tab} notes={notes} background={background} />}
          <AskDrawer />
        </div>
        <GuideBar onOpenPicker={() => setPickerOpen(true)} />
      </div>
    </LapContext.Provider>
  );
}

/** How many notes: one per non-empty line, the way they were typed. */
function noteCount(notes: string): number {
  return notes ? notes.split("\n").filter((line) => line.trim()).length : 0;
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

/** Every tab but replay: one reading column, edge to edge with the header. Each piece is restored
 *  from the saved entry; only a missing one generates (once) and is saved. */
function TabPage({
  tab,
  notes,
  background,
}: Readonly<{ tab: Exclude<StudyTab, "replay">; notes: string; background: string }>) {
  const seek = useSeekToReplay();
  const briefDone = useStore((s) => s.briefStatus === "done" && !!s.brief);
  const actionsDone = useStore((s) => s.actionItemsStatus === "done");

  let body: ReactNode;
  if (tab === "summary") {
    body = (
      <>
        <BriefSection onSeek={seek} />
        {briefDone && <SavedFooter artifact="brief" />}
      </>
    );
  } else if (tab === "actions") {
    body = (
      <>
        <UnsidedActionsNote />
        <ActionItemsPanel onSeek={seek} embedded />
        <BriefNextSection onSeek={seek} />
        {actionsDone && <SavedFooter artifact="actions" />}
      </>
    );
  } else if (tab === "notes") {
    body = <NotesSection notes={notes} />;
  } else if (tab === "context") {
    body = <BackgroundSection background={background} />;
  } else {
    body = <DeliveryPanel mode="replay" variant="full" />;
  }

  return (
    <ScrollArea className="h-full">
      {/* Keyed by tab: each tab starts at its top. Same edges as the header
          above and the replay tab (px-6, full width), so switching tabs never
          shifts the page's left edge. */}
      <div key={tab} className="px-6 py-5 pb-10">
        {body}
      </div>
    </ScrollArea>
  );
}

/**
 * Action items made before they said who does what (no side on any item) are
 * one flat list. Say why, and offer the regeneration that sorts them into 我們
 * and 對方 — otherwise an old recording just looks like the grouping is broken.
 */
function UnsidedActionsNote() {
  const { t } = useI18n();
  const show = useStore(
    (s) =>
      s.actionItemsStatus === "done" &&
      !!s.loadedHistoryId &&
      s.actionItems.length > 0 &&
      s.actionItems.every((a) => !a.side)
  );
  if (!show) return null;
  return (
    <div className="mb-3 flex items-center justify-between gap-3 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
      <span>{t("study.actions.unsided")}</span>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 shrink-0 gap-1 px-2 text-xs"
        onClick={() => regenerateArtifact("actions")}
      >
        <RotateCw className="size-3" />
        {t("study.regenerate")}
      </Button>
    </div>
  );
}

/**
 * Under a finished, saved artifact: it is kept with the recording (reopening
 * reads it back, it never regenerates by itself), and a way to ask for a new
 * one — the same regeneration the titlebar's analysis chip runs. Nothing to
 * say for an unsaved or read-only recording, where it isn't kept.
 */
function SavedFooter({ artifact }: Readonly<{ artifact: Extract<StudyArtifactKey, "brief" | "actions"> }>) {
  const { t } = useI18n();
  const saved = useStore((s) => !!s.loadedHistoryId);
  if (!saved) return null;
  return (
    <div className="mt-6 flex items-center justify-between gap-3">
      <p className="text-[11px] text-muted-foreground/70">{t("study.saved")}</p>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 text-xs text-muted-foreground"
        onClick={() => regenerateArtifact(artifact)}
      >
        <RotateCw className="size-3" />
        {t("study.regenerate")}
      </Button>
    </div>
  );
}

/** 筆記: what the user typed in the floating window during the meeting, as
 *  typed. Read-only here — it is saved inside the meeting context, which the
 *  filing row's 會議背景 sheet edits. */
function NotesSection({ notes }: Readonly<{ notes: string }>) {
  const { t } = useI18n();
  return (
    <div>
      <p className="mb-2 text-[11px] text-muted-foreground/70">{t("study.notes.caption")}</p>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{notes}</p>
    </div>
  );
}

/** 會議背景: what was prepared before the meeting (the draft's context), the
 *  notes taken during it left to their own tab. The tab exists only when there
 *  is a background; editing it opens the same sheet the page's menu used to. */
function BackgroundSection({ background }: Readonly<{ background: string }>) {
  const { t } = useI18n();
  const seek = useSeekToReplay();
  const editable = useStore((s) => !s.replayReadOnly && !!s.loadedHistoryId);
  const [editing, setEditing] = useState(false);
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground/70">{t("study.context.caption")}</p>
        {editable && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs text-muted-foreground"
            onClick={() => setEditing(true)}
          >
            <Pencil className="size-3" />
            {t("study.context.edit")}
          </Button>
        )}
      </div>
      <ReportContent markdown={background} onTimestamp={seek} />
      <MeetingContextSheet open={editing} onOpenChange={setEditing} />
    </div>
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
  const entryId = useStore((s) => s.loadedHistoryId);
  // null = configured. Otherwise the i18n key naming what's still missing.
  const gate = useStore((s) =>
    providerGateKey(missingProviderRequirement(s.settings, "deep"), "study.brief.missingKey")
  );
  const queued = useBriefQueued();
  const running = status === "running";

  // One caption row whose TEXT changes with the stage — queued, generating
  // (also while text streams in) — so moving between them never adds or
  // removes a line above the brief.
  // (Saved is said by the footer under the brief, with its regenerate.)
  let caption: string | null = null;
  if (!brief && queued) caption = t("study.brief.queued");
  else if (running) caption = t("study.brief.generating");

  return (
    <div>
      {caption && (
        <p className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
          {!brief && queued && <Clock className="size-3" />}
          {caption}
        </p>
      )}
      {/* The key only matters while there's no brief to read. */}
      {gate && !brief && <p className="text-sm text-muted-foreground">{t(gate)}</p>}
      {/* Before the first token: a placeholder in the brief's own shape, so the
          section already holds roughly its final height. */}
      {!gate && !brief && (queued || running) && <BriefSkeleton />}
      {status === "error" && (
        <p className="text-sm text-muted-foreground">{t("study.brief.error")}</p>
      )}
      {/* Keyed by recording: another recording opens on its first section. */}
      {brief && <BriefTabs key={entryId ?? ""} brief={brief} onSeek={onSeek} />}
    </div>
  );
}

/** One label per brief section: the prompt's known headings translated, any
 *  other heading as the model wrote it. */
function useSectionLabel(): (s: BriefSectionPart) => string {
  const { t } = useI18n();
  return (s) => (s.key ? t(`study.brief.section.${s.key}`) : s.title);
}

/**
 * The brief a section at a time: a row of small tabs (重點／決議／待解問題…),
 * one section under it. The forward-looking section isn't here — it reads
 * under 後續行動 ({@link BriefNextSection}). A brief that can't be cut (no
 * headings, or a single section) is shown whole, with no tabs.
 */
function BriefTabs({ brief, onSeek }: Readonly<{ brief: string; onSeek: (ms: number) => void }>) {
  const label = useSectionLabel();
  const { lead, sections } = useMemo(() => splitBrief(brief), [brief]);
  const [picked, setPicked] = useState(0);
  // A streaming brief grows sections; a regenerated one may have fewer.
  const index = Math.min(picked, Math.max(0, sections.length - 1));

  if (sections.length < 2) {
    const whole = [lead, ...sections.map((s) => s.body)].filter(Boolean).join("\n\n");
    return <ReportContent markdown={whole || normalizeBriefHeadings(brief)} onTimestamp={onSeek} />;
  }
  return (
    <div className="flex flex-col gap-3">
      {lead && <ReportContent markdown={lead} onTimestamp={onSeek} />}
      <div role="tablist" className="flex flex-wrap gap-1.5">
        {sections.map((s, i) => (
          <button
            key={`${s.title}-${i}`}
            type="button"
            role="tab"
            aria-selected={i === index}
            onClick={() => setPicked(i)}
            className={cn(
              "h-7 rounded-full px-3 text-xs font-medium transition-colors",
              i === index
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {label(s)}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        <ReportContent markdown={sections[index].body} onTimestamp={onSeek} />
      </div>
    </div>
  );
}

/** Under the action items: the brief's forward-looking section (the next
 *  agenda, or how to move the deal on), moved here from 總結 because it is the
 *  same question — what happens after this meeting. */
function BriefNextSection({ onSeek }: Readonly<{ onSeek: (ms: number) => void }>) {
  const label = useSectionLabel();
  const brief = useStore((s) => s.brief);
  const next = useMemo(() => (brief ? splitBrief(brief).next : []), [brief]);
  if (next.length === 0) return null;
  return (
    <div className="mt-8 flex flex-col gap-6">
      {next.map((s, i) => (
        <section key={`${s.title}-${i}`}>
          <h2 className="mb-2 text-xs font-semibold text-muted-foreground">{label(s)}</h2>
          <ReportContent markdown={s.body} onTimestamp={onSeek} />
        </section>
      ))}
    </div>
  );
}

/** A brief-shaped placeholder: the debrief is a couple of short headed sections
 *  of prose and bullets (see briefSections in lib/analysis/lens.ts), rendered at
 *  prose-sm — so two headings, a paragraph and a bullet list, on that rhythm. */
function BriefSkeleton() {
  return (
    <div className="flex flex-col gap-2.5 pt-1" aria-hidden="true">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-3.5 w-full" />
      <Skeleton className="h-3.5 w-11/12" />
      <Skeleton className="h-3.5 w-3/5" />
      <Skeleton className="mt-3 h-4 w-24" />
      {["w-10/12", "w-9/12", "w-11/12", "w-7/12"].map((w) => (
        <div key={w} className="flex items-center gap-2 pl-1">
          <Skeleton className="size-1.5 shrink-0 rounded-full" />
          <Skeleton className={`h-3.5 ${w}`} />
        </div>
      ))}
    </div>
  );
}

/** Ask, freed from the replay screen's third-level tab: a floating button that
 *  opens a right slide-over, available on every study tab. The panel stays
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
