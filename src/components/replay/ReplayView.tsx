import { useMemo } from "react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { WorkPanel } from "../WorkPanel";
import { EvaluationsPanel } from "../sidebar/EvaluationsPanel";
import { useI18n } from "../../i18n";
import { ReplayPlayerBar } from "./ReplayPlayerBar";
import { ReplayTranscript } from "./ReplayTranscript";
import { ReplaySpeakerTags } from "./ReplaySpeakerTags";
import { TimelineMarkers } from "./TimelineMarkers";
import { useReplayPlayer } from "./useReplayPlayer";
import { useTimelineAnalysis } from "./useTimelineAnalysis";
import { formatClock, useStore } from "../../lib/store";
import type { TimelineEvent } from "../../lib/types";
import {
  replayT,
  useExitReplay,
  useReplayPlayheadMs,
  useReplaySession,
  useReplayTimeline,
} from "./spine";

/**
 * The replay screen: play an uploaded recording, scrub to any moment, and re-run
 * evaluations / ask questions "as of" that moment. The store's playhead is the
 * source of truth; the eval engine and Ask already read a playhead-masked view
 * of the transcript (`visibleSegments`), so re-evaluating here automatically
 * only sees up-to-playhead transcript.
 *
 * Rendered only when `appMode === "replay"` (the parent app switches on that).
 */
export function ReplayView() {
  const { language } = useI18n();
  const t = (key: string, vars?: Record<string, string | number>) => replayT(language, key, vars);

  const session = useReplaySession();
  const playheadMs = useReplayPlayheadMs();
  const exitReplay = useExitReplay();
  const player = useReplayPlayer(session?.durationMs ?? 0);
  const timeline = useReplayTimeline();

  // Auto-run the whole-recording retro analysis once the session is loaded.
  useTimelineAnalysis();

  const segments = session?.segments ?? [];
  // Read the store's speakerNames (seeded from the session on enterReplay) rather
  // than the static session snapshot, so renaming a speaker re-renders the
  // transcript and stays in sync with what evals / Ask / the timeline analysis see.
  const speakerNames = useStore((s) => s.speakerNames);

  // Findings at or before the current playhead — "this moment's issues".
  const atMoment = useMemo(() => {
    const past = timeline.filter((e) => e.atMs <= playheadMs + 1500);
    return past.slice(-3).reverse();
  }, [timeline, playheadMs]);

  // Masked-count: how many segments are at/before the playhead vs total.
  const { visibleCount, totalCount } = useMemo(() => {
    const usable = segments.filter((s) => s.text.trim());
    return {
      visibleCount: usable.filter((s) => s.startMs <= playheadMs).length,
      totalCount: usable.length,
    };
  }, [segments, playheadMs]);

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {t("replay.empty")}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Hidden audio element — the player hook drives + observes it. */}
      <audio
        ref={player.audioRef}
        src={session.audioSrc}
        preload="metadata"
        onTimeUpdate={player.onTimeUpdate}
        onPlay={player.onPlay}
        onPause={player.onPause}
        onEnded={player.onEnded}
        className="hidden"
      />

      <ReplayPlayerBar
        name={session.name}
        durationMs={session.durationMs}
        player={player}
        onExit={exitReplay}
        labels={{
          title: t("replay.title"),
          play: t("replay.play"),
          pause: t("replay.pause"),
          playhead: t("replay.playhead"),
          evalHere: t("replay.evalHere"),
          evaluating: t("replay.evaluating"),
        }}
      />

      <TimelineMarkers
        durationMs={session.durationMs}
        playheadMs={playheadMs}
        onSeek={player.seek}
      />

      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize={42} minSize={24}>
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b px-4">
              <span className="text-xs font-medium text-foreground">{t("replay.transcript")}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {t("replay.maskedCount", { count: visibleCount, total: totalCount })}
              </span>
            </div>
            <ReplaySpeakerTags
              segments={segments}
              names={speakerNames}
              label={t("meeting.speakers")}
            />
            <div className="min-h-0 flex-1">
              <ReplayTranscript
                segments={segments}
                speakerNames={speakerNames}
                playheadMs={playheadMs}
                playing={player.playing}
                onSeek={player.seek}
                emptyLabel={t("replay.empty")}
              />
            </div>
            {atMoment.length > 0 && (
              <div className="shrink-0 border-t px-4 py-2">
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                  {t("timeline.atMoment")}
                </div>
                <ul className="flex flex-col gap-1">
                  {atMoment.map((e) => (
                    <MomentRow key={e.id} event={e} onSeek={player.seek} extraLabel={t("timeline.extra")} />
                  ))}
                </ul>
              </div>
            )}
            <div className="shrink-0 border-t px-4 py-1.5 text-[11px] leading-snug text-muted-foreground">
              {t("replay.maskedNote")}
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize={34} minSize={22}>
          <WorkPanel />
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize={24} minSize={18}>
          <EvaluationsPanel />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

const MOMENT_DOT: Record<TimelineEvent["severity"], string> = {
  info: "bg-sky-400",
  warn: "bg-amber-500",
  critical: "bg-red-500",
};

/** One compact "this moment" finding row; clicking it re-seeks to the moment. */
function MomentRow({
  event,
  onSeek,
  extraLabel,
}: {
  event: TimelineEvent;
  onSeek: (ms: number) => void;
  extraLabel: string;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSeek(event.atMs)}
        className="flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left hover:bg-muted/60"
      >
        <span className={`mt-1 size-2 shrink-0 rounded-full ${MOMENT_DOT[event.severity]}`} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {formatClock(event.atMs)}
            </span>
            <span className={`text-[11px] font-medium ${event.side === "me" ? "text-sky-400" : "text-amber-400"}`}>
              {event.title}
            </span>
            {event.source === "extra" && (
              <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">{extraLabel}</span>
            )}
          </span>
          <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{event.detail}</span>
        </span>
      </button>
    </li>
  );
}
