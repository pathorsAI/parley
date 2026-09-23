import { useEffect, useRef } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatClock } from "../../lib/store";
import { useI18n } from "../../i18n";
import { useEvalNames } from "./useAnalysis";
import type { TimelineEvent } from "../../lib/types";

/**
 * Severity dot. The dot is the ONLY place severity is colour-coded — the lane is
 * already shown by the timeline, so the title stays plain foreground text.
 */
const SEVERITY_DOT: Record<TimelineEvent["severity"], string> = {
  info: "bg-info-foreground",
  warn: "bg-warning-foreground",
  critical: "bg-danger-foreground",
};

/** Moment ME already defused → success, overriding the severity colour. */
const RESOLVED_DOT = "bg-success-foreground";

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
}: Readonly<{
  event: TimelineEvent;
  selected: boolean;
  /** Row click: highlight + seek (no window). */
  onSelect: (event: TimelineEvent) => void;
  /** "how to reply" button: open the reply window (the only generation trigger). */
  onOpenSolution: (event: TimelineEvent) => void;
}>) {
  const { t } = useI18n();
  const evalNames = useEvalNames();
  // Selection can come from the TIMELINE, where the matching row is usually
  // scrolled out of view — bring it into view so clicking a dot lands somewhere
  // visible. "nearest" makes this a no-op when the row is already on screen, so
  // clicking a row in this list never yanks the list around.
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);
  const evalLabels =
    event.source === "eval"
      ? (event.evalIds ?? [])
          .map((id) => ({ id, name: evalNames.get(id) }))
          .filter((label): label is { id: string; name: string } => !!label.name)
      : [];
  return (
    <li
      ref={ref}
      className={cn(
        "border-b border-border px-4 py-3 last:border-b-0",
        selected ? "bg-primary/5 shadow-[inset_2px_0_0_var(--primary)]" : "hover:bg-muted/60"
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(event)}
        className="flex w-full cursor-pointer items-start gap-2 rounded text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span
          className={cn(
            "mt-1.5 size-[7px] shrink-0 rounded-full",
            event.resolved ? RESOLVED_DOT : SEVERITY_DOT[event.severity]
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {formatClock(event.atMs)}
            </span>
            {event.category && (
              <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
                {t(`finding.cat.${event.category}`)}
              </span>
            )}
            <span className="text-[13px] font-semibold text-foreground">{event.title}</span>
            {event.resolved && (
              <span className="rounded bg-success px-1.5 text-[10px] font-medium text-success-foreground">
                {t("timeline.resolved")}
              </span>
            )}
            {event.source === "extra" && (
              <span className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">{t("timeline.extra")}</span>
            )}
            {evalLabels.map(({ id, name }) => (
              <span
                key={id}
                className="truncate rounded bg-muted px-1.5 text-[10px] text-muted-foreground"
                title={`${t("timeline.evalLabel")}: ${name}`}
              >
                {name}
              </span>
            ))}
          </span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{event.detail}</span>
          {/* The referenced transcript quote is intentionally NOT shown — clicking
              the row already seeks to that moment in the transcript. Quotes are
              still kept on the event for time-anchoring. */}
          {event.resolved && event.resolution && (
            <span className="mt-1 block text-[11px] leading-snug text-success-foreground">
              {t("timeline.resolvedHow")}: {event.resolution}
            </span>
          )}
        </span>
      </button>
      <button
        type="button"
        onClick={() => onOpenSolution(event)}
        className="mt-1.5 ml-[15px] inline-flex items-center gap-1 rounded text-[11px] font-medium text-primary hover:underline"
      >
        <ChevronRight className="size-3" />
        {t("solution.show")}
      </button>
    </li>
  );
}
