import { useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { useStore } from "../../lib/store";
import { hasProviderKey } from "../../lib/ai/settings";
import { runFindingSolution } from "../../lib/analysis/solution";
import { useI18n } from "../../i18n";
import type { TimelineEvent, WargameStrategyKind } from "../../lib/types";

/** Move kind → accent color (mirrors the old war-game card grammar). */
const KIND_ACCENT: Record<WargameStrategyKind, string> = {
  rebut: "text-sky-400",
  reframe: "text-violet-400",
  trade: "text-emerald-400",
  concede_redirect: "text-amber-400",
};

/**
 * The "how it should have been done" drilldown for one finding. Lazily fires the
 * war-game solution engine on first open and renders the cached result. Mode-
 * agnostic: identical in LIVE and REPLAY (the engine reads the full transcript).
 */
export function FindingSolutionCard({ finding }: { finding: TimelineEvent }) {
  const { t } = useI18n();
  const entry = useStore((s) => s.findingSolutions[finding.id]);
  const keyMissing = useStore((s) => !hasProviderKey(s.settings));
  const status = entry?.status ?? "idle";

  // Generate on first open and whenever the open finding changes.
  useEffect(() => {
    if (keyMissing) return;
    if (!entry || entry.status === "idle") void runFindingSolution(finding.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finding.id]);

  if (keyMissing) {
    return <div className="mt-2 text-[11px] text-muted-foreground">{t("solution.noKey")}</div>;
  }
  if (status === "idle" || status === "running") {
    return <div className="mt-2 text-[11px] text-muted-foreground">{t("solution.generating")}</div>;
  }
  if (status === "error") {
    return (
      <div className="mt-2 flex items-center gap-2 text-[11px] text-orange-500">
        <span className="min-w-0 truncate">{t("solution.failed", { error: entry?.error ?? "—" })}</span>
        <button
          type="button"
          onClick={() => void runFindingSolution(finding.id)}
          className="flex shrink-0 items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="size-3" />
          {t("solution.retry")}
        </button>
      </div>
    );
  }

  const solution = entry?.solution;
  if (!solution || solution.moves.length === 0) {
    return <div className="mt-2 text-[11px] text-muted-foreground">{t("solution.empty")}</div>;
  }

  return (
    <div className="mt-2.5 flex flex-col gap-2">
      <p className="text-xs leading-relaxed text-foreground/90">{solution.summary}</p>

      {solution.suggestedLine && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-2">
          <div className="text-[11px] font-semibold text-emerald-300">{t("solution.suggestedLine")}</div>
          <p className="mt-1 text-xs italic leading-relaxed text-foreground/90">“{solution.suggestedLine}”</p>
        </div>
      )}

      {solution.moves.map((m, i) => (
        <div key={i} className="rounded-md border bg-muted/30 px-2.5 py-2">
          <div className={`text-[11px] font-semibold ${KIND_ACCENT[m.kind]}`}>
            {t(`wargame.kind.${m.kind}` as const)}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-foreground/90">{m.approach}</p>
          <div className="mt-1.5 text-[11px] text-muted-foreground">
            <span className="font-medium text-muted-foreground/90">{t("solution.why")}:</span> {m.why}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            <span className="font-medium text-muted-foreground/90">{t("wargame.predictedReaction")}:</span>{" "}
            {m.predictedReaction}
          </div>
        </div>
      ))}
    </div>
  );
}
