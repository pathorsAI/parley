import { useProsody } from "../../lib/analysis/useDelivery";
import { useI18n } from "../../i18n";

/**
 * Ambient pace gauge — a thin bar (styled like {@link LevelMeter}) showing the
 * user's live speech rate. Driven by the mic-anchored `speechRateHz` so it works
 * in diarized mode too. Absolute color bands give an at-a-glance read; the
 * precise "too fast" judgement (relative to the speaker's baseline) lives in the
 * nudge logic, not here. Renders nothing until the first prosody sample.
 */
export function PaceGauge({ className }: { className?: string }) {
  const prosody = useProsody();
  const { t } = useI18n();
  if (!prosody) return null;

  // ~2/s relaxed … ~6/s very fast. Comfortable conversational ≈ 3–4.5/s.
  const hz = prosody.speechRateHz;
  const pct = Math.min(100, Math.round((hz / 6) * 100));
  const color = hz > 4.8 ? "bg-amber-400" : hz > 1 ? "bg-emerald-500" : "bg-muted-foreground/30";

  return (
    <div
      className={`h-1.5 overflow-hidden rounded-full bg-muted ${className ?? "w-12"}`}
      title={`${t("delivery.gauge.pace")} — ${t("delivery.gauge.pace.tip")}`}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-200 ${color}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
