import { useState } from "react";
import { AlertTriangle, Swords } from "lucide-react";
import { useI18n } from "../../i18n";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { WargameBranch } from "./WargameBranch";
import type { WargameArgument, WargameStrategy } from "../../lib/types";

const KIND_ORDER: WargameStrategy["kind"][] = ["rebut", "reframe", "trade", "concede_redirect"];

const KIND_ACCENT: Record<WargameStrategy["kind"], string> = {
  rebut: "text-sky-400",
  reframe: "text-violet-400",
  trade: "text-emerald-400",
  concede_redirect: "text-amber-400",
};

/** One detected argument: claim, source quote, premises, the trap, and strategies. */
export function WargameCard({ argument }: { argument: WargameArgument }) {
  const { t } = useI18n();
  // Which strategy's branch is currently expanded (by index), if any.
  const [openBranch, setOpenBranch] = useState<number | null>(null);

  const strategies = [...argument.strategies].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
  );

  return (
    <Card className="gap-0 p-3">
      <div className="text-sm font-medium leading-snug text-foreground">{argument.claim}</div>

      {argument.sourceQuote && (
        <div className="mt-1.5 border-l-2 border-amber-400/50 pl-2 text-[11px] italic text-muted-foreground">
          <span className="mr-1 font-medium text-amber-400/90">{t("wargame.source")}:</span>“
          {argument.sourceQuote}”
        </div>
      )}

      {argument.premises.length > 0 && (
        <div className="mt-2.5">
          <div className="text-[11px] font-medium text-muted-foreground">{t("wargame.premises")}</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-foreground/85">
            {argument.premises.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {/* The headline value: the premise NOT to concede, highlighted as a warning. */}
      <div className="mt-2.5 rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-red-300">
          <AlertTriangle className="size-3.5 shrink-0" />
          {t("wargame.trap")}
        </div>
        {argument.trap ? (
          <>
            <div className="mt-1 text-xs font-medium text-foreground">{argument.trap.premise}</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{argument.trap.why}</div>
          </>
        ) : (
          <div className="mt-1 text-[11px] text-muted-foreground">{t("wargame.trapNone")}</div>
        )}
      </div>

      {/* Strategies, grouped and labeled by kind. */}
      <div className="mt-3 flex flex-col gap-2">
        {strategies.map((s, i) => (
          <div key={i} className="rounded-md border bg-muted/30 px-2.5 py-2">
            <div className={`text-[11px] font-semibold ${KIND_ACCENT[s.kind]}`}>
              {t(`wargame.kind.${s.kind}` as const)}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-foreground/90">{s.approach}</p>
            <div className="mt-1.5 text-[11px] text-muted-foreground">
              <span className="font-medium text-muted-foreground/90">{t("wargame.predictedReaction")}:</span>{" "}
              {s.predictedReaction}
            </div>

            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-2 h-7 gap-1.5 text-[11px]"
              onClick={() => setOpenBranch((cur) => (cur === i ? null : i))}
            >
              <Swords className="size-3" />
              {t("wargame.simulate")}
            </Button>

            {openBranch === i && (
              <WargameBranch
                // Remount the branch when reopening so each session starts fresh.
                key={`branch-${i}`}
                argument={argument}
                strategy={s}
                onCollapse={() => setOpenBranch(null)}
              />
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
