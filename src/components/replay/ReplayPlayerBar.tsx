import { useState } from "react";
import { AlertTriangle, Check, Download, Loader2, Pause, Play, Scissors } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatClock, type ReplayTrim } from "../../lib/store";
import { Scrubber } from "./Scrubber";
import { TrimBar } from "./TrimBar";
import type { ReplayPlayer } from "./useReplayPlayer";

interface ReplayPlayerBarProps {
  durationMs: number;
  player: ReplayPlayer;
  /** No audio file on this computer: say so instead of a play button that
   *  can't do anything. */
  audioMissing?: boolean;
  /** Save the recording's audio to a user-chosen folder (Tauri only; omit to hide). */
  onExport?: () => void;
  /** Localized strings (resolved by the parent via the replay i18n shim). */
  labels: {
    play: string;
    pause: string;
    playhead: string;
    exportAudio: string;
    trim: string;
    trimApply: string;
    trimming: string;
    trimReset: string;
    /** Template with {start}/{end} placeholders. */
    trimKept: string;
    trimNote: string;
    trimStart: string;
    trimEnd: string;
    /** "No audio file for this recording on this computer". */
    audioMissing: string;
    /** Shown while the decode fallback runs. */
    audioRepairing: string;
    /** "This recording's audio cannot be played (…)", already filled in; "" when it can. */
    audioUnplayable: string;
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
export function ReplayPlayerBar({
  durationMs,
  player,
  audioMissing = false,
  onExport,
  labels,
}: Readonly<ReplayPlayerBarProps>) {
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
      <div className="px-4 pb-3 pt-3">
        <div className="flex items-center gap-3">
          {audioMissing ? (
            <span
              className="flex size-8 shrink-0 items-center justify-center text-muted-foreground"
              title={labels.audioMissing}
            >
              <AlertTriangle className="size-4" />
            </span>
          ) : (
            <Button
              variant="outline"
              size="icon-sm"
              onClick={player.toggle}
              aria-label={player.playing ? labels.pause : labels.play}
              title={player.playing ? labels.pause : labels.play}
            >
              {player.playing ? <Pause className="size-4" /> : <Play className="size-4" />}
            </Button>
          )}

          <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
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

          <span className="w-10 shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {formatClock(durationMs)}
          </span>

          {/* Save the recording's audio out to a folder of the user's choosing. */}
          {onExport && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              onClick={onExport}
              aria-label={labels.exportAudio}
              title={labels.exportAudio}
            >
              <Download className="size-4" />
            </Button>
          )}

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

          {/* Decoding the recording to WAV because the webview couldn't play it. */}
          {player.repairing && (
            <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {labels.audioRepairing}
            </span>
          )}

          {/* Trim re-encode progress (the destructive cut runs in the background). */}
          {trimming && (
            <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {labels.trimming}
            </span>
          )}
        </div>

        <AudioNotice audioMissing={audioMissing} labels={labels} />

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

/** Why the recording won't play, under the transport row — missing on this
 *  computer, or a file neither the webview nor the decode fallback could play. */
function AudioNotice({
  audioMissing,
  labels,
}: Readonly<{ audioMissing: boolean; labels: ReplayPlayerBarProps["labels"] }>) {
  const text = audioMissing ? labels.audioMissing : labels.audioUnplayable;
  if (!text) return null;
  return (
    <output
      className={cn(
        "mt-2 flex items-center gap-1.5 text-[11px]",
        audioMissing ? "text-muted-foreground" : "text-danger-foreground",
      )}
    >
      <AlertTriangle className="size-3 shrink-0" />
      {text}
    </output>
  );
}
