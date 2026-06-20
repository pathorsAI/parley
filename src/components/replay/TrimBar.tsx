import { useCallback, useRef } from "react";
import type { ReplayTrim } from "../../lib/store";

/** Smallest keep-window we allow (so the two handles can't cross/touch). */
const MIN_GAP_MS = 1000;

interface TrimBarProps {
  durationMs: number;
  /** Current keep-window; null = keep everything (handles at the very ends). */
  trim: ReplayTrim | null;
  /** Emits the new window, or null when it covers the whole recording again. */
  onChange: (trim: ReplayTrim | null) => void;
  startLabel: string;
  endLabel: string;
}

/**
 * Two-handle trim bar over the recording's full width. Drag the left handle in to
 * cut the intro, the right handle in to cut the tail; everything outside the kept
 * window is dimmed (and excluded from the transcript + all analysis upstream).
 * Reuses the same client-x → ms mapping the scrubber uses.
 */
export function TrimBar({ durationMs, trim, onChange, startLabel, endLabel }: TrimBarProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef<"start" | "end" | null>(null);

  const startMs = trim?.startMs ?? 0;
  const endMs = trim?.endMs ?? durationMs;

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

  // Emit a window, collapsing "covers everything" back to null (= no trim).
  const emit = useCallback(
    (s: number, e: number) => {
      if (s <= 0 && e >= durationMs) onChange(null);
      else onChange({ startMs: Math.round(s), endMs: Math.round(e) });
    },
    [durationMs, onChange]
  );

  const onMove = useCallback(
    (ev: React.PointerEvent) => {
      if (!dragging.current) return;
      const ms = msAtClientX(ev.clientX);
      if (dragging.current === "start") emit(Math.min(ms, endMs - MIN_GAP_MS), endMs);
      else emit(startMs, Math.max(ms, startMs + MIN_GAP_MS));
    },
    [emit, endMs, msAtClientX, startMs]
  );

  const onUp = useCallback((ev: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = null;
    (ev.target as Element).releasePointerCapture?.(ev.pointerId);
  }, []);

  const nudge = useCallback(
    (which: "start" | "end", delta: number) => {
      if (which === "start") emit(Math.max(0, Math.min(startMs + delta, endMs - MIN_GAP_MS)), endMs);
      else emit(startMs, Math.min(durationMs, Math.max(endMs + delta, startMs + MIN_GAP_MS)));
    },
    [durationMs, emit, endMs, startMs]
  );

  const startPct = durationMs > 0 ? (startMs / durationMs) * 100 : 0;
  const endPct = durationMs > 0 ? (endMs / durationMs) * 100 : 100;

  return (
    <div
      ref={trackRef}
      className="relative h-5 w-full touch-none select-none"
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {/* base track */}
      <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-muted" />
      {/* trimmed head + tail (dimmed) */}
      <div
        className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-l-full bg-foreground/15"
        style={{ left: 0, width: `${startPct}%` }}
      />
      <div
        className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-r-full bg-foreground/15"
        style={{ left: `${endPct}%`, right: 0 }}
      />
      {/* kept window */}
      <div
        className="absolute top-1/2 h-1.5 -translate-y-1/2 bg-primary/40"
        style={{ left: `${startPct}%`, right: `${100 - endPct}%` }}
      />
      <Handle pct={startPct} label={startLabel} onDown={() => (dragging.current = "start")} onNudge={(d) => nudge("start", d)} />
      <Handle pct={endPct} label={endLabel} onDown={() => (dragging.current = "end")} onNudge={(d) => nudge("end", d)} />
    </div>
  );
}

function Handle({
  pct,
  label,
  onDown,
  onNudge,
}: {
  pct: number;
  label: string;
  onDown: () => void;
  onNudge: (deltaMs: number) => void;
}) {
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuenow={Math.round(pct)}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        (e.target as Element).setPointerCapture?.(e.pointerId);
        onDown();
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 10_000 : 5_000;
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          onNudge(-step);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          onNudge(step);
        }
      }}
      className="absolute top-1/2 h-4 w-2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-sm border border-background bg-primary shadow-sm outline-none transition-transform hover:scale-110 focus-visible:ring-1 focus-visible:ring-ring"
      style={{ left: `${pct}%` }}
    />
  );
}
