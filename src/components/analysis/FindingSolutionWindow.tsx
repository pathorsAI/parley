import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "../../lib/store";
import { formatClock } from "../../lib/store";
import { useI18n } from "../../i18n";
import { FindingSolutionCard } from "./FindingSolutionCard";

/**
 * Floating "how it should have been done" window for the selected finding. Driven
 * by the shared `selectedFindingId`: clicking a finding (timeline dot or list row)
 * opens/switches it; closing here clears the selection; clicking a finding again
 * re-opens it. Non-modal — the page (timeline, transcript) stays interactive
 * behind it, and it floats above everything else so it reads as "in front".
 *
 * The solution itself (summary + the corrective moves) is generated lazily by
 * FindingSolutionCard, remounted per finding so switching refreshes its content.
 */
export function FindingSolutionWindow() {
  const { t } = useI18n();
  const finding = useStore((s) => s.findings.find((f) => f.id === s.selectedFindingId) ?? null);
  const setSelectedFinding = useStore((s) => s.setSelectedFinding);

  if (!finding) return null;

  return (
    <div className="fixed right-4 top-1/2 z-50 flex max-h-[80vh] w-[22rem] -translate-y-1/2 flex-col rounded-xl border bg-background shadow-2xl">
      <div className="flex items-start gap-2 border-b px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {t("solution.windowTitle")}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {formatClock(finding.atMs)}
            </span>
            <span
              className={cn(
                "truncate text-sm font-semibold",
                finding.side === "me" ? "text-sky-400" : "text-amber-400"
              )}
              title={finding.title}
            >
              {finding.title}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setSelectedFinding(null)}
          className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
          title={t("solution.close")}
          aria-label={t("solution.close")}
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-3.5">
        <p className="mt-2.5 border-l-2 border-border pl-2 text-[11px] leading-snug text-muted-foreground">
          {finding.detail}
        </p>
        <FindingSolutionCard key={finding.id} finding={finding} />
      </div>
    </div>
  );
}
