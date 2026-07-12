import { useMemo, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import { formatClock } from "../../lib/store";
import { cn } from "@/lib/utils";
import type { TimelineEvent } from "../../lib/types";
import { useI18n } from "../../i18n";
import { useEvalNames } from "./useAnalysis";

const SEVERITIES = ["info", "warn", "critical"] as const;

/** Severity → dot fill. Mirrors the info/warn/critical conventions used elsewhere. */
const SEVERITY_DOT: Record<TimelineEvent["severity"], string> = {
  info: "bg-sky-400",
  warn: "bg-amber-500",
  critical: "bg-red-500",
};

/** Moment ME already defused → green, overriding the severity colour. */
const RESOLVED_DOT = "bg-emerald-500";

/** Dot colour for a finding: green when ME already handled it, else by severity. */
const dotClass = (e: TimelineEvent) => (e.resolved ? RESOLVED_DOT : SEVERITY_DOT[e.severity]);

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
  /** Active eval-template name, shown as a chip next to the title (omit to hide). */
  templateName?: string;
  /** True when the eval set changed since these findings were computed — prompts
   *  the user to re-analyze (via the player's Analyze menu). */
  stale?: boolean;
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
  templateName,
  stale,
}: Readonly<AnalysisTimelineProps>) {
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
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-[11px] font-medium text-foreground">{t("timeline.title")}</span>
          {templateName && (
            <span
              className="truncate rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
              title={`${t("timeline.templateLabel")}: ${templateName}`}
            >
              {t("timeline.templateLabel")}: {templateName}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {stale && (
            <span className="flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-500">
              <RefreshCw className="size-3" />
              {t("timeline.stale")}
            </span>
          )}
          {status === "done" && findings.length > 0 && (
            <span className="text-[10px] tabular-nums text-muted-foreground/70">
              {t("timeline.count", { count: findings.length })}
            </span>
          )}
          {/* Idle (e.g. analysis was skipped in the ingest wizard) → let the user
              run it now. */}
          {status === "idle" && onReanalyze && (
            <button
              type="button"
              onClick={onReanalyze}
              className="flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
              title={t("timeline.analyze")}
            >
              <Sparkles className="size-3" />
              {t("timeline.analyze")}
            </button>
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
          // Top lane: open the tooltip DOWNWARD so it stays inside the panel
          // instead of escaping over whatever sits above the timeline.
          tooltipBelow
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

      {/* Legend: what the dot colours (severity) and the ring (AI-extra) mean. */}
      {findings.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[4.5rem] text-[9px] text-muted-foreground">
          <span className="font-medium text-muted-foreground/70">{t("timeline.legend")}:</span>
          {SEVERITIES.map((sev) => (
            <span key={sev} className="flex items-center gap-1">
              <span className={cn("size-2 rounded-full", SEVERITY_DOT[sev])} />
              {t(`timeline.sev.${sev}` as const)}
            </span>
          ))}
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-full bg-muted-foreground/40 ring-2 ring-foreground/40 ring-offset-1 ring-offset-background" />
            {t("timeline.extra")}
          </span>
          {findings.some((f) => f.resolved) && (
            <span className="flex items-center gap-1">
              <span className={cn("size-2 rounded-full", RESOLVED_DOT)} />
              {t("timeline.resolved")}
            </span>
          )}
        </div>
      )}

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
  /** Open tooltips below the dots (for the top lane, so they never escape
   *  upward over neighbouring panels / the window edge). */
  tooltipBelow?: boolean;
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
  tooltipBelow = false,
}: Readonly<LaneProps>) {
  const { t } = useI18n();
  const evalNames = useEvalNames();
  const playheadPct =
    playheadMs !== undefined && axisMaxMs > 0 ? Math.max(0, Math.min(1, playheadMs / axisMaxMs)) : null;
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 truncate text-right text-[10px] text-muted-foreground">{label}</span>
      <div className="relative h-5 min-w-0 flex-1 rounded bg-muted/40">
        {/* Playhead marker — keeps the audio/scrubber position visible on the band. */}
        {playheadPct !== null && (
          <span
            className="pointer-events-none absolute inset-y-0 z-10 w-px bg-primary/70"
            style={{ left: `${playheadPct * 100}%` }}
          />
        )}
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
                dotClass(e),
                e.source === "extra" && "ring-2 ring-foreground/40 ring-offset-1 ring-offset-background",
                near && "scale-125",
                isSelected && "scale-150 ring-2 ring-primary ring-offset-1 ring-offset-background",
                (isHovered || isSelected) && "z-20"
              )}
              style={{ left: `${pct * 100}%` }}
              aria-label={`${formatClock(e.atMs)} ${e.title}`}
            >
              {isHovered && (
                <span
                  className={cn(
                    "pointer-events-none absolute z-30 w-56 rounded-md border bg-popover px-2 py-1.5 text-left text-[11px] leading-snug text-popover-foreground shadow-md",
                    // Vertical: top lane opens downward so the tooltip never
                    // escapes the panel; bottom lane keeps opening upward.
                    tooltipBelow ? "top-full mt-1.5" : "bottom-full mb-1.5",
                    // Horizontal: dots near either end pin the tooltip to that
                    // edge instead of centering it off the window.
                    pct < 0.2 ? "left-0" : pct > 0.8 ? "right-0" : "left-1/2 -translate-x-1/2"
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
                  {/* Why this dot is this colour (severity) + which eval flagged it. */}
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <span className={cn("size-1.5 rounded-full", dotClass(e))} />
                      {e.resolved ? t("timeline.resolved") : t(`timeline.sev.${e.severity}` as const)}
                    </span>
                    {e.source === "eval" && (e.evalIds?.length ?? 0) > 0 && (
                      <span>
                        {t("timeline.evalLabel")}:{" "}
                        {(e.evalIds ?? []).map((id) => evalNames.get(id) ?? id).join(", ")}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block font-medium text-popover-foreground">{e.title}</span>
                  <span className="mt-0.5 block text-muted-foreground">{e.detail}</span>
                  {e.resolved && e.resolution && (
                    <span className="mt-0.5 block text-emerald-500">
                      {t("timeline.resolvedHow")}: {e.resolution}
                    </span>
                  )}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
