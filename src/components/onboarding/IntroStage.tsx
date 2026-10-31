import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AudioLines, Check, FileAudio, Folder, House, Mic, Plug, RotateCcw, Square } from "lucide-react";
import { useI18n } from "../../i18n";
import type { TranslationKey } from "../../i18n/messages";
import { sampleManifest } from "../../lib/onboarding/sample";
import { OB_EASE, TYPE_MS_PER_CHAR, prefersReducedMotion } from "../../lib/onboarding/motion";
import { cn } from "@/lib/utils";
import { runTimeline, typingSchedule, type Beat } from "./timeline";

/**
 * The wizard's first screen: Parley in four steps — record, transcribe, file,
 * hand to AI. The four steps land first as a row and hold, then the demo walks
 * through them one at a time while the row tracks where it is: the recording
 * pill, two transcript lines typing with speaker names, a recording flying
 * into a customer folder, then the meeting over: the titlebar's report /
 * replay tabs replace the recording pill, the report's key points and action
 * items fill in, and the MCP plug lights up. Only the current step's
 * part of the demo is at full strength, so there is one thing to look at. It
 * runs in about eleven seconds and rests on its final frame, where Replay
 * runs it again from the start; Next works at any time. Real component styles (the titlebar pill, sidebar rows, a library
 * row), not illustrations. Under reduced motion it shows the final frame.
 */

export type IntroStepId = "record" | "transcript" | "folder" | "mcp";
export type IntroBeatId = "overview" | IntroStepId | "ready";

export const INTRO_STEPS: readonly IntroStepId[] = ["record", "transcript", "folder", "mcp"];

export const INTRO_BEATS: readonly Beat<IntroBeatId>[] = [
  // The row lands (~1 s) and holds a beat on its own before the demo starts.
  { id: "overview", at: 0 },
  { id: "record", at: 1800 },
  { id: "transcript", at: 3400 },
  { id: "folder", at: 6400 },
  { id: "mcp", at: 8300 },
  { id: "ready", at: 11000 },
];
const ORDER = INTRO_BEATS.map((b) => b.id);

/** How long each step lasts: the gap to the beat after it. */
export function stepDurationMs(id: IntroStepId): number {
  const i = ORDER.indexOf(id);
  return INTRO_BEATS[i + 1].at - INTRO_BEATS[i].at;
}

/** The transcript beat's typing budget (two lines, whatever the language). */
export const TRANSCRIPT_BUDGET_MS = 2400;
const TRANSCRIPT_LINES = 2;
const LINE_GAP_MS = 240;
/** Inside the folder beat: when the recording card shows, and when it flies. */
const CARD_IN_MS = 225;
const CARD_FLY_AT_MS = 750;
const CARD_FLY_MS = 900;
/** Inside the MCP beat: the plug lights up, and the report's lines come in
 *  one after another. */
const PLUG_LIGHT_MS = 300;
const REPORT_LINE_AT_MS = 350;
const REPORT_LINE_STAGGER_MS = 300;
/** The overview row: each step lands this long after the one before. */
const OVERVIEW_STAGGER_MS = 135;

const STEP_LABEL: Record<IntroStepId, TranslationKey> = {
  record: "onboarding.stage.step.record",
  transcript: "onboarding.stage.step.transcript",
  folder: "onboarding.stage.step.folder",
  mcp: "onboarding.stage.step.mcp",
};
const CAPTION: Record<IntroBeatId, TranslationKey> = {
  overview: "onboarding.stage.overview",
  record: "onboarding.stage.record",
  transcript: "onboarding.stage.transcript",
  folder: "onboarding.stage.folder",
  mcp: "onboarding.stage.mcp",
  ready: "onboarding.stage.ready",
};

export function IntroStage() {
  // Each run is a fresh mount: every part of the demo (typing, the flying
  // card, the plug) starts from nothing again.
  const [run, setRun] = useState(0);
  return <IntroDemo key={run} onReplay={() => setRun((n) => n + 1)} />;
}

function IntroDemo({ onReplay }: Readonly<{ onReplay: () => void }>) {
  const { t, language } = useI18n();
  const [reduced] = useState(prefersReducedMotion);
  const [beat, setBeat] = useState<IntroBeatId>(reduced ? "ready" : "overview");

  useEffect(() => {
    if (reduced) return;
    return runTimeline(INTRO_BEATS, (id) => setBeat(id));
  }, [reduced]);

  const reached = (id: IntroBeatId) => ORDER.indexOf(beat) >= ORDER.indexOf(id);
  // One part of the demo at full strength: the current step's. Parts already
  // shown step back; at rest (ready) everything is back to full.
  const focus = (id: IntroStepId) =>
    cn("ob-transition", beat !== "ready" && beat !== id && reached(id) && "opacity-40");
  const manifest = sampleManifest(language);

  return (
    <section className="flex flex-col gap-4" aria-label={t("onboarding.stage.aria")}>
      <StepRow beat={beat} reduced={reduced} />

      <div className="relative flex h-[184px] overflow-hidden rounded-lg border bg-background" data-testid="intro-stage">
        <MiniSidebar
          running={reached("folder")}
          instant={reduced}
          className={focus("folder")}
          highlight={beat === "folder"}
          folderName={manifest.suggestion.folders[0]?.name ?? ""}
          cardTitle={manifest.suggestion.title}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-[41px] shrink-0 items-center justify-between border-b px-2.5">
            {reached("mcp") ? (
              // The meeting is over: the titlebar's report / replay switch.
              <span className={cn("flex items-center gap-0.5 rounded-md bg-muted p-0.5", !reduced && "ob-fade-in")}>
                <span className="rounded-[5px] bg-background px-2 py-0.5 text-[10px] font-medium text-foreground shadow-sm">
                  {t("study.report")}
                </span>
                <span className="px-2 py-0.5 text-[10px] font-medium text-muted-foreground">{t("study.replay")}</span>
              </span>
            ) : reached("record") ? (
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full bg-recording/10 px-2.5 py-0.5 text-recording",
                  !reduced && "ob-scale-in",
                  focus("record"),
                )}
              >
                <span aria-hidden className="ob-blink size-2 rounded-full bg-recording" />
                <span className="text-[11px] font-medium">{t("onboarding.stage.recording")}</span>
                <span className="font-display text-[12px] font-semibold tabular-nums">00:12</span>
              </span>
            ) : (
              <span />
            )}
            <McpPlug lit={reached("mcp")} instant={reduced} />
          </div>
          {reached("mcp") ? (
            <ReportPreview
              instant={reduced}
              points={manifest.findings.slice(0, 2).map((f) => f.title)}
              actions={manifest.actionItems.slice(0, 2).map((a) => a.text)}
            />
          ) : (
            <TranscriptLines
              running={reached("transcript")}
              instant={reduced}
              className={focus("transcript")}
              lines={manifest.segments.slice(0, TRANSCRIPT_LINES).map((s) => ({
                id: `${s.speaker}-${s.startMs}`,
                speaker: manifest.speakers[s.speaker],
                me: s.speaker === "me",
                text: s.text,
              }))}
            />
          )}
        </div>
      </div>

      <div className="flex min-h-5 items-center justify-between gap-3">
        <p key={beat} aria-live="polite" className={cn("text-sm text-muted-foreground", !reduced && "ob-fade-in")}>
          {t(CAPTION[beat])}
        </p>
        {/* Under reduced motion the demo is its final frame: nothing to replay. */}
        {beat === "ready" && !reduced && (
          <button
            type="button"
            onClick={onReplay}
            className="ob-fade-in -my-0.5 inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
          >
            <RotateCcw className="size-3" />
            {t("onboarding.stage.replay")}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * The welcome screen's backdrop, as drawn in Figma: thirteen equal columns,
 * each a bar centred on the dialog's top edge that fades from the dialog's
 * background to blue and back, tallest at the sides. Decoration only — the
 * colours are the artwork's, not theme tokens. `inset` is the bar's top and
 * bottom inset as a share of the 398px strip; `alpha` the bar's own opacity.
 */
const HERO_BARS: readonly { inset: number; color: string; alpha?: number }[] = [
  { inset: 0, color: "#1469d4" },
  { inset: 11.01, color: "#1979da" },
  { inset: 19.07, color: "#1d86e0" },
  { inset: 26.82, color: "#2191e4" },
  { inset: 31.16, color: "#2191e4", alpha: 0.9 },
  { inset: 38.45, color: "#2aacef", alpha: 0.8 },
  { inset: 42.48, color: "#2db6f3", alpha: 0.7 },
  { inset: 38.45, color: "#2aacef", alpha: 0.8 },
  { inset: 31.16, color: "#259de9", alpha: 0.9 },
  { inset: 26.82, color: "#2191e4" },
  { inset: 19.07, color: "#1d86e0" },
  { inset: 11.01, color: "#1979da" },
  { inset: 0, color: "#1469d4" },
];

const withAlpha = (color: string, alpha: number) => `color-mix(in srgb, ${color} ${alpha * 100}%, transparent)`;

/** Sits in a dialog that sets `--ob-hero-bg` to its own background. */
export function IntroHero() {
  const width = 100 / HERO_BARS.length;
  return (
    <div aria-hidden className="pointer-events-none absolute top-[-198px] left-0 h-[398px] w-full opacity-80">
      {HERO_BARS.map(({ inset, color, alpha = 1 }, i) => {
        const edge = withAlpha("var(--ob-hero-bg)", alpha);
        return (
          <div
            key={`${i}-${color}`}
            className="absolute"
            style={{
              left: `${i * width}%`,
              width: `${width}%`,
              top: `${inset}%`,
              bottom: `${inset}%`,
              background: `linear-gradient(180deg, ${edge} 0%, ${withAlpha(color, alpha)} 50%, ${edge} 100%)`,
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * The four steps as a row, each just a label over a progress bar: upcoming
 * (muted), current (blue, its bar fills over the step), done (checked, full). It lands first, on its own, before the demo starts.
 */
function StepRow({ beat, reduced }: Readonly<{ beat: IntroBeatId; reduced: boolean }>) {
  const { t } = useI18n();
  const at = ORDER.indexOf(beat);
  return (
    <ol className="grid grid-cols-4 gap-3">
      {INTRO_STEPS.map((id, i) => {
        const state = beat === id ? "current" : at > ORDER.indexOf(id) ? "done" : "upcoming";
        return (
          <li
            key={id}
            aria-current={state === "current" ? "step" : undefined}
            className={cn("flex flex-col gap-2.5", !reduced && "ob-rise")}
            style={reduced ? undefined : { animationDelay: `${i * OVERVIEW_STAGGER_MS}ms` }}
          >
            <span className="flex items-center gap-1.5 text-xs font-medium">
              <span
                className={cn(
                  "ob-transition grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-semibold tabular-nums",
                  state === "upcoming" ? "bg-muted text-muted-foreground" : "bg-primary text-primary-foreground",
                )}
              >
                {state === "done" ? <Check className="size-2.5" strokeWidth={3} /> : i + 1}
              </span>
              <span
                className={cn(
                  "ob-transition truncate",
                  state === "current" && "text-primary",
                  state === "upcoming" && "text-muted-foreground",
                )}
              >
                {t(STEP_LABEL[id])}
              </span>
            </span>
            <span className="h-1 overflow-hidden rounded-full bg-muted">
              {state !== "upcoming" && (
                <span
                  className={cn("block h-full rounded-full bg-primary", state === "current" && !reduced && "ob-progress")}
                  style={
                    state === "current" && !reduced
                      ? ({ "--ob-progress-ms": `${stepDurationMs(id)}ms` } as CSSProperties)
                      : undefined
                  }
                />
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** ms since `running` turned true, ticking until `untilMs`; Infinity when instant. */
function useElapsed(running: boolean, instant: boolean, untilMs: number): number {
  const [elapsed, setElapsed] = useState(instant ? Number.POSITIVE_INFINITY : 0);
  useEffect(() => {
    if (instant || !running) return;
    const t0 = performance.now();
    const id = setInterval(() => {
      const e = performance.now() - t0;
      setElapsed(e);
      if (e >= untilMs) clearInterval(id);
    }, TYPE_MS_PER_CHAR);
    return () => clearInterval(id);
  }, [running, instant, untilMs]);
  return elapsed;
}

function TranscriptLines({
  running,
  instant,
  className,
  lines,
}: Readonly<{
  running: boolean;
  instant: boolean;
  className?: string;
  lines: { id: string; speaker: string; me: boolean; text: string }[];
}>) {
  const schedule = useMemo(
    () => typingSchedule(lines.map((l) => l.text.length), TRANSCRIPT_BUDGET_MS, LINE_GAP_MS, TYPE_MS_PER_CHAR),
    [lines]
  );
  const elapsed = useElapsed(running, instant, schedule.endMs + LINE_GAP_MS);

  return (
    <div className={cn("flex min-h-0 flex-col gap-2 overflow-hidden px-3 py-2.5", className)}>
      {lines.map((line, i) => {
        const shown = Math.max(0, Math.floor((elapsed - schedule.starts[i]) / schedule.msPerChar));
        if (!running && !instant) return null;
        if (shown <= 0) return null;
        const done = shown >= line.text.length;
        return (
          <div key={line.id} className="flex flex-col gap-0.5">
            {/* The speaker is named once the line is in — the order a live
                transcript resolves it. */}
            <span
              className={cn(
                "h-3.5 text-[10px] font-semibold",
                line.me ? "text-primary" : "text-muted-foreground",
                speakerRevealClass(done, instant)
              )}
            >
              {line.speaker}
            </span>
            <span className="line-clamp-2 text-[11px] leading-snug text-foreground/70">
              {line.text.slice(0, shown)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** The speaker name hides while its line types, then fades in (or just shows when instant). */
function speakerRevealClass(done: boolean, instant: boolean): string {
  if (!done) return "invisible";
  return instant ? "" : "ob-fade-in";
}

/**
 * The app's sidebar, there from the start (it is the frame, not a step). In
 * the folder step a recording card shows and flies into the customer folder,
 * which flashes as it lands.
 */
function MiniSidebar({
  running,
  instant,
  className,
  highlight,
  folderName,
  cardTitle,
}: Readonly<{
  running: boolean;
  instant: boolean;
  className?: string;
  highlight: boolean;
  folderName: string;
  cardTitle: string;
}>) {
  const { t } = useI18n();
  const [card, setCard] = useState<"hidden" | "shown" | "filed">(instant ? "filed" : "hidden");
  const [flash, setFlash] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const folderRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!running || instant) return;
    const timers = [
      setTimeout(() => setCard("shown"), CARD_IN_MS),
      setTimeout(() => {
        const from = cardRef.current;
        const to = folderRef.current;
        if (!from || !to) return setCard("filed");
        const a = from.getBoundingClientRect();
        const b = to.getBoundingClientRect();
        const scale = Math.max(0.2, Math.min(1, b.width / a.width));
        const anim = from.animate(
          [
            { transform: "translate(0, 0) scale(1)", opacity: 1 },
            {
              transform: `translate(${b.left - a.left}px, ${b.top + b.height / 2 - a.top - (a.height * scale) / 2}px) scale(${scale})`,
              opacity: 0.15,
            },
          ],
          { duration: CARD_FLY_MS, easing: OB_EASE, fill: "forwards" }
        );
        anim.onfinish = () => {
          setCard("filed");
          setFlash(true);
        };
      }, CARD_FLY_AT_MS),
    ];
    return () => timers.forEach(clearTimeout);
  }, [running, instant]);

  const rows = [
    { icon: <Mic className="size-3" />, label: t("titlebar.startMeeting"), primary: true },
    { icon: <House className="size-3" />, label: t("home.title") },
    { icon: <AudioLines className="size-3" />, label: t("library.all") },
  ];

  return (
    <>
      <div
        className={cn(
          "flex w-[118px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-1.5 py-2 text-sidebar-foreground",
          className,
        )}
      >
        {rows.map((r) => (
          <div
            key={r.label}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px]",
              r.primary ? "font-medium text-primary" : "",
            )}
          >
            <span className={r.primary ? "" : "text-muted-foreground"}>{r.icon}</span>
            <span className="truncate">{r.label}</span>
          </div>
        ))}
        <div className="mt-2 px-1.5 pb-0.5 text-[10px] font-semibold text-muted-foreground">{t("shell.folders")}</div>
        <div
          ref={folderRef}
          className={cn(
            "ob-transition flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px]",
            highlight && "bg-primary/10 text-primary",
            flash && "ob-flash",
          )}
        >
          <Folder className={cn("size-3", !highlight && "text-muted-foreground")} />
          <span className="truncate">{folderName}</span>
        </div>
      </div>
      {card === "shown" && (
        // A library row, lifted off the list: the recording that gets filed.
        <div
          ref={cardRef}
          className="ob-scale-in absolute bottom-3 right-3 z-10 flex max-w-[230px] items-center gap-1.5 rounded-md border bg-background px-2 py-1.5 text-[11px] font-medium shadow-sm"
        >
          <FileAudio className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{cardTitle}</span>
        </div>
      )}
    </>
  );
}

/** The MCP plug: there from the start, greyed, and lit in the hand-off step. */
function McpPlug({ lit, instant }: Readonly<{ lit: boolean; instant: boolean }>) {
  const [on, setOn] = useState(instant && lit);
  useLayoutEffect(() => {
    if (!lit) return;
    if (instant) return setOn(true);
    const id = setTimeout(() => setOn(true), PLUG_LIGHT_MS);
    return () => clearTimeout(id);
  }, [lit, instant]);
  return (
    <span
      data-lit={on}
      className={cn(
        "ob-transition grid size-6 place-items-center rounded-full",
        on ? "bg-primary/10 text-primary ring-2 ring-primary/25" : "text-muted-foreground/50"
      )}
    >
      <Plug className="size-3.5" />
    </span>
  );
}


/**
 * The report a meeting ends on, cut down: its key points and action items
 * under the report page's own section headings, lines coming in one after
 * another in reading order. Rests on its final frame.
 */
function ReportPreview({
  instant,
  points,
  actions,
}: Readonly<{ instant: boolean; points: string[]; actions: string[] }>) {
  const { t } = useI18n();
  const total = points.length + actions.length;
  const elapsed = useElapsed(true, instant, REPORT_LINE_AT_MS + total * REPORT_LINE_STAGGER_MS);
  const shown = instant ? total : Math.floor((elapsed - REPORT_LINE_AT_MS) / REPORT_LINE_STAGGER_MS) + 1;
  const rows = [
    ...points.map((text) => ({ text, action: false })),
    ...actions.map((text) => ({ text, action: true })),
  ];

  const row = (r: { text: string; action: boolean }, i: number) =>
    i < shown && (
      <p
        key={r.text}
        className={cn("flex items-start gap-1.5 text-[11px] leading-snug text-foreground/80", !instant && "ob-rise")}
      >
        {r.action ? (
          <Square className="mt-px size-3 shrink-0 text-muted-foreground" />
        ) : (
          <span aria-hidden className="mt-[5px] size-1 shrink-0 rounded-full bg-foreground/40" />
        )}
        <span className="line-clamp-1">{r.text}</span>
      </p>
    );

  return (
    <div className={cn("flex min-h-0 flex-col gap-2 overflow-hidden px-3 py-2.5", !instant && "ob-fade-in")}>
      <section className="flex flex-col gap-1">
        <h3 className="text-[10px] font-semibold text-muted-foreground">{t("study.brief")}</h3>
        {rows.slice(0, points.length).map((r, i) => row(r, i))}
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="text-[10px] font-semibold text-muted-foreground">{t("actionItems.title")}</h3>
        {rows.slice(points.length).map((r, i) => row(r, points.length + i))}
      </section>
    </div>
  );
}
