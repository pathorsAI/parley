import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { seekTargetForKey } from "../../lib/replay/seek";
import { markGettingStarted } from "../../lib/onboarding/gettingStarted";
import { onTranscriptSeek } from "../../lib/onboarding/motion";

/** How long the playhead glides after a transcript-line click. */
const SEEK_EASE_MS = 500;
/** How long a ripple lives (matches .ob-ripple in index.css). */
const RIPPLE_MS = 700;

interface ScrubberProps {
  /** Current position in ms. */
  valueMs: number;
  /** Total length in ms. */
  durationMs: number;
  /** Live preview while dragging (not yet committed to audio). */
  onScrub: (ms: number) => void;
  /** Final value when the drag ends / a click lands. */
  onCommit: (ms: number) => void;
  onScrubStart: () => void;
  onScrubEnd: () => void;
  ariaLabel: string;
  /** Whether a seek here counts as the user learning replay (the Home
   *  checklist's "replayed" item). The ingest wizard's trim bar passes false. */
  countsAsReplay?: boolean;
}

/**
 * A custom pointer-driven timeline scrubber. Uses pointer capture so dragging
 * stays responsive even when the cursor leaves the bar. Reports a live value
 * during the drag and a committed value on release.
 */
export function Scrubber({
  valueMs,
  durationMs,
  onScrub,
  onCommit,
  onScrubStart,
  countsAsReplay = true,
  onScrubEnd,
  ariaLabel,
}: Readonly<ScrubberProps>) {
  const draggingRef = useRef(false);
  const draftRef = useRef(valueMs);
  const trackRef = useRef<HTMLDivElement | null>(null);

  // A transcript-line click moves the playhead here from somewhere else on
  // the page: let it glide there (drags and keys stay instant) and mark where
  // it landed with a ripple, so the eye follows the jump.
  const [easing, setEasing] = useState(false);
  const [ripples, setRipples] = useState<{ id: number; x: number }[]>([]);
  useEffect(() => {
    if (!countsAsReplay) return;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => {
      const id = setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
    };
    const off = onTranscriptSeek((ms) => {
      if (draggingRef.current || durationMs <= 0) return;
      const width = trackRef.current?.getBoundingClientRect().width ?? 0;
      const x = Math.max(0, Math.min(1, ms / durationMs)) * width;
      const id = performance.now();
      setEasing(true);
      setRipples((r) => [...r, { id, x }]);
      later(() => setEasing(false), SEEK_EASE_MS);
      later(() => setRipples((r) => r.filter((p) => p.id !== id)), RIPPLE_MS);
    });
    return () => {
      off();
      for (const t of timers) clearTimeout(t);
    };
  }, [countsAsReplay, durationMs]);

  const pct = durationMs > 0 ? Math.max(0, Math.min(1, valueMs / durationMs)) : 0;

  const handleDown = useCallback(
    () => {
      draggingRef.current = true;
      draftRef.current = valueMs;
      onScrubStart();
    },
    [onScrubStart, valueMs]
  );

  const handleUp = useCallback(
    () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      onCommit(draftRef.current);
      onScrubEnd();
      // A drag or click on the bar is the user seeking — the checklist's replay item.
      if (countsAsReplay) markGettingStarted("replayed");
    },
    [onCommit, onScrubEnd, countsAsReplay]
  );

  // The same seek keys the replay workbench binds window-wide, answered here
  // too because a range input that has focus swallows the arrows before the
  // shared listener ever sees them. Both routes go through `seekTargetForKey`,
  // so the slider and the workbench can't disagree about where "back ten
  // seconds" lands — and neither this file nor that one spells out a chord.
  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      const target = seekTargetForKey(e, valueMs, durationMs);
      if (target === null) return;
      e.preventDefault();
      onCommit(target);
    },
    [durationMs, onCommit, valueMs]
  );

  return (
    <div
      onPointerDown={handleDown}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      className={cn(
        "group relative flex h-5 w-full cursor-pointer touch-none items-center outline-none",
        "focus-visible:[&_[data-track]]:ring-1 focus-visible:[&_[data-track]]:ring-ring"
      )}
    >
      <div
        ref={trackRef}
        data-track
        className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn("absolute inset-y-0 left-0 rounded-full bg-primary", easing && "ob-seek-ease")}
          style={{ width: `${pct * 100}%` }}
        />
      </div>
      <div
        className={cn(
          "absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-background bg-primary shadow-sm transition-transform group-active:scale-110",
          easing && "ob-seek-ease"
        )}
        style={{ left: `${pct * 100}%` }}
      />
      {ripples.map((r) => (
        <span key={r.id} aria-hidden className="ob-ripple" style={{ left: r.x }} />
      ))}
      <input
        type="range"
        min={0}
        max={Math.max(0, Math.round(durationMs))}
        value={Math.round(valueMs)}
        aria-label={ariaLabel}
        onKeyDown={handleKey}
        onChange={(e) => {
          const next = Number(e.target.value);
          draftRef.current = next;
          onScrub(next);
        }}
        className="absolute inset-0 cursor-pointer opacity-0"
      />
    </div>
  );
}
