import { RefreshCw } from "lucide-react";
import { useI18n } from "../../i18n";
import type { FindingSolution, FindingSolutionEntry, WargameStrategyKind } from "../../lib/types";

/** Reply angle → accent color (mirrors the old war-game card grammar). */
const KIND_ACCENT: Record<WargameStrategyKind, string> = {
  rebut: "text-sky-400",
  reframe: "text-violet-400",
  trade: "text-emerald-400",
  concede_redirect: "text-amber-400",
};

/**
 * Pure presentational drilldown body: given a solution entry (status + result),
 * render the "how should I reply" options. Store-free on purpose — both the
 * in-app overlay (browser fallback) and the standalone OS window render this,
 * the latter fed by cross-window-synced state. Generation/retry is delegated to
 * the caller via `onRetry`.
 */
export function FindingSolutionView({
  status,
  solution,
  error,
  keyMissing,
  onRetry,
}: {
  status: FindingSolutionEntry["status"];
  solution: FindingSolution | null;
  error: string | null;
  keyMissing: boolean;
  onRetry: () => void;
}) {
  const { t } = useI18n();

  if (keyMissing) {
    return <div className="mt-2 text-[11px] text-muted-foreground">{t("solution.noKey")}</div>;
  }
  if (status === "idle" || status === "running") {
    return <div className="mt-2 text-[11px] text-muted-foreground">{t("solution.generating")}</div>;
  }
  if (status === "error") {
    return (
      <div className="mt-2 flex items-center gap-2 text-[11px] text-orange-500">
        <span className="min-w-0 truncate">{t("solution.failed", { error: error ?? "—" })}</span>
        <button
          type="button"
          onClick={onRetry}
          className="flex shrink-0 items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="size-3" />
          {t("solution.retry")}
        </button>
      </div>
    );
  }

  if (!solution || solution.replies.length === 0) {
    return <div className="mt-2 text-[11px] text-muted-foreground">{t("solution.empty")}</div>;
  }

  return (
    <div className="mt-2.5 flex flex-col gap-2">
      {solution.replies.map((r, i) => (
        <div key={i} className="rounded-md border bg-muted/30 px-2.5 py-2">
          <div className={`text-[11px] font-semibold ${KIND_ACCENT[r.kind]}`}>
            {t(`wargame.kind.${r.kind}` as const)}
          </div>
          <p className="mt-1 text-xs italic leading-relaxed text-foreground/90">“{r.reply}”</p>
          <div className="mt-1.5 text-[11px] text-muted-foreground">
            <span className="font-medium text-muted-foreground/90">{t("solution.consideration")}:</span>{" "}
            {r.consideration}
          </div>
        </div>
      ))}
    </div>
  );
}
