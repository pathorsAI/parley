import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { formatClock } from "../../lib/store";
import { cn } from "@/lib/utils";
import type { TimelineEvent } from "../../lib/types";
import { useI18n } from "../../i18n";

/** Severity → dot fill. Mirrors the info/warn/critical conventions used elsewhere. */
const SEVERITY_DOT: Record<TimelineEvent["severity"], string> = {
  info: "bg-sky-400",
  warn: "bg-amber-500",
  critical: "bg-red-500",
};

/** A marker is "near" the playhead within this window (ms). */
const NEAR_MS = 4000;

interface AnalysisTimelineProps {
  findings: TimelineEvent[];
  status: "idle" | "running" | "done" | "error";
  error?: string | null;
  /** Axis width in ms — session.durationMs (replay) or the growing elapsed time (live). */
  axisMaxMs: number;
  /** Current playhead/elapsed marker, for near/at highlighting (optional). */
  playheadMs?: number;
  /** The finding whose drilldown is open — rendered with a persistent ring. */
  selectedId?: string | null;
  onSelect: (event: TimelineEvent) => void;
  /** Shown as a recovery action on error (and not at all when omitted). */
  onReanalyze?: () => void;
}

/**
 * Two-lane band of time-anchored findings, aligned to a 0..axisMaxMs width.
 * Top lane = THEM (對方提的), bottom lane = ME (我的問題). Click a dot to select
 * the finding (seek + open its solution). Shared by LIVE (growing elapsed axis)
 * and REPLAY (fixed recording duration) — purely props-driven.
 */
export function AnalysisTimeline({
  findings,
  status,
  error,
  axisMaxMs,
  playheadMs,
  selectedId,
  onSelect,
  onReanalyze,
}: AnalysisTimelineProps) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState<string | null>(null);

  const { them, me } = useMemo(
    () => ({
      them: findings.filter((e) => e.side === "them"),
      me: findings.filter((e) => e.side === "me"),
    }),
    [findings]
  );

  return (
    <div className="shrink-0 border-b px-4 py-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-foreground">{t("timeline.title")}</span>
        <div className="flex items-center gap-2">
          {status === "done" && findings.length > 0 && (
            <span className="text-[10px] tabular-nums text-muted-foreground/70">
              {t("timeline.count", { count: findings.length })}
            </span>
          )}
          {status === "running" && (
            <span className="text-[10px] text-muted-foreground">{t("timeline.analyzing")}</span>
          )}
          {status === "error" && (
            <>
              <span className="max-w-[200px] truncate text-[10px] text-orange-500" title={error ?? undefined}>
                {t("timeline.failed", { error: error ?? "—" })}
              </span>
              {onReanalyze && (
                <button
                  type="button"
                  onClick={onReanalyze}
                  className="flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                  title={t("timeline.reanalyze")}
                >
                  <RefreshCw className="size-3" />
                  {t("timeline.reanalyze")}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Lane
          label={t("timeline.laneThem")}
          events={them}
          axisMaxMs={axisMaxMs}
          playheadMs={playheadMs}
          selectedId={selectedId}
          hovered={hovered}
          setHovered={setHovered}
          onSelect={onSelect}
          extraLabel={t("timeline.extra")}
          tooltipTime={t("timeline.atMoment")}
        />
        <Lane
          label={t("timeline.laneMe")}
          events={me}
          axisMaxMs={axisMaxMs}
          playheadMs={playheadMs}
          selectedId={selectedId}
          hovered={hovered}
          setHovered={setHovered}
          onSelect={onSelect}
          extraLabel={t("timeline.extra")}
          tooltipTime={t("timeline.atMoment")}
        />
      </div>

      {status === "done" && findings.length === 0 && (
        <div className="mt-1 text-[10px] text-muted-foreground/70">{t("timeline.empty")}</div>
      )}
    </div>
  );
}

interface LaneProps {
  label: string;
  events: TimelineEvent[];
  axisMaxMs: number;
  playheadMs?: number;
  selectedId?: string | null;
  hovered: string | null;
  setHovered: (id: string | null) => void;
  onSelect: (event: TimelineEvent) => void;
  extraLabel: string;
  tooltipTime: string;
}

function Lane({
  label,
  events,
  axisMaxMs,
  playheadMs,
  selectedId,
  hovered,
  setHovered,
  onSelect,
  extraLabel,
  tooltipTime,
}: LaneProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 truncate text-right text-[10px] text-muted-foreground">{label}</span>
      <div className="relative h-5 min-w-0 flex-1 rounded bg-muted/40">
        {events.map((e) => {
          const pct = axisMaxMs > 0 ? Math.max(0, Math.min(1, e.atMs / axisMaxMs)) : 0;
          const near = playheadMs !== undefined && Math.abs(e.atMs - playheadMs) <= NEAR_MS;
          const isHovered = hovered === e.id;
          const isSelected = selectedId === e.id;
          return (
            <button
              key={e.id}
              type="button"
              onClick={() => onSelect(e)}
              onMouseEnter={() => setHovered(e.id)}
              onMouseLeave={() => setHovered(null)}
              className={cn(
                "absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full transition-transform hover:scale-125",
                SEVERITY_DOT[e.severity],
                e.source === "extra" && "ring-2 ring-foreground/40 ring-offset-1 ring-offset-background",
                near && "scale-125",
                isSelected && "scale-150 ring-2 ring-primary ring-offset-1 ring-offset-background",
                (isHovered || isSelected) && "z-20"
              )}
              style={{ left: `${pct * 100}%` }}
              aria-label={`${formatClock(e.atMs)} ${e.title}`}
            >
              {isHovered && (
                <span className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 w-56 -translate-x-1/2 rounded-md border bg-popover px-2 py-1.5 text-left text-[11px] leading-snug text-popover-foreground shadow-md">
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
