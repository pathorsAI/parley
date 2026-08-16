import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Clock, Loader2, MessageCircleQuestion, X } from "lucide-react";
import { toast } from "sonner";
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
import { slotCatalog } from "../../lib/intel/boards";
import { useScenarioSet } from "../../lib/scenarios/useStageSet";
import {
  buildScenarioSet,
  createBoardlessKind,
  isValidScenarioId,
  readStageBundleFile,
  type Scenario,
  type ScenarioSet,
} from "../../lib/scenarios/bundles";
import { applyScenario } from "../../lib/meeting/scenario";
import { DEFAULT_ICON_NAME, resolveIcon } from "../../lib/icons";
import { IconPicker } from "../IconPicker";
import {
  BUILTIN_SCENARIO_IDS,
  type ParsedBundleFile,
  type SlotDef,
} from "../../lib/scenarios/bundleFile";
import { ActionItemsPanel } from "../replay/ActionItemsPanel";
import { AskPanel } from "../sidebar/AskPanel";
import { StudyLinkBar } from "./StudyLinkBar";
import { pushRecentMeetingType, slugifyKindId, sortByRecent } from "./kindPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
          <StudyLinkBar />
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
          {(bySlot.get(id) ?? []).map((f) => (
            <div key={`${f.speaker}:${f.text}`} className="flex items-baseline gap-1.5 text-xs">
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

/** Sentinel row value for "create a kind". The Select is controlled by
 *  `meetingType`, so picking it opens the sheet and never sticks as a value. */
const NEW_KIND_VALUE = "__new-kind__";

/**
 * The scenario universe plus a way to re-read it. `useScenarioSet` reads the
 * bundle file once on mount and the file has no change event, so creating a
 * kind (which writes that file) has to trigger the same fresh read the settings
 * editor does — otherwise the kind you just made isn't in the list you made it
 * from.
 */
function useRefreshableScenarioSet(): {
  scenarios: ScenarioSet;
  refresh: () => Promise<ScenarioSet>;
} {
  const { t } = useI18n();
  const base = useScenarioSet();
  const [file, setFile] = useState<ParsedBundleFile | null>(null);
  const scenarios = useMemo(
    () => (file ? buildScenarioSet((k) => t(k as TranslationKey), file) : base),
    [file, base, t]
  );
  const refresh = useCallback(async () => {
    const parsed = await readStageBundleFile({ fresh: true });
    setFile(parsed);
    return buildScenarioSet((k) => t(k as TranslationKey), parsed);
  }, [t]);
  return { scenarios, refresh };
}

/** 情報: the intelligence board run over the full recording. The meeting type is
 *  PER-RECORDING (store.meetingType, persisted on the entry) — switching it
 *  here never touches the global live default or other recordings. */
function IntelSection() {
  const { t } = useI18n();
  const meetingType = useStore((s) => s.meetingType);
  const recent = useStore((s) => s.settings.recentMeetingTypes);
  const intel = useStore((s) => s.intel);
  const intelStatus = useStore((s) => s.intelStatus);
  const running = intelStatus === "running";
  const [creating, setCreating] = useState(false);

  const { scenarios, refresh } = useRefreshableScenarioSet();
  // Recently picked first: the list is no longer a fixed handful once kinds can
  // be created from here, and the ones you use are the ones you use again.
  const ordered = useMemo(() => sortByRecent(scenarios.list, recent), [scenarios, recent]);

  // Extraction is owned by the study pipeline (studyPipeline.ts), which runs
  // whenever the picked type has no matching board — this section only picks
  // the type (switching it re-extracts automatically); the manual re-run lives
  // in the titlebar's analysis chip.
  //
  // applyScenario, never setMeetingType: the pick has to leave behind the
  // boardless flag the pipeline reads. Not the eval template though — this is a
  // finished recording, and retagging it must not re-point the rubric the NEXT
  // live meeting will be coached against.
  const pickType = (v: MeetingType, set: ScenarioSet = scenarios) => {
    applyScenario(v, set, { carryEvalTemplate: false });
    if (v !== "general") {
      const { settings, updateSettings } = useStore.getState();
      updateSettings({
        recentMeetingTypes: pushRecentMeetingType(settings.recentMeetingTypes, v),
      });
    }
    // Remember the choice on the entry right away (extraction saves again later).
    void persistStudyOutputs().catch((e) =>
      log.warn("study: meeting-type persist failed", { error: String(e) })
    );
  };

  /** A freshly created kind is applied to THIS recording straight away — the
   *  reason to author one from the picker is to use it here. */
  async function onKindCreated(id: string) {
    pickType(id, await refresh());
    setCreating(false);
  }

  const current = intel && intel.meetingType === meetingType ? intel : null;
  const hasBoard = (current?.slotFills?.length ?? 0) > 0;
  const hasLegacy = current ? legacyHasContent(current) : false;
  const allEmpty = current !== null && !hasBoard && !hasLegacy;
  /** Builtin scenarios ship a one-line description; customs describe themselves. */
  const descOf = (id: string) =>
    (BUILTIN_SCENARIO_IDS as readonly string[]).includes(id)
      ? t(`study.intel.type.${id}.desc` as TranslationKey)
      : "";
  /** Board or no board, said quietly — a trailing muted phrase, not a badge. */
  const boardNote = (s: Scenario) =>
    s.hasBoard ? t("study.kind.liveBoard") : t("study.kind.analysisOnly");
  const selected = scenarios.byId[meetingType] ?? null;
  const SelectedIcon = resolveIcon(selected?.icon);

  return (
    <div>
      {meetingType !== "general" && (
        <div className="mb-3 flex items-center gap-2">
          <Select
            value={meetingType}
            onValueChange={(v) => (v === NEW_KIND_VALUE ? setCreating(true) : pickType(v))}
          >
            <SelectTrigger className="h-7 w-52 text-xs">
              {/* Explicit children: each row carries a trailing board note that
                  the trigger would otherwise echo into 52 units of width. */}
              <SelectValue>
                {/* SelectTrigger already lays the value out as a flex row. */}
                {selected ? (
                  <>
                    <SelectedIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{selected.name}</span>
                  </>
                ) : (
                  t("board.type.general")
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="general">{t("board.type.general")}</SelectItem>
              {ordered.map((s) => {
                const Icon = resolveIcon(s.icon);
                return (
                  <SelectItem key={s.id} value={s.id}>
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    {s.name}
                    <span className="text-xs text-muted-foreground/60">{boardNote(s)}</span>
                  </SelectItem>
                );
              })}
              <SelectItem value={NEW_KIND_VALUE} className="text-muted-foreground">
                {t("study.kind.add")}
              </SelectItem>
            </SelectContent>
          </Select>
          {running && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
        </div>
      )}
      {meetingType === "general" ? (
        // No scenario picked yet: the empty state is the picker, not a dead end.
        <div className="flex flex-col gap-2">
          <p className="mb-1 text-sm text-muted-foreground">{t("study.intel.pick")}</p>
          {ordered.map((s) => {
            const Icon = resolveIcon(s.icon);
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => pickType(s.id)}
                className="cursor-pointer rounded-lg border bg-muted/20 px-4 py-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
              >
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  {s.name}
                  <span className="text-xs font-normal text-muted-foreground/60">
                    {boardNote(s)}
                  </span>
                </div>
                {descOf(s.id) && (
                  <div className="mt-0.5 text-xs text-muted-foreground">{descOf(s.id)}</div>
                )}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="cursor-pointer rounded-lg border border-dashed px-4 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
          >
            {t("study.kind.add")}
          </button>
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

      <NewKindSheet
        open={creating}
        onOpenChange={setCreating}
        taken={scenarios.byId}
        onCreated={(id) => void onKindCreated(id)}
      />
    </div>
  );
}

/**
 * Author a boardless KIND from the picker: an emoji, a name, and the analysis
 * lens. Editing flow → Sheet (repo rule), and validation is inline and live:
 * the id is what MCP and every saved recording refer to the kind by, so an
 * invalid or taken one has to be visible before Save, not after.
 */
function NewKindSheet({
  open,
  onOpenChange,
  taken,
  onCreated,
}: Readonly<{
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Every id already in use — the collision check the bundle file would make. */
  taken: Record<string, Scenario>;
  onCreated: (id: string) => void;
}>) {
  const { t } = useI18n();
  const [icon, setIcon] = useState(DEFAULT_ICON_NAME);
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  // The id follows the name until it is edited by hand. A zh-TW name slugs to
  // nothing, which is exactly why the field is visible and editable rather than
  // derived silently.
  const [idEdited, setIdEdited] = useState(false);
  const [guidance, setGuidance] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setIcon(DEFAULT_ICON_NAME);
    setName("");
    setId("");
    setIdEdited(false);
    setGuidance("");
    setSaving(false);
  }, [open]);

  const nameError = name.trim() ? null : t("study.kind.err.name");
  let idError: string | null = null;
  if (!isValidScenarioId(id)) idError = t("study.kind.err.id");
  else if (taken[id]) idError = t("study.kind.err.idTaken");
  // Errors appear as soon as anything is typed, but a blank form isn't scolded
  // for being blank — Save is simply disabled until it holds up.
  const touched = name !== "" || id !== "" || idEdited;
  const canSave = !nameError && !idError && !saving;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      await createBoardlessKind({
        id,
        name: name.trim(),
        icon: icon || DEFAULT_ICON_NAME,
        guidance: guidance.trim(),
      });
      onCreated(id);
    } catch (e) {
      log.warn("study: create kind failed", { error: String(e) });
      toast.error(t("study.kind.saveFailed"));
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={t("study.kind.new")}
        description={t("study.kind.desc")}
        closeLabel={t("common.close")}
        footer={
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button size="sm" className="h-8" disabled={!canSave} onClick={() => void save()}>
              {t("study.kind.save")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">{t("study.kind.icon")}</span>
              <IconPicker value={icon} onChange={setIcon} />
            </label>
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
              <span className="text-muted-foreground">{t("study.kind.name")}</span>
              <Input
                value={name}
                placeholder={t("study.kind.namePh")}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!idEdited) setId(slugifyKindId(e.target.value));
                }}
                className="h-8"
              />
            </label>
          </div>
          {touched && nameError && <p className="text-xs text-destructive">{nameError}</p>}

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">{t("study.kind.id")}</span>
            <Input
              value={id}
              onChange={(e) => {
                setIdEdited(true);
                setId(e.target.value);
              }}
              className="h-8 font-mono"
            />
            <span className="text-[11px] leading-snug text-muted-foreground/70">
              {t("study.kind.idHint")}
            </span>
          </label>
          {touched && idError && <p className="text-xs text-destructive">{idError}</p>}

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">{t("study.kind.guidance")}</span>
            <Textarea
              value={guidance}
              rows={5}
              placeholder={t("study.kind.guidancePh")}
              onChange={(e) => setGuidance(e.target.value)}
            />
            <span className="text-[11px] leading-snug text-muted-foreground/70">
              {t("study.kind.guidanceHint")}
            </span>
          </label>
        </div>
      </SheetContent>
    </Sheet>
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
