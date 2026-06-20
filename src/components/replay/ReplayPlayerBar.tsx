import { useState } from "react";
import { Pause, Play, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatClock } from "../../lib/store";
import { runAllEvaluations } from "../../lib/evaluations/engine";
import { Scrubber } from "./Scrubber";
import type { ReplayPlayer } from "./useReplayPlayer";

interface ReplayPlayerBarProps {
  name: string;
  durationMs: number;
  player: ReplayPlayer;
  onExit: () => void;
  /** Localized strings (resolved by the parent via the replay i18n shim). */
  labels: {
    title: string;
    play: string;
    pause: string;
    playhead: string;
    evalHere: string;
    evaluating: string;
  };
}

/**
 * The replay header: transport controls, a draggable timeline, the current
 * time/duration, and the prominent "re-evaluate at this moment" action. All
 * seeking funnels through `player.seek`, which keeps audio + store playhead in
 * lockstep so masked evals/Ask run against exactly this moment.
 */
export function ReplayPlayerBar({
  name,
  durationMs,
  player,
  onExit,
  labels,
}: ReplayPlayerBarProps) {
  const [evaluating, setEvaluating] = useState(false);

  async function reEvaluate() {
    setEvaluating(true);
    try {
      await runAllEvaluations();
    } finally {
      setEvaluating(false);
    }
  }

  return (
    <div className="shrink-0 border-b">
      <div className="flex h-10 items-center gap-2 px-4">
        <span className="truncate text-xs font-medium text-foreground">{labels.title}</span>
        <span className="truncate text-[11px] text-muted-foreground">· {name}</span>
        <Button
          variant="default"
          size="sm"
          className="ml-auto h-7 px-2.5 text-[11px]"
          disabled={evaluating}
          onClick={() => void reEvaluate()}
        >
          <Sparkles className={`size-3 ${evaluating ? "animate-pulse" : ""}`} />
          {evaluating ? labels.evaluating : labels.evalHere}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={onExit}
          title={labels.title}
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex items-center gap-3 px-4 pb-3">
        <Button
          variant="outline"
          size="icon-sm"
          onClick={player.toggle}
          aria-label={player.playing ? labels.pause : labels.play}
          title={player.playing ? labels.pause : labels.play}
        >
          {player.playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </Button>

        <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
          {formatClock(player.playheadMs)}
        </span>

        <div className="min-w-0 flex-1">
          <Scrubber
            valueMs={player.playheadMs}
            durationMs={durationMs}
            ariaLabel={labels.playhead}
            onScrubStart={player.beginScrub}
            onScrubEnd={player.endScrub}
            onScrub={player.seek}
            onCommit={player.seek}
          />
        </div>

        <span className="w-10 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {formatClock(durationMs)}
        </span>
      </div>
    </div>
  );
}
