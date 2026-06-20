import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { formatClock } from "../../lib/store";
import { cn } from "@/lib/utils";
import type { TimelineEvent } from "../../lib/types";
import { useI18n } from "../../i18n";
import {
  replayT,
  useReplayTimeline,
  useReplayTimelineError,
  useReplayTimelineStatus,
} from "./spine";
import { reanalyzeTimeline } from "./useTimelineAnalysis";

/** Severity → dot fill. Mirrors the info/warn/critical conventions used elsewhere. */
const SEVERITY_DOT: Record<TimelineEvent["severity"], string> = {
  info: "bg-sky-400",
  warn: "bg-amber-500",
  critical: "bg-red-500",
};

interface TimelineMarkersProps {
  durationMs: number;
  /** Current playhead — used to highlight at/near markers. */
  playheadMs: number;
  /** Seek the playhead (same path transcript clicks use). */
  onSeek: (ms: number) => void;
}

/** A marker is "near" the playhead within this window (ms). */
const NEAR_MS = 4000;

/**
 * Two-lane band of time-anchored retro findings, aligned to the scrubber's
 * 0..durationMs width. Top lane = THEM (對方提的), bottom lane = ME (我的問題).
 * Click a dot to scrub to that moment; the masked re-eval + Ask then take over.
 */
export function TimelineMarkers({ durationMs, playheadMs, onSeek }: TimelineMarkersProps) {
  const { language } = useI18n();
  const t = (key: string, vars?: Record<string, string | number>) => replayT(language, key, vars);

  const events = useReplayTimeline();
  const status = useReplayTimelineStatus();
  const error = useReplayTimelineError();
  const [hovered, setHovered] = useState<string | null>(null);

  const { them, me } = useMemo(
    () => ({
      them: events.filter((e) => e.side === "them"),
      me: events.filter((e) => e.side === "me"),
    }),
    [events]
  );

  const running = status === "running";

  return (
    <div className="shrink-0 border-b px-4 py-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-foreground">{t("timeline.title")}</span>
        <div className="flex items-center gap-2">
          {status === "done" && events.length > 0 && (
            <span className="text-[10px] tabular-nums text-muted-foreground/70">
              {t("timeline.count", { count: events.length })}
            </span>
          )}
          {running && <span className="text-[10px] text-muted-foreground">{t("timeline.analyzing")}</span>}
          {status === "error" && (
            <span
              className="max-w-[260px] truncate text-[10px] text-orange-500"
              title={error ?? undefined}
            >
              {t("timeline.failed", { error: error ?? "—" })}
            </span>
          )}
          <button
            type="button"
            onClick={() => reanalyzeTimeline()}
            disabled={running}
            className="flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
            title={t("timeline.reanalyze")}
          >
            <RefreshCw className={cn("size-3", running && "animate-spin")} />
            {t("timeline.reanalyze")}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Lane
          label={t("timeline.laneThem")}
          events={them}
          durationMs={durationMs}
          playheadMs={playheadMs}
          hovered={hovered}
          setHovered={setHovered}
          onSeek={onSeek}
          formatClock={formatClock}
          extraLabel={t("timeline.extra")}
          tooltipTime={t("timeline.atMoment")}
        />
        <Lane
          label={t("timeline.laneMe")}
          events={me}
          durationMs={durationMs}
          playheadMs={playheadMs}
          hovered={hovered}
          setHovered={setHovered}
          onSeek={onSeek}
          formatClock={formatClock}
          extraLabel={t("timeline.extra")}
          tooltipTime={t("timeline.atMoment")}
        />
      </div>

      {status === "done" && events.length === 0 && (
        <div className="mt-1 text-[10px] text-muted-foreground/70">{t("timeline.empty")}</div>
      )}
    </div>
  );
}

interface LaneProps {
  label: string;
  events: TimelineEvent[];
  durationMs: number;
  playheadMs: number;
  hovered: string | null;
  setHovered: (id: string | null) => void;
  onSeek: (ms: number) => void;
  formatClock: (ms: number) => string;
  extraLabel: string;
  tooltipTime: string;
}

function Lane({
  label,
  events,
  durationMs,
  playheadMs,
  hovered,
  setHovered,
  onSeek,
  formatClock,
  extraLabel,
  tooltipTime,
}: LaneProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 truncate text-right text-[10px] text-muted-foreground">{label}</span>
      <div className="relative h-5 min-w-0 flex-1 rounded bg-muted/40">
        {events.map((e) => {
          const pct = durationMs > 0 ? Math.max(0, Math.min(1, e.atMs / durationMs)) : 0;
          const near = Math.abs(e.atMs - playheadMs) <= NEAR_MS;
          const isHovered = hovered === e.id;
          return (
            <button
              key={e.id}
              type="button"
              onClick={() => onSeek(e.atMs)}
              onMouseEnter={() => setHovered(e.id)}
              onMouseLeave={() => setHovered(null)}
              className={cn(
                "absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full transition-transform hover:scale-125",
                SEVERITY_DOT[e.severity],
                // AI "extra" findings get a distinct ring outline.
                e.source === "extra" && "ring-2 ring-foreground/40 ring-offset-1 ring-offset-background",
                near && "scale-125",
                isHovered && "z-20"
              )}
              style={{ left: `${pct * 100}%` }}
              aria-label={`${formatClock(e.atMs)} ${e.title}`}
            >
              {isHovered && (
                <span
                  className={cn(
                    "pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 w-56 -translate-x-1/2 rounded-md border bg-popover px-2 py-1.5 text-left shadow-md",
                    "text-[11px] leading-snug text-popover-foreground"
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                      {tooltipTime} {formatClock(e.atMs)}
                    </span>
                    {e.source === "extra" && (
                      <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">{extraLabel}</span>
                    )}
                  </span>
                  <span className="mt-0.5 block font-medium">{e.title}</span>
                  <span className="mt-0.5 block text-muted-foreground">{e.detail}</span>
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
