import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { PROVIDER_BY_ID } from "../lib/ai/providers";
import { readUsageEvents, type UsageEvent } from "../lib/usage/log";
import { PRICING_NOTES } from "../lib/usage/pricing";
import { PieChart, type PieSlice } from "../components/PieChart";

type Period = "today" | "7d" | "30d" | "all";

const PALETTE = [
  "#6366f1", "#10b981", "#f59e0b", "#ef4444", "#06b6d4",
  "#8b5cf6", "#ec4899", "#84cc16", "#f97316", "#14b8a6",
];

/** Friendly provider name: LLM providers from the registry, STT by id. */
function providerLabel(id: string): string {
  return PROVIDER_BY_ID[id as keyof typeof PROVIDER_BY_ID]?.label ?? id;
}

function formatUsd(v: number): string {
  if (v === 0) return "$0";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

function periodStart(period: Period): number {
  if (period === "all") return 0;
  const day = 24 * 60 * 60 * 1000;
  const span = period === "today" ? day : period === "7d" ? 7 * day : 30 * day;
  return Date.now() - span;
}

/** Sum cost per provider into pie slices, colored by sorted provider order. */
function toSlices(events: UsageEvent[]): { slices: PieSlice[]; total: number } {
  const byProvider = new Map<string, number>();
  for (const e of events) byProvider.set(e.provider, (byProvider.get(e.provider) ?? 0) + e.costUsd);
  const entries = [...byProvider.entries()].sort((a, b) => b[1] - a[1]);
  const slices = entries.map(([provider, value], i) => ({
    label: providerLabel(provider),
    value,
    color: PALETTE[i % PALETTE.length],
  }));
  const total = entries.reduce((s, [, v]) => s + v, 0);
  return { slices, total };
}

export function UsagePanel() {
  const { t } = useI18n();
  const [events, setEvents] = useState<UsageEvent[]>([]);
  const [period, setPeriod] = useState<Period>("7d");

  useEffect(() => {
    void readUsageEvents().then(setEvents);
  }, []);

  const { llm, stt, llmTotal, sttTotal, tokens, minutes } = useMemo(() => {
    const since = periodStart(period);
    const inRange = events.filter((e) => e.ts >= since);
    const llmEvents = inRange.filter((e) => e.kind === "llm");
    const sttEvents = inRange.filter((e) => e.kind === "stt");
    const llmAgg = toSlices(llmEvents);
    const sttAgg = toSlices(sttEvents);
    const tokens = llmEvents.reduce((s, e) => s + (e.inputTokens ?? 0) + (e.outputTokens ?? 0), 0);
    const minutes = sttEvents.reduce((s, e) => s + (e.seconds ?? 0), 0) / 60;
    return {
      llm: llmAgg.slices,
      stt: sttAgg.slices,
      llmTotal: llmAgg.total,
      sttTotal: sttAgg.total,
      tokens,
      minutes,
    };
  }, [events, period]);

  const PERIODS: Period[] = ["today", "7d", "30d", "all"];

  return (
    <div className="flex flex-col gap-5">
      {/* Period selector */}
      <div className="flex items-center gap-2">
        <div className="grid grid-cols-4 rounded-md bg-muted p-0.5">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={`rounded-[5px] px-3 py-1 text-xs transition-colors ${
                period === p
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t(`settings.usage.period.${p}` as Parameters<typeof t>[0])}
            </button>
          ))}
        </div>
        <span className="ml-auto text-sm font-semibold tabular-nums">
          {t("settings.usage.total")}: {formatUsd(llmTotal + sttTotal)}
        </span>
      </div>

      {/* Two cost breakdowns */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-4">
          <div className="flex items-baseline justify-between">
            <h3 className="text-xs font-semibold tracking-tight">{t("settings.usage.llmCost")}</h3>
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {(tokens / 1000).toFixed(1)}k {t("settings.usage.tokens")}
            </span>
          </div>
          <PieChart slices={llm} centerLabel={formatUsd(llmTotal)} formatValue={formatUsd} />
        </div>

        <div className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-4">
          <div className="flex items-baseline justify-between">
            <h3 className="text-xs font-semibold tracking-tight">{t("settings.usage.sttCost")}</h3>
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {minutes.toFixed(1)} {t("settings.usage.minutes")}
            </span>
          </div>
          <PieChart slices={stt} centerLabel={formatUsd(sttTotal)} formatValue={formatUsd} />
        </div>
      </div>

      {events.length === 0 && (
        <p className="text-[11px] text-muted-foreground">{t("settings.usage.noData")}</p>
      )}
      <p className="text-[10px] leading-relaxed text-muted-foreground">{PRICING_NOTES}</p>
    </div>
  );
}
