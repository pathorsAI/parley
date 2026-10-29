import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isTauri } from "../../lib/tauriEvents";
import { AUDIO_LEVEL_EVENT, listenEvent, type AudioLevelPayload } from "../../lib/ipc/events";
import { cn } from "@/lib/utils";

/** One bar per this many ms while recording. */
const SAMPLE_MS = 70;
/** A bar and the gap after it, in px. */
const BAR_PX = 2;
const GAP_PX = 3;
const STEP_PX = BAR_PX + GAP_PX;
/** The playhead walks right until here (share of the width), then the bars scroll. */
const PLAYHEAD_STOP = 0.5;
/** Below this a bar is a dot on the line: silence. */
const MIN_BAR = 0.06;
/** Ordinary speech should reach most of the track's height, as in the design. */
const GAIN = 1.8;

/**
 * The mic check's level as a recording track: thin blue bars for what has
 * been said, a dashed line for the rest, and a blue playhead where the
 * recording is now. Fed by the backend `audio://level` event for `source`
 * (sqrt-mapped, as in LevelMeter, since speech peaks are small, then
 * amplified so normal speech fills the track). The playhead
 * starts at the left edge and walks right as the bars come in; once it
 * reaches the middle it stays and the bars scroll past it. While `running` is
 * off the track holds what it last recorded; turning it on again starts afresh.
 */
export function WaveformTrack({
  source,
  running,
  className,
}: Readonly<{ source: string; running: boolean; className?: string }>) {
  const [bars, setBars] = useState<number[]>([]);
  const [width, setWidth] = useState(0);
  const box = useRef<HTMLDivElement | null>(null);
  // The loudest level since the last bar, so a short peak still shows.
  const peak = useRef(0);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!running || !isTauri()) return;
    setBars([]);
    peak.current = 0;
    // listen() resolves async: drop the subscription on resolution when the
    // cleanup won the race (see LevelMeter).
    let alive = true;
    let unlisten: (() => void) | undefined;
    listenEvent<AudioLevelPayload>(AUDIO_LEVEL_EVENT, (e) => {
      if (e.payload.source === source) peak.current = Math.max(peak.current, e.payload.level);
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    const id = setInterval(() => {
      const level = Math.min(1, Math.sqrt(peak.current) * GAIN);
      peak.current = 0;
      // Keep a little more than fits, so a wider window never shows a gap.
      setBars((prev) => [...prev, level].slice(-400));
    }, SAMPLE_MS);
    return () => {
      alive = false;
      unlisten?.();
      clearInterval(id);
    };
  }, [running, source]);

  const playheadX = Math.min(bars.length * STEP_PX, Math.floor(width * PLAYHEAD_STOP));
  const shown = bars.slice(-Math.max(0, Math.floor(playheadX / STEP_PX)));

  return (
    <div ref={box} aria-hidden className={cn("relative overflow-hidden", className)}>
      <span className="absolute inset-x-0 top-1/2 border-t border-dashed border-[#e6e6e6] dark:border-border" />
      <div className="absolute inset-y-0 left-0 flex items-center justify-end" style={{ width: playheadX, gap: GAP_PX }}>
        {shown.map((level, i) => (
          <span
            // Bars only ever shift left by one, so the position is a stable key.
            key={i}
            className="shrink-0 rounded-full bg-primary"
            style={{ width: BAR_PX, height: `${Math.max(MIN_BAR, level) * 100}%` }}
          />
        ))}
      </div>
      <span className="absolute top-1/2 h-3/4 w-0.5 -translate-y-1/2 rounded-full bg-primary" style={{ left: playheadX }} />
    </div>
  );
}
