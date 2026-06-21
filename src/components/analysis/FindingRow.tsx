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

/**
 * One finding in the right-hand list. Clicking it selects the finding (seek +
 * open). Pinpointing the problem is secondary — the row leads with the primary
 * "how it should have been done" affordance, and expands the solution inline
 * when selected.
 */
export function FindingRow({
  event,
  selected,
  onSelect,
}: {
  event: TimelineEvent;
  selected: boolean;
  onSelect: (event: TimelineEvent) => void;
}) {
  const { t } = useI18n();
  const evalNames = useEvalNames();
  const evalName = event.source === "eval" ? evalNames.get(event.evalId ?? "") : undefined;
  return (
    <li className={cn("rounded-lg border", selected ? "border-primary/50 bg-muted/30" : "border-border")}>
      <button
        type="button"
        onClick={() => onSelect(event)}
        className="flex w-full items-start gap-2 px-2.5 py-2 text-left"
      >
        <span className={cn("mt-1 size-2 shrink-0 rounded-full", SEVERITY_DOT[event.severity])} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {formatClock(event.atMs)}
            </span>
            <span className={cn("text-xs font-medium", event.side === "me" ? "text-sky-400" : "text-amber-400")}>
              {event.title}
            </span>
            {event.source === "extra" && (
              <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">{t("timeline.extra")}</span>
            )}
            {evalName && (
              <span
                className="truncate rounded bg-muted px-1 text-[9px] text-muted-foreground"
                title={`${t("timeline.evalLabel")}: ${evalName}`}
              >
                {evalName}
              </span>
            )}
          </span>
          <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{event.detail}</span>
          {event.quote && (
            <span className="mt-1 block border-l-2 border-border pl-2 text-[11px] italic text-muted-foreground/80">
              “{event.quote}”
            </span>
          )}
          <span className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-primary">
            <ChevronRight className="size-3" />
            {t("solution.show")}
          </span>
        </span>
      </button>
    </li>
  );
}
