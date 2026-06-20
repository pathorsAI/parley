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
import { useReplayPlayer } from "./useReplayPlayer";
import {
  replayT,
  useExitReplay,
  useReplayPlayheadMs,
  useReplaySession,
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

  const segments = session?.segments ?? [];
  const speakerNames = session?.speakerNames ?? {};

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

      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize={42} minSize={24}>
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b px-4">
              <span className="text-xs font-medium text-foreground">{t("replay.transcript")}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {t("replay.maskedCount", { count: visibleCount, total: totalCount })}
              </span>
            </div>
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
