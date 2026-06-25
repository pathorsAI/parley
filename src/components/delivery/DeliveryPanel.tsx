import { Loader2 } from "lucide-react";
import { useStore } from "../../lib/store";
import { useI18n } from "../../i18n";
import type { TranslationKey } from "../../i18n";
import type { ToneVerdict } from "../../lib/types";

/** Accent color per tone verdict — neutral/firm are fine, sharp+ warn. */
function toneClass(tone: ToneVerdict): string {
  switch (tone) {
    case "rude":
    case "aggressive":
      return "text-red-400";
    case "sharp":
      return "text-amber-400";
    case "warm":
      return "text-emerald-400";
    default:
      return "text-foreground";
  }
}

const TONE_KEY: Record<ToneVerdict, TranslationKey> = {
  neutral: "delivery.tone.neutral",
  warm: "delivery.tone.warm",
  firm: "delivery.tone.firm",
  sharp: "delivery.tone.sharp",
  aggressive: "delivery.tone.aggressive",
  rude: "delivery.tone.rude",
};

const PACE_KEY = {
  slow: "delivery.pace.slow",
  comfortable: "delivery.pace.comfortable",
  fast: "delivery.pace.fast",
} as const satisfies Record<NonNullable<import("../../lib/types").DeliveryAssessment["pace"]>, TranslationKey>;

/**
 * Persistent "Delivery" card — the always-visible counterpart to the transient
 * nudges. Shows the current LLM delivery assessment: tone verdict (+ evidence),
 * filler frequency (only emphasized when over-frequent — everyone uses some), an
 * overall pace read, and a one-line summary. Rendered at the top of the findings
 * column in BOTH live (rolling) and replay (computed once) modes.
 *
 * Gated so it doesn't clutter when delivery analysis isn't in play: live shows it
 * only when the opt-in toggle is on; replay shows it whenever the post-call pass
 * is running or done.
 */
export function DeliveryPanel({ mode }: { mode: "live" | "replay" }) {
  const { t } = useI18n();
  const enabled = useStore((s) => s.settings.delivery.tone);
  const assessment = useStore((s) => s.deliveryAssessment);
  const status = useStore((s) => s.deliveryStatus);

  const show = mode === "replay" ? status !== "idle" || !!assessment : enabled;
  if (!show) return null;

  const running = status === "running" && !assessment;
  const frequentFillers = assessment?.fillers.level === "frequent";

  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold tracking-tight">{t("delivery.card.title")}</span>
        {status === "running" && assessment && (
          <Loader2 className="size-3 animate-spin text-muted-foreground" />
        )}
      </div>

      {running ? (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          {t("delivery.card.analyzing")}
        </div>
      ) : !assessment ? (
        <p className="text-[11px] text-muted-foreground">
          {mode === "live" ? t("delivery.card.waiting") : t("delivery.card.none")}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5 text-[11px]">
          {/* Tone */}
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-muted-foreground">{t("delivery.card.tone")}</span>
            <span className={`font-medium ${toneClass(assessment.tone)}`}>
              {t(TONE_KEY[assessment.tone])}
            </span>
          </div>
          {assessment.toneEvidence && (
            <p className="-mt-1 truncate text-[10px] italic text-muted-foreground">
              “{assessment.toneEvidence}”
            </p>
          )}

          {/* Fillers — only emphasized when over-frequent */}
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-muted-foreground">{t("delivery.card.fillers")}</span>
            <span className={frequentFillers ? "font-medium text-amber-400" : "text-muted-foreground"}>
              {t(frequentFillers ? "delivery.filler.frequent" : "delivery.filler.ok")}
              {frequentFillers && assessment.fillers.examples.length > 0 && (
                <span className="ml-1 font-normal opacity-80">
                  ({assessment.fillers.examples.slice(0, 3).join("、")})
                </span>
              )}
            </span>
          </div>

          {/* Pace */}
          {assessment.pace && (
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-muted-foreground">{t("delivery.card.pace")}</span>
              <span className={assessment.pace === "fast" ? "font-medium text-amber-400" : "text-foreground"}>
                {t(PACE_KEY[assessment.pace])}
              </span>
            </div>
          )}

          {/* One-line summary */}
          {assessment.summary && (
            <p className="mt-0.5 text-[11px] leading-snug text-foreground/80">{assessment.summary}</p>
          )}
        </div>
      )}
    </div>
  );
}
