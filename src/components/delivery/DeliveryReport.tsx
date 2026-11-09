import type { ReactNode } from "react";
import { ReportNav } from "../study/ReportNav";
import { useI18n } from "../../i18n";
import { useRelabel } from "../../lib/speakers/useRelabel";
import type { DeliveryAssessment } from "../../lib/types";
import { syllablesPerMin } from "../../lib/analysis/delivery";
import { clock, type SpeechStats } from "../../lib/analysis/speechStats";
import type { FillerCount } from "../../lib/analysis/fillerWords";
import { paceBand, talkBand } from "./bands";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceDot,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "../ui/chart";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Chart, Stamp } from "./chartCard";
import { cn } from "@/lib/utils";

type TFn = ReturnType<typeof useI18n>["t"];

const sec = (ms: number) => (ms / 1000).toFixed(1);

/** Chart marks are grey only (see --chart-* in index.css): emphasis, then normal. */
const MARK_STRONG = "var(--chart-1)";
const MARK = "var(--chart-2)";
const AXIS_TICK = { fontSize: 10, fill: "var(--muted-foreground)" };
const ANIMATION_MS = 300;

// ── Building blocks ────────────────────────────────────────────────────────────

/** One headline number at the top of the report. */
function Kpi({ label, value, unit, sub, watch }: Readonly<{ label: string; value: string; unit?: string; sub?: string; watch?: boolean }>) {
  return (
    <Card size="sm" className="min-w-0 gap-1 shadow-none">
      <CardHeader>
        <CardTitle className="truncate text-xs font-normal text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={cn("text-2xl leading-tight font-semibold tabular-nums", watch && "text-warning-text")}>
          {value}
          {unit && <small className="ml-1 text-xs font-medium text-muted-foreground">{unit}</small>}
        </div>
        {sub && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

/** A numbered section of the report. */
function ReportGroup({
  id,
  n,
  title,
  desc,
  children,
}: Readonly<{ id: string; n: string; title: string; desc: string; children: ReactNode }>) {
  return (
    <section id={id} data-report-section className="flex scroll-mt-4 flex-col gap-3 border-t pt-6">
      {/* Title on the left, what the section covers on the right. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
        <div className="flex items-baseline gap-x-2">
          <span className="font-mono text-xs font-semibold text-muted-foreground">{n}</span>
          <h3 className="text-base font-semibold">{title}</h3>
        </div>
        <p className="text-[11px] text-muted-foreground">{desc}</p>
      </div>
      {children}
    </section>
  );
}

// ── Charts ─────────────────────────────────────────────────────────────────────

/** Pace over the meeting: a thin line per bucket, the average dashed across. */
function PaceLine({ stats, t }: Readonly<{ stats: SpeechStats; t: TFn }>) {
  const pts = stats.paceTimeline;
  const values = pts.map((p) => p.perMin);
  const avg = Math.round(stats.textPace ?? values.reduce((a, b) => a + b, 0) / values.length);
  // Plot each bucket at its centre so the line spans the meeting rather than starting late.
  const data = pts.map((p) => ({ x: p.atMs + stats.bucketMs / 2, atMs: p.atMs, perMin: p.perMin }));
  const fastest = data.reduce((m, p) => (p.perMin > m.perMin ? p : m), data[0]);
  const slowest = data.reduce((m, p) => (p.perMin < m.perMin ? p : m), data[0]);
  // A padded, rounded value range with three ticks: bottom, middle, top.
  const lo = Math.max(0, Math.floor((Math.min(...values, avg) * 0.85) / 10) * 10);
  const hi = Math.max(lo + 10, Math.ceil((Math.max(...values, avg) * 1.08) / 10) * 10);
  const yTicks = [lo, Math.round((lo + hi) / 2), hi];
  const duration = Math.max(stats.durationMs, 1);
  const unit = t("delivery.unit.sylPerMin");
  const config = { perMin: { label: unit, color: MARK_STRONG } } satisfies ChartConfig;
  return (
    <Chart
      title={t("delivery.chart.pace")}
      note={
        pts.length > 1 && (
          <>
            {t("delivery.chart.pace.fastest", { v: String(fastest.perMin) })}
            <Stamp ms={fastest.atMs} />
            <span className="mx-1.5">·</span>
            {t("delivery.chart.pace.slowest", { v: String(slowest.perMin) })}
            <Stamp ms={slowest.atMs} />
          </>
        )
      }
    >
      <ChartContainer config={config} className="aspect-auto h-[144px] w-full tabular-nums">
        <AreaChart data={data} margin={{ top: 10, right: 14, bottom: 4, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" strokeOpacity={0.6} />
          <XAxis
            dataKey="x"
            type="number"
            domain={[0, duration]}
            ticks={[0, duration / 2, duration]}
            tickFormatter={(ms: number) => clock(ms)}
            axisLine={false}
            tickLine={false}
            tickMargin={6}
            tick={AXIS_TICK}
            height={24}
          />
          <YAxis
            domain={[lo, hi]}
            ticks={yTicks}
            axisLine={false}
            tickLine={false}
            tickMargin={4}
            tick={AXIS_TICK}
            width={28}
          />
          <ChartTooltip
            cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
            content={
              <ChartTooltipContent
                hideIndicator
                className="min-w-0"
                labelFormatter={(_, payload) => clock(Number(payload?.[0]?.payload?.atMs ?? 0))}
                formatter={(value) => (
                  <span className="font-mono tabular-nums">
                    {String(value)}
                    <span className="ml-1 font-sans text-muted-foreground">{unit}</span>
                  </span>
                )}
              />
            }
          />
          <ReferenceLine
            y={avg}
            stroke="var(--muted-foreground)"
            strokeOpacity={0.5}
            strokeDasharray="4 4"
            label={{ value: t("delivery.chart.pace.avg", { v: String(avg) }), position: "insideTopRight", fontSize: 10, fill: "var(--muted-foreground)" }}
          />
          <Area
            dataKey="perMin"
            type="monotone"
            stroke="var(--color-perMin)"
            strokeWidth={1.5}
            fill={MARK}
            fillOpacity={0.25}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0, fill: "var(--color-perMin)" }}
            animationDuration={ANIMATION_MS}
          />
          <ReferenceDot x={fastest.x} y={fastest.perMin} r={3} fill={MARK_STRONG} stroke="var(--background)" strokeWidth={1.5} />
          <ReferenceDot x={slowest.x} y={slowest.perMin} r={3} fill={MARK} stroke="var(--background)" strokeWidth={1.5} />
        </AreaChart>
      </ChartContainer>
    </Chart>
  );
}

/** Where the pauses fell: one thin bar per pause at its time, taller for longer ones. */
function PauseStrip({ stats, t }: Readonly<{ stats: SpeechStats; t: TFn }>) {
  const longest = stats.pauses.reduce((m, p) => (p.ms > m.ms ? p : m), stats.pauses[0]);
  const duration = Math.max(stats.durationMs, 1);
  const data = stats.pauses.map((p) => ({ atMs: p.atMs, seconds: Number(sec(p.ms)), longest: p === longest }));
  const top = Math.max(1, Math.ceil(longest.ms / 1000));
  const config = { seconds: { label: t("delivery.kpi.pauses"), color: MARK } } satisfies ChartConfig;
  return (
    <Chart
      title={t("delivery.chart.pauses")}
      note={
        <>
          {t("delivery.chart.pauses.longest", { s: sec(longest.ms) })}
          <Stamp ms={longest.atMs} />
        </>
      }
    >
      <ChartContainer config={config} className="aspect-auto h-[144px] w-full tabular-nums">
        <BarChart data={data} margin={{ top: 10, right: 14, bottom: 4, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" strokeOpacity={0.6} />
          <XAxis
            dataKey="atMs"
            type="number"
            domain={[0, duration]}
            ticks={[0, duration / 2, duration]}
            tickFormatter={(ms: number) => clock(ms)}
            axisLine={false}
            tickLine={false}
            tickMargin={6}
            tick={AXIS_TICK}
            height={24}
          />
          <YAxis
            domain={[0, top]}
            ticks={[0, top]}
            tickFormatter={(s: number) => `${s}s`}
            axisLine={false}
            tickLine={false}
            tickMargin={4}
            tick={AXIS_TICK}
            width={28}
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                hideIndicator
                className="min-w-0"
                labelFormatter={(_, payload) => clock(Number(payload?.[0]?.payload?.atMs ?? 0))}
                formatter={(value) => (
                  <span className="font-mono tabular-nums">{t("delivery.chart.pauses.length", { s: String(value) })}</span>
                )}
              />
            }
          />
          <Bar dataKey="seconds" barSize={3} radius={[2, 2, 0, 0]} minPointSize={2} animationDuration={ANIMATION_MS}>
            {data.map((d) => (
              <Cell key={d.atMs} fill={d.longest ? MARK_STRONG : MARK} />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
    </Chart>
  );
}

const WORD_ROW_PX = 24;

/** Ranked horizontal bars: which words, how often; the top one is drawn darker. */
function WordBars({ items, total }: Readonly<{ items: FillerCount[]; total: number }>) {
  const data = items.map((f) => ({
    word: f.word,
    count: f.count,
    label: `${f.count} · ${Math.round((f.count / Math.max(total, 1)) * 100)}%`,
  }));
  const config = { count: { label: "", color: MARK } } satisfies ChartConfig;
  return (
    <ChartContainer
      config={config}
      className="aspect-auto w-full tabular-nums"
      style={{ height: data.length * WORD_ROW_PX + 4 }}
    >
      <BarChart data={data} layout="vertical" margin={{ top: 2, right: 56, bottom: 2, left: 0 }} barCategoryGap={6}>
        <XAxis type="number" dataKey="count" domain={[0, "dataMax"]} hide />
        <YAxis
          type="category"
          dataKey="word"
          axisLine={false}
          tickLine={false}
          tickMargin={6}
          tick={{ fontSize: 11, fill: "var(--foreground)", fillOpacity: 0.85 }}
          width="auto"
        />
        <Bar dataKey="count" radius={3} animationDuration={ANIMATION_MS}>
          {data.map((d, i) => (
            <Cell key={d.word} fill={i === 0 ? MARK_STRONG : MARK} />
          ))}
          <LabelList dataKey="label" position="right" offset={6} fontSize={10} fill="var(--muted-foreground)" />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

// ── Report ─────────────────────────────────────────────────────────────────────

/**
 * The 評分 report: headline numbers, then the metrics in groups — 語速與停頓
 * and 語言習慣 — each drawn as a chart, and the AI's tone read (passed in as
 * `tone`) last. There is no conversation-interaction group: turn-taking,
 * interruptions and talk-over-time repeated what the replay already shows. Everything but the tone comes from the saved transcript; a
 * fact the recording can't answer is left out rather than shown as a dash.
 */
export function DeliveryReport({
  title,
  stats,
  ratio,
  measuredRate,
  assessment,
  tone,
}: Readonly<{
  /** The headline over the numbers; defaults to 這場你的說話特徵, null = none. */
  title?: string | null;
  stats: SpeechStats;
  ratio: { me: number; them: number } | null;
  measuredRate: number | null;
  assessment: DeliveryAssessment | null;
  tone: ReactNode;
}>) {
  const { t } = useI18n();
  const relabel = useRelabel();
  const talkMin = stats.myTalkMs / 60_000;
  const pace = measuredRate ? syllablesPerMin(measuredRate) : stats.textPace;
  const band = measuredRate ? paceBand(measuredRate) : null;
  const share = ratio ? talkBand(ratio.me) : null;
  const fillerRate = talkMin >= 0.5 ? (stats.fillerTotal / talkMin).toFixed(1) : null;
  const avgPause = stats.pauses.length ? stats.pauses.reduce((a, p) => a + p.ms, 0) / stats.pauses.length : 0;
  const frequent = assessment?.fillers.level === "frequent";

  const nav = [
    { id: "delivery-profile", label: t("delivery.nav.profile") },
    ...(stats.paceTimeline.length > 1 || stats.pauses.length > 0 ? [{ id: "delivery-pace", label: `01 ${t("delivery.nav.pace")}` }] : []),
    { id: "delivery-habits", label: `02 ${t("delivery.nav.habits")}` },
    { id: "delivery-tone", label: `03 ${t("delivery.nav.tone")}` },
  ];

  return (
    <div className="grid grid-cols-1 gap-3 @min-[680px]:grid-cols-[minmax(0,1fr)_128px] @min-[680px]:gap-8">
    <div className="order-1 flex min-w-0 flex-col gap-6 @min-[680px]:order-none">
      {/* 這場你的說話特徵: the headline numbers. */}
      <section id="delivery-profile" data-report-section className="scroll-mt-4">
      {title !== null && <h2 className="mb-3 text-base font-semibold">{title ?? t("delivery.profile")}</h2>}
      <div className="grid grid-cols-2 gap-3 @min-[520px]:grid-cols-4">
        {pace != null && (
          <Kpi
            label={t("delivery.kpi.pace")}
            value={String(pace)}
            unit={t("delivery.unit.sylPerMin")}
            sub={band ? t(band.key) : t("delivery.kpi.pace.fromText")}
            watch={!!band?.watch}
          />
        )}
        <Kpi
          label={t("delivery.kpi.fillers")}
          value={String(stats.fillerTotal)}
          unit={t("delivery.unit.times")}
          sub={fillerRate ? t("delivery.kpi.perMin", { n: fillerRate }) : undefined}
          watch={frequent}
        />
        {ratio && share && (
          <Kpi label={t("delivery.card.talkRatio")} value={`${Math.round(ratio.me * 100)}%`} sub={t(share.key)} watch={share.watch} />
        )}
        <Kpi
          label={t("delivery.kpi.pauses")}
          value={String(stats.pauses.length)}
          unit={t("delivery.unit.times")}
          sub={stats.pauses.length ? t("delivery.kpi.avgSec", { s: sec(avgPause) }) : undefined}
        />
      </div>
      </section>

      {/* 01 語速與停頓 */}
      {(stats.paceTimeline.length > 1 || stats.pauses.length > 0) && (
        <ReportGroup id="delivery-pace" n="01" title={t("delivery.group.pace")} desc={t("delivery.group.pace.desc")}>
          <div className="grid grid-cols-1 gap-3 @min-[640px]:grid-cols-2">
            {stats.paceTimeline.length > 1 && <PaceLine stats={stats} t={t} />}
            {stats.pauses.length > 0 && <PauseStrip stats={stats} t={t} />}
          </div>
        </ReportGroup>
      )}

      {/* 02 語言習慣 */}
      <ReportGroup id="delivery-habits" n="02" title={t("delivery.group.habits")} desc={t("delivery.group.habits.desc")}>
        <div className="grid grid-cols-1 gap-3 @min-[640px]:grid-cols-2">
          <Chart
            title={t("delivery.chart.fillers")}
            note={
              assessment && (
                <span className={frequent ? "text-warning-foreground" : ""}>
                  {t("delivery.chart.fillers.ai", { level: t(frequent ? "delivery.filler.frequent" : "delivery.filler.ok") })}
                  {assessment.fillers.note ? ` · ${relabel(assessment.fillers.note)}` : ""}
                </span>
              )
            }
          >
            {stats.fillers.length > 0 ? (
              <WordBars items={stats.fillers} total={stats.fillerTotal} />
            ) : (
              <p className="text-xs text-muted-foreground">{t("delivery.chart.fillers.none")}</p>
            )}
          </Chart>
          <Chart title={t("delivery.chart.repeats")}>
            {stats.repetitions.length > 0 ? (
              <>
                <div className="text-2xl leading-tight font-semibold tabular-nums">
                  {stats.repetitions.length}
                  <small className="ml-1 text-xs font-medium text-muted-foreground">{t("delivery.unit.times")}</small>
                </div>
                <ul className="mt-2 flex flex-col divide-y divide-border/60 text-xs">
                  {stats.repetitions.slice(0, 4).map((r) => (
                    <li key={`${r.atMs}-${r.text}`} className="flex items-center justify-between gap-2 py-1.5 first:pt-0 last:pb-0">
                      <span className="truncate text-foreground/85">「{r.text}」</span>
                      <Stamp ms={r.atMs} />
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">{t("delivery.chart.repeats.none")}</p>
            )}
          </Chart>
        </div>
      </ReportGroup>

      {/* 03 語氣與整體表達 */}
      <ReportGroup id="delivery-tone" n="03" title={t("delivery.group.tone")} desc={t("delivery.group.tone.desc")}>
        {tone}
      </ReportGroup>
    </div>
    <ReportNav items={nav} label={t("delivery.nav.aria")} />
    </div>
  );
}
