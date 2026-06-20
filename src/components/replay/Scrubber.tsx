import { useCallback, useRef } from "react";
import { cn } from "@/lib/utils";

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
  onScrubEnd,
  ariaLabel,
}: ScrubberProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const pct = durationMs > 0 ? Math.max(0, Math.min(1, valueMs / durationMs)) : 0;

  const msAtClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || durationMs <= 0) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = (clientX - rect.left) / rect.width;
      return Math.max(0, Math.min(1, ratio)) * durationMs;
    },
    [durationMs]
  );

  const handleDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      draggingRef.current = true;
      onScrubStart();
      onScrub(msAtClientX(e.clientX));
    },
    [msAtClientX, onScrub, onScrubStart]
  );

  const handleMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      onScrub(msAtClientX(e.clientX));
    },
    [msAtClientX, onScrub]
  );

  const handleUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      onCommit(msAtClientX(e.clientX));
      onScrubEnd();
    },
    [msAtClientX, onCommit, onScrubEnd]
  );

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 10_000 : 5_000;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        onCommit(Math.max(0, valueMs - step));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onCommit(Math.min(durationMs, valueMs + step));
      } else if (e.key === "Home") {
        e.preventDefault();
        onCommit(0);
      } else if (e.key === "End") {
        e.preventDefault();
        onCommit(durationMs);
      }
    },
    [durationMs, onCommit, valueMs]
  );

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={Math.round(durationMs)}
      aria-valuenow={Math.round(valueMs)}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      onKeyDown={handleKey}
      className={cn(
        "group relative flex h-5 w-full cursor-pointer touch-none items-center outline-none",
        "focus-visible:[&_[data-track]]:ring-1 focus-visible:[&_[data-track]]:ring-ring"
      )}
    >
      <div
        data-track
        className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-primary"
          style={{ width: `${pct * 100}%` }}
        />
      </div>
      <div
        className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-background bg-primary shadow-sm transition-transform group-active:scale-110"
        style={{ left: `${pct * 100}%` }}
      />
    </div>
  );
}
