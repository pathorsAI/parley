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
}: Readonly<ScrubberProps>) {
  const draggingRef = useRef(false);
  const draftRef = useRef(valueMs);

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
    },
    [onCommit, onScrubEnd]
  );

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
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
      onPointerDown={handleDown}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
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
