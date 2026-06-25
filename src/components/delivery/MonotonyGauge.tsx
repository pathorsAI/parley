import { useProsody } from "../../lib/analysis/useDelivery";
import { useI18n } from "../../i18n";

/**
 * Ambient intonation gauge — shows how much pitch *variation* there is right now
 * (the opposite of monotony). A full green bar = lively, expressive delivery; a
 * short amber bar = flat / monotone. Driven by `pitchVarSemitones` (F0 spread).
 * Stays muted until there's enough sustained voicing to judge.
 */
export function MonotonyGauge({ className }: { className?: string }) {
  const prosody = useProsody();
  const { t } = useI18n();
  if (!prosody) return null;

  // Map F0 spread to a "liveliness" bar: <1.2 st flat, ~3+ st expressive.
  const sd = prosody.pitchVarSemitones;
  const hasData = sd > 0;
  const pct = hasData ? Math.min(100, Math.round((sd / 3) * 100)) : 0;
  const color = !hasData
    ? "bg-muted-foreground/30"
    : sd < 1.2
    ? "bg-amber-400"
    : "bg-emerald-500";

  return (
    <div
      className={`h-1.5 overflow-hidden rounded-full bg-muted ${className ?? "w-12"}`}
      title={`${t("delivery.gauge.monotony")} — ${t("delivery.gauge.monotony.tip")}`}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-200 ${color}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
