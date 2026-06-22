import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatClock } from "../../lib/store";
import { useI18n } from "../../i18n";
import { useEvalNames } from "./useAnalysis";
import type { TimelineEvent } from "../../lib/types";

const SEVERITY_DOT: Record<TimelineEvent["severity"], string> = {
  info: "bg-sky-400",
  warn: "bg-amber-500",
  critical: "bg-red-500",
};

/** Moment ME already defused → green, overriding the severity colour. */
const RESOLVED_DOT = "bg-emerald-500";

/**
 * One finding in the right-hand list. Clicking the row HIGHLIGHTS the finding and
 * seeks to its moment — it does NOT open the reply window (that would spend a
 * generation on every click). The "how to reply" button is the explicit, separate
 * affordance that opens the standalone window.
 */
export function FindingRow({
  event,
  selected,
  onSelect,
  onOpenSolution,
}: {
  event: TimelineEvent;
  selected: boolean;
  /** Row click: highlight + seek (no window). */
  onSelect: (event: TimelineEvent) => void;
  /** "how to reply" button: open the reply window (the only generation trigger). */
  onOpenSolution: (event: TimelineEvent) => void;
}) {
  const { t } = useI18n();
  const evalNames = useEvalNames();
  const evalLabels =
    event.source === "eval"
      ? (event.evalIds ?? []).map((id) => evalNames.get(id)).filter((n): n is string => !!n)
      : [];
  return (
    <li className={cn("rounded-lg border", selected ? "border-primary/50 bg-muted/30" : "border-border")}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect(event)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(event);
          }
        }}
        className="flex w-full cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span
          className={cn("mt-1 size-2 shrink-0 rounded-full", event.resolved ? RESOLVED_DOT : SEVERITY_DOT[event.severity])}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {formatClock(event.atMs)}
            </span>
            <span className={cn("text-xs font-medium", event.side === "me" ? "text-sky-400" : "text-amber-400")}>
              {event.title}
            </span>
            {event.resolved && (
              <span className="rounded bg-emerald-500/10 px-1 text-[9px] font-medium text-emerald-600 dark:text-emerald-400">
                {t("timeline.resolved")}
              </span>
            )}
            {event.source === "extra" && (
              <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">{t("timeline.extra")}</span>
            )}
            {evalLabels.map((name, i) => (
              <span
                key={i}
                className="truncate rounded bg-muted px-1 text-[9px] text-muted-foreground"
                title={`${t("timeline.evalLabel")}: ${name}`}
              >
                {name}
              </span>
            ))}
          </span>
          <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{event.detail}</span>
          {event.quotes?.map((q, i) => (
            <span
              key={i}
              className="mt-1 block border-l-2 border-border pl-2 text-[11px] italic text-muted-foreground/80"
            >
              “{q}”
            </span>
          ))}
          {event.resolved && event.resolution && (
            <span className="mt-1 block text-[11px] leading-snug text-emerald-600 dark:text-emerald-400">
              {t("timeline.resolvedHow")}: {event.resolution}
            </span>
          )}
          <button
            type="button"
            onClick={(e) => {
              // Don't let the open also fire the row's select/seek.
              e.stopPropagation();
              onOpenSolution(event);
            }}
            className="mt-1.5 inline-flex items-center gap-1 rounded text-[11px] font-medium text-primary hover:underline"
          >
            <ChevronRight className="size-3" />
            {t("solution.show")}
          </button>
        </span>
      </div>
    </li>
  );
}
