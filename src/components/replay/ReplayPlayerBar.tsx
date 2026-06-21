import { useState, type ReactNode } from "react";
import { Check, Loader2, Pause, Play, Scissors } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatClock, type ReplayTrim } from "../../lib/store";
import { Scrubber } from "./Scrubber";
import { TrimBar } from "./TrimBar";
import type { ReplayPlayer } from "./useReplayPlayer";

interface ReplayPlayerBarProps {
  name: string;
  durationMs: number;
  player: ReplayPlayer;
  /** Rendered top-right of the header (REPLAY mounts the Analyze menu here). */
  rightSlot?: ReactNode;
  /** Localized strings (resolved by the parent via the replay i18n shim). */
  labels: {
    title: string;
    play: string;
    pause: string;
    playhead: string;
    trim: string;
    trimApply: string;
    trimming: string;
    trimReset: string;
    /** Template with {start}/{end} placeholders. */
    trimKept: string;
    trimNote: string;
    trimStart: string;
    trimEnd: string;
  };
}

/**
 * The replay header: transport controls, a draggable timeline, and the trim
 * controls. Exit lives in the TitleBar; the playhead is for navigation only.
 *
 * Trim is a DESTRUCTIVE cut: drag the two handles to mark the range to KEEP, then
 * Apply — the kept audio is re-encoded to a new (shorter) file and the transcript,
 * findings, and action items are rebased onto its 0-based timeline; everything
 * outside is removed. Re-uploading the original restores it (cached). The draft
 * lives locally until Apply, so nothing happens until you confirm.
 */
export function ReplayPlayerBar({ name, durationMs, player, rightSlot, labels }: ReplayPlayerBarProps) {
  const [trimOpen, setTrimOpen] = useState(false);
  const [draft, setDraft] = useState<ReplayTrim | null>(null);
  const [trimming, setTrimming] = useState(false);

  const keptText =
    draft && labels.trimKept
      ? labels.trimKept.replace("{start}", formatClock(draft.startMs)).replace("{end}", formatClock(draft.endMs))
      : "";

  async function apply() {
    if (!draft || trimming) return;
    const d = draft;
    // Leave editing mode immediately; show a spinner in the header while the
    // audio re-encodes. Reopen only if the trim fails (draft preserved).
    setTrimOpen(false);
    setTrimming(true);
    try {
      const { trimRecording } = await import("../../lib/replay/trim");
      await trimRecording(d);
      setDraft(null);
    } catch (e) {
      console.error("[trim]", e);
      setTrimOpen(true);
    } finally {
      setTrimming(false);
    }
  }

  return (
    <div className="shrink-0 border-b">
      <div className="flex h-10 items-center gap-2 px-4">
        <span className="truncate text-xs font-medium text-foreground">{labels.title}</span>
        <span className="truncate text-[11px] text-muted-foreground">· {name}</span>
        {trimming && (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            {labels.trimming}
          </span>
        )}
        {rightSlot && <div className="ml-auto shrink-0">{rightSlot}</div>}
      </div>

      <div className="px-4 pb-3">
        <div className="flex items-center gap-3">
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

          {/* Toggle the trim handles. */}
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn("shrink-0 text-muted-foreground hover:text-foreground", trimOpen && "text-primary")}
            aria-pressed={trimOpen}
            onClick={() => setTrimOpen((o) => !o)}
            title={labels.trim}
          >
            <Scissors className="size-4" />
          </Button>
        </div>

        {trimOpen && (
          <>
            <div className="mt-2 flex items-center gap-3">
              <span className="w-10 shrink-0 text-right text-[10px] text-muted-foreground">{labels.trim}</span>
              <div className="min-w-0 flex-1">
                <TrimBar
                  durationMs={durationMs}
                  trim={draft}
                  onChange={setDraft}
                  startLabel={labels.trimStart}
                  endLabel={labels.trimEnd}
                />
              </div>
              <Button
                size="sm"
                className="h-7 shrink-0 gap-1 px-2 text-[11px]"
                disabled={!draft || trimming}
                onClick={apply}
                title={labels.trimApply}
              >
                {trimming ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                {labels.trimApply}
              </Button>
              <button
                type="button"
                onClick={() => setDraft(null)}
                disabled={!draft || trimming}
                className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-30"
              >
                {labels.trimReset}
              </button>
            </div>
            <div className="mt-1 flex items-center gap-2 pl-[52px] text-[10px] text-muted-foreground/70">
              {draft ? <span className="tabular-nums text-primary/80">{keptText}</span> : null}
              <span>{labels.trimNote}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
