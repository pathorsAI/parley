import { useEffect, useMemo, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { speakerBadgeClass } from "../../lib/speakerColors";
import { speakerLabel, formatClock } from "../../lib/store";
import { cn } from "@/lib/utils";
import type { TranscriptSegment } from "../../lib/types";

interface ReplayTranscriptProps {
  segments: TranscriptSegment[];
  speakerNames: Record<string, string>;
  playheadMs: number;
  /** True while audio is playing — gates auto-scroll so we don't fight the user. */
  playing: boolean;
  /** Seek to a segment's start when its row is clicked. */
  onSeek: (ms: number) => void;
  emptyLabel: string;
}

/**
 * Replay transcript: each segment is a clickable row. The segment covering the
 * playhead is highlighted; segments that start after the playhead are greyed out
 * (the "masked future" the evals/Ask can't see). While playing, the active row
 * is kept in view; when paused we leave scroll alone so manual scrolling sticks.
 */
export function ReplayTranscript({
  segments,
  speakerNames,
  playheadMs,
  playing,
  onSeek,
  emptyLabel,
}: ReplayTranscriptProps) {
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const rows = useMemo(
    () =>
      segments
        .filter((s) => s.text.trim())
        .slice()
        .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs),
    [segments]
  );

  // Index of the segment that "owns" the playhead: the last one started.
  const activeId = useMemo(() => {
    let id: string | null = null;
    for (const r of rows) {
      if (r.startMs <= playheadMs) id = r.id;
      else break;
    }
    return id;
  }, [rows, playheadMs]);

  // Keep the active row visible while playing only.
  useEffect(() => {
    if (!playing || !activeId) return;
    rowRefs.current[activeId]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeId, playing]);

  if (rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-3xl flex-col gap-1 px-4 py-4">
        {rows.map((seg, i) => {
          const masked = seg.startMs > playheadMs;
          const active = seg.id === activeId;
          const showBadge = i === 0 || speakerLabel(seg, speakerNames) !== speakerLabel(rows[i - 1], speakerNames);
          return (
            <button
              key={seg.id}
              type="button"
              ref={(el) => {
                rowRefs.current[seg.id] = el;
              }}
              onClick={() => onSeek(seg.startMs)}
              className={cn(
                "group flex w-full select-text gap-2.5 rounded-md px-2 py-1.5 text-left text-sm leading-6 transition-colors",
                "hover:bg-muted/60",
                active && "bg-primary/10 ring-1 ring-primary/30",
                masked && "opacity-35"
              )}
            >
              <span className="mt-0.5 w-9 shrink-0 select-none text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                {formatClock(seg.startMs)}
              </span>
              <span className="min-w-0 flex-1">
                {showBadge && (
                  <span
                    className={cn(
                      "mr-1.5 inline-flex translate-y-[-1px] items-center rounded-md px-1.5 py-0.5 align-middle text-[10px] font-medium uppercase tracking-wide ring-1",
                      speakerBadgeClass(seg)
                    )}
                  >
                    {speakerLabel(seg, speakerNames)}
                  </span>
                )}
                <span className={active ? "text-foreground" : "text-foreground/90"}>{seg.text}</span>
              </span>
            </button>
          );
        })}
      </div>
    </ScrollArea>
  );
}
