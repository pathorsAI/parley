import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FileAudio, Folder, House, AudioLines, Mic, Plug } from "lucide-react";
import { useI18n } from "../../i18n";
import { isMac } from "../../lib/platform";
import { sampleManifest } from "../../lib/onboarding/sample";
import { OB_EASE, TYPE_MS_PER_CHAR, prefersReducedMotion } from "../../lib/onboarding/motion";
import { cn } from "@/lib/utils";
import { runTimeline, typingSchedule, type Beat } from "./timeline";

/**
 * The wizard's first screen, told by the UI itself: in about seven seconds the
 * pieces of Parley assemble inside the card — the recording pill, the
 * transcript typing itself with speaker names, the sidebar with a customer
 * folder that a recording flies into, and the MCP plug lighting up — each beat
 * with one caption line. It rests on its final frame; Next works at any time.
 * Real component styles (the titlebar pill, sidebar rows, a library row), not
 * illustrations. Under reduced motion it shows the final frame and all the
 * captions at once.
 */

export type IntroBeatId = "record" | "transcript" | "folder" | "mcp" | "ready";

export const INTRO_BEATS: readonly Beat<IntroBeatId>[] = [
  { id: "record", at: 0 },
  { id: "transcript", at: 900 },
  { id: "folder", at: 4100 },
  { id: "mcp", at: 5700 },
  { id: "ready", at: 6600 },
];
const ORDER = INTRO_BEATS.map((b) => b.id);

/** The transcript beat's typing budget (three lines, whatever the language). */
export const TRANSCRIPT_BUDGET_MS = 2800;
const LINE_GAP_MS = 220;
/** Inside the folder beat: when the recording card shows, and when it flies. */
const CARD_IN_MS = 300;
const CARD_FLY_AT_MS = 900;
const CARD_FLY_MS = 700;
/** Inside the MCP beat: the plug fades in, then lights up. */
const PLUG_LIGHT_MS = 350;

export function IntroStage() {
  const { t, language } = useI18n();
  const [reduced] = useState(prefersReducedMotion);
  const [beat, setBeat] = useState<IntroBeatId | null>(reduced ? "ready" : null);

  useEffect(() => {
    if (reduced) return;
    return runTimeline(INTRO_BEATS, (id) => setBeat(id));
  }, [reduced]);

  const reached = (id: IntroBeatId) => beat !== null && ORDER.indexOf(beat) >= ORDER.indexOf(id);
  const manifest = sampleManifest(language);
  const captionKey = {
    record: isMac() ? "onboarding.stage.record" : "onboarding.stage.record.windows",
    transcript: "onboarding.stage.transcript",
    folder: "onboarding.stage.folder",
    mcp: "onboarding.stage.mcp",
    ready: "onboarding.stage.ready",
  } as const;

  return (
    <div className="flex flex-col gap-2.5" aria-label={t("onboarding.stage.aria")} role="group">
      <div className="relative flex h-[204px] overflow-hidden rounded-lg border bg-background" data-testid="intro-stage">
        <MiniSidebar
          running={reached("folder")}
          instant={reduced}
          folderName={manifest.suggestion.folders[0]?.name ?? ""}
          cardTitle={manifest.suggestion.title}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-8 shrink-0 items-center justify-between border-b px-2.5">
            {reached("record") ? (
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full bg-recording/10 px-2.5 py-0.5 text-recording",
                  !reduced && "ob-scale-in"
                )}
              >
                <span aria-hidden className="ob-blink size-2 rounded-full bg-recording" />
                <span className="text-[11px] font-medium">{t("onboarding.stage.recording")}</span>
                <span className="font-display text-[12px] font-semibold tabular-nums">00:12</span>
              </span>
            ) : (
              <span />
            )}
            {reached("mcp") && <McpPlug instant={reduced} />}
          </div>
          <TranscriptLines
            running={reached("transcript")}
            instant={reduced}
            lines={manifest.segments.slice(0, 3).map((s) => ({
              speaker: manifest.speakers[s.speaker],
              me: s.speaker === "me",
              text: s.text,
            }))}
          />
        </div>
      </div>
      {reduced ? (
        <ul className="flex flex-col gap-0.5 text-sm text-muted-foreground">
          {ORDER.map((id) => (
            <li key={id}>{t(captionKey[id])}</li>
          ))}
        </ul>
      ) : (
        <p key={beat ?? "none"} aria-live="polite" className="ob-fade-in min-h-5 text-sm text-muted-foreground">
          {beat ? t(captionKey[beat]) : " "}
        </p>
      )}
    </div>
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
  lines,
}: Readonly<{
  running: boolean;
  instant: boolean;
  lines: { speaker: string; me: boolean; text: string }[];
}>) {
  const schedule = useMemo(
    () => typingSchedule(lines.map((l) => l.text.length), TRANSCRIPT_BUDGET_MS, LINE_GAP_MS, TYPE_MS_PER_CHAR),
    [lines]
  );
  const elapsed = useElapsed(running, instant, schedule.endMs + LINE_GAP_MS);

  return (
    <div className="flex min-h-0 flex-col gap-1.5 overflow-hidden px-3 py-2">
      {lines.map((line, i) => {
        const shown = Math.max(0, Math.floor((elapsed - schedule.starts[i]) / schedule.msPerChar));
        if (!running && !instant) return null;
        if (shown <= 0) return null;
        const done = shown >= line.text.length;
        return (
          <div key={i} className="flex flex-col">
            {/* The speaker is named once the line is in — the order a live
                transcript resolves it. */}
            <span
              className={cn(
                "h-3.5 text-[10px] font-semibold",
                line.me ? "text-primary" : "text-muted-foreground",
                done ? (instant ? "" : "ob-fade-in") : "invisible"
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

function MiniSidebar({
  running,
  instant,
  folderName,
  cardTitle,
}: Readonly<{ running: boolean; instant: boolean; folderName: string; cardTitle: string }>) {
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
  const slide = (i: number) =>
    instant ? {} : ({ className: "ob-slide-in", style: { animationDelay: `${i * 70}ms` } } as const);

  return (
    <>
      <div className="flex w-[118px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-1.5 py-2 text-sidebar-foreground">
        {(running || instant) && (
          <>
            {rows.map((r, i) => (
              <div
                key={r.label}
                {...slide(i)}
                className={cn(
                  slide(i).className,
                  "flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px]",
                  r.primary ? "font-medium text-primary" : ""
                )}
              >
                <span className={r.primary ? "" : "text-muted-foreground"}>{r.icon}</span>
                <span className="truncate">{r.label}</span>
              </div>
            ))}
            <div
              {...slide(3)}
              className={cn(slide(3).className, "mt-2 px-1.5 pb-0.5 text-[10px] font-semibold text-muted-foreground")}
            >
              {t("shell.folders")}
            </div>
            <div
              ref={folderRef}
              {...slide(6)}
              className={cn(
                slide(6).className,
                "flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px]",
                flash && "ob-flash"
              )}
            >
              <Folder className="size-3 text-muted-foreground" />
              <span className="truncate">{folderName}</span>
            </div>
          </>
        )}
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

function McpPlug({ instant }: Readonly<{ instant: boolean }>) {
  const [lit, setLit] = useState(instant);
  useLayoutEffect(() => {
    if (instant) return;
    const id = setTimeout(() => setLit(true), PLUG_LIGHT_MS);
    return () => clearTimeout(id);
  }, [instant]);
  return (
    <span
      data-lit={lit}
      className={cn(
        "ob-transition grid size-6 place-items-center rounded-full",
        !instant && "ob-fade-in",
        lit ? "bg-primary/10 text-primary ring-2 ring-primary/25" : "text-muted-foreground"
      )}
    >
      <Plug className="size-3.5" />
    </span>
  );
}
