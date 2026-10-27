import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AudioLines, Check, FileAudio, Folder, House, Mic, Plug } from "lucide-react";
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
 * into a customer folder, the MCP plug lighting up. Only the current step's
 * part of the demo is at full strength, so there is one thing to look at. It
 * runs in about seven seconds and rests on its final frame; Next works at any
 * time. Real component styles (the titlebar pill, sidebar rows, a library
 * row), not illustrations. Under reduced motion it shows the final frame.
 */

export type IntroStepId = "record" | "transcript" | "folder" | "mcp";
export type IntroBeatId = "overview" | IntroStepId | "ready";

export const INTRO_STEPS: readonly IntroStepId[] = ["record", "transcript", "folder", "mcp"];

export const INTRO_BEATS: readonly Beat<IntroBeatId>[] = [
  // The row lands (~0.7 s) and holds a beat on its own before the demo starts.
  { id: "overview", at: 0 },
  { id: "record", at: 1200 },
  { id: "transcript", at: 2300 },
  { id: "folder", at: 4300 },
  { id: "mcp", at: 5600 },
  { id: "ready", at: 6800 },
];
const ORDER = INTRO_BEATS.map((b) => b.id);

/** How long each step lasts: the gap to the beat after it. */
export function stepDurationMs(id: IntroStepId): number {
  const i = ORDER.indexOf(id);
  return INTRO_BEATS[i + 1].at - INTRO_BEATS[i].at;
}

/** The transcript beat's typing budget (two lines, whatever the language). */
export const TRANSCRIPT_BUDGET_MS = 1600;
const TRANSCRIPT_LINES = 2;
const LINE_GAP_MS = 160;
/** Inside the folder beat: when the recording card shows, and when it flies. */
const CARD_IN_MS = 150;
const CARD_FLY_AT_MS = 500;
const CARD_FLY_MS = 600;
/** Inside the MCP beat: the plug lights up. */
const PLUG_LIGHT_MS = 200;
/** The overview row: each step lands this long after the one before. */
const OVERVIEW_STAGGER_MS = 90;

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
    <section className="flex flex-col gap-3" aria-label={t("onboarding.stage.aria")}>
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
          <div className="flex h-8 shrink-0 items-center justify-between border-b px-2.5">
            {reached("record") ? (
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
        </div>
      </div>

      <p key={beat} aria-live="polite" className={cn("min-h-5 text-sm text-muted-foreground", !reduced && "ob-fade-in")}>
        {t(CAPTION[beat])}
      </p>
    </section>
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
            className={cn("flex flex-col gap-1.5", !reduced && "ob-rise")}
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
    <div className={cn("flex min-h-0 flex-col gap-1.5 overflow-hidden px-3 py-2", className)}>
      {lines.map((line, i) => {
        const shown = Math.max(0, Math.floor((elapsed - schedule.starts[i]) / schedule.msPerChar));
        if (!running && !instant) return null;
        if (shown <= 0) return null;
        const done = shown >= line.text.length;
        return (
          <div key={line.id} className="flex flex-col">
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
            <span className="line-clamp-2 text-[11px] leading-snug text-foreground/90">
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
