import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import type { DeliveryAssessment } from "../../lib/types";
import { syllablesPerMin } from "../../lib/analysis/delivery";
import { clock, type SpeechStats } from "../../lib/analysis/speechStats";
import type { FillerCount } from "../../lib/analysis/fillerWords";
import { paceBand, talkBand } from "./bands";

type TFn = ReturnType<typeof useI18n>["t"];

const sec = (ms: number) => (ms / 1000).toFixed(1);

// ── Building blocks ────────────────────────────────────────────────────────────

/** One headline number at the top of the report. */
function Kpi({ label, value, unit, sub, watch }: Readonly<{ label: string; value: string; unit?: string; sub?: string; watch?: boolean }>) {
  return (
    <div className="min-w-0">
      <div className={`text-3xl leading-tight font-bold tabular-nums ${watch ? "text-warning-foreground" : ""}`}>
        {value}
        {unit && <small className="ml-1 text-sm font-medium text-muted-foreground">{unit}</small>}
      </div>
      <div className="mt-0.5 truncate text-xs text-muted-foreground">
        {label}
        {sub && <span className="ml-1.5 text-muted-foreground/70">· {sub}</span>}
      </div>
    </div>
  );
}

/** A numbered section of the report. */
function ReportGroup({
  id,
  n,
  title,
  en,
  desc,
  children,
}: Readonly<{ id: string; n: string; title: string; en: string; desc: string; children: ReactNode }>) {
  return (
    <section id={id} data-report-section className="flex scroll-mt-4 flex-col gap-3 border-t pt-6">
      <div>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-xs font-semibold text-primary">{n}</span>
          <h3 className="text-base font-semibold">{title}</h3>
          <span className="text-xs text-muted-foreground">{en}</span>
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{desc}</p>
      </div>
      {children}
    </section>
  );
}

/** A chart with a title and a one-line reading of it. */
function Chart({ title, note, children }: Readonly<{ title: string; note?: ReactNode; children: ReactNode }>) {
  return (
    <figure className="m-0 min-w-0 rounded-lg border bg-muted/10 p-3">
      <figcaption className="mb-2 text-[11px] font-semibold text-muted-foreground">{title}</figcaption>
      {children}
      {note && <p className="mt-2 text-[11px] text-muted-foreground">{note}</p>}
    </figure>
  );
}

/** A small fact: label over value. */
function Fact({ label, value, sub }: Readonly<{ label: string; value: ReactNode; sub?: ReactNode }>) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-[10.5px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Stamp({ ms }: Readonly<{ ms: number }>) {
  return (
    <span className="ml-1 rounded bg-primary/10 px-1 py-px font-mono text-[10px] text-primary">{clock(ms)}</span>
  );
}

/** Time ticks under a timeline chart: start, middle, end. */
function TimeAxis({ durationMs }: Readonly<{ durationMs: number }>) {
  return (
    <div className="mt-1 flex justify-between font-mono text-[9.5px] text-muted-foreground/80">
      <span>0:00</span>
      <span>{clock(durationMs / 2)}</span>
      <span>{clock(durationMs)}</span>
    </div>
  );
}

// ── Charts ─────────────────────────────────────────────────────────────────────

/** Pace over the meeting: a line per bucket, the average dashed across. */
function PaceLine({ stats, t }: Readonly<{ stats: SpeechStats; t: TFn }>) {
  const pts = stats.paceTimeline;
  const W = 300;
  const H = 90;
  const values = pts.map((p) => p.perMin);
  const avg = stats.textPace ?? values.reduce((a, b) => a + b, 0) / values.length;
  const lo = Math.max(0, Math.min(...values, avg) * 0.85);
  const hi = Math.max(...values, avg) * 1.1 || 1;
  const x = (atMs: number) => ((atMs + stats.bucketMs / 2) / Math.max(stats.durationMs, 1)) * W;
  const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
  const fastest = pts.reduce((m, p) => (p.perMin > m.perMin ? p : m), pts[0]);
  const slowest = pts.reduce((m, p) => (p.perMin < m.perMin ? p : m), pts[0]);
  return (
    <Chart
      title={t("delivery.chart.pace")}
      note={
        pts.length > 1 && (
          <>
            {t("delivery.chart.pace.fastest", { v: String(fastest.perMin) })}
            <Stamp ms={fastest.atMs} />
            {" · "}
            {t("delivery.chart.pace.slowest", { v: String(slowest.perMin) })}
            <Stamp ms={slowest.atMs} />
          </>
        )
      }
    >
      <div className="flex gap-2">
        <div className="flex flex-col justify-between py-0.5 font-mono text-[9.5px] text-muted-foreground/80">
          <span>{Math.round(hi)}</span>
          <span>{Math.round(lo)}</span>
        </div>
        <div className="min-w-0 flex-1">
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-24 w-full overflow-visible" aria-hidden="true">
            <line x1="0" x2={W} y1={y(avg)} y2={y(avg)} className="stroke-muted-foreground/40" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
            <polygon
              points={`${x(pts[0].atMs)},${H} ${pts.map((p) => `${x(p.atMs)},${y(p.perMin)}`).join(" ")} ${x(pts[pts.length - 1].atMs)},${H}`}
              className="fill-primary/10"
            />
            <polyline
              points={pts.map((p) => `${x(p.atMs)},${y(p.perMin)}`).join(" ")}
              className="fill-none stroke-primary"
              strokeWidth="2"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <TimeAxis durationMs={stats.durationMs} />
        </div>
      </div>
    </Chart>
  );
}

/** Where the pauses fell: one mark per pause, taller for longer ones. */
function PauseStrip({ stats, t }: Readonly<{ stats: SpeechStats; t: TFn }>) {
  const longest = stats.pauses.reduce((m, p) => (p.ms > m.ms ? p : m), stats.pauses[0]);
  const max = longest.ms;
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
      <div className="relative h-10 border-b border-border">
        {stats.pauses.map((p) => (
          <span
            key={p.atMs}
            className={`absolute bottom-0 w-[3px] -translate-x-1/2 rounded-t-sm ${p === longest ? "bg-primary" : "bg-primary/45"}`}
            style={{ left: `${(p.atMs / Math.max(stats.durationMs, 1)) * 100}%`, height: `${Math.max(15, (p.ms / max) * 100)}%` }}
            title={`${clock(p.atMs)} · ${sec(p.ms)}s`}
          />
        ))}
      </div>
      <TimeAxis durationMs={stats.durationMs} />
    </Chart>
  );
}

/** Ranked horizontal bars: which words, how often. */
function WordBars({ items, total }: Readonly<{ items: FillerCount[]; total: number }>) {
  const max = Math.max(...items.map((i) => i.count), 1);
  return (
    <div className="grid grid-cols-[max-content_minmax(0,1fr)_max-content] items-center gap-x-2 gap-y-1.5 text-xs">
      {items.map((f, i) => (
        <div key={f.word} className="col-span-3 grid grid-cols-subgrid items-center">
          <span className="max-w-24 truncate text-foreground/85">{f.word}</span>
          <span className="h-2.5 overflow-hidden rounded-sm bg-muted">
            <span className={`block h-full rounded-sm ${i === 0 ? "bg-primary" : "bg-primary/55"}`} style={{ width: `${(f.count / max) * 100}%` }} />
          </span>
          <span className="text-right tabular-nums text-muted-foreground">
            {f.count}
            <small className="ml-1 text-[10px]">{Math.round((f.count / Math.max(total, 1)) * 100)}%</small>
          </span>
        </div>
      ))}
    </div>
  );
}

/** Who talked when: stacked columns, the user's share on the bottom. */
function TalkColumns({ stats, t }: Readonly<{ stats: SpeechStats; t: TFn }>) {
  const max = Math.max(...stats.talk.map((s) => s.meMs + s.themMs), 1);
  const twoSides = stats.interaction !== null;
  return (
    <Chart
      title={t("delivery.chart.talk")}
      note={
        twoSides && (
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <i className="inline-block size-2 rounded-sm bg-primary" />
              {t("delivery.legend.me")}
            </span>
            <span className="flex items-center gap-1">
              <i className="inline-block size-2 rounded-sm bg-muted-foreground/35" />
              {t("delivery.legend.them")}
            </span>
          </span>
        )
      }
    >
      <div className="flex h-20 items-end gap-px">
        {stats.talk.map((s) => (
          <div key={s.atMs} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${clock(s.atMs)}`}>
            <span className="block rounded-t-sm bg-muted-foreground/35" style={{ height: `${(s.themMs / max) * 100}%` }} />
            <span className="block bg-primary" style={{ height: `${(s.meMs / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <TimeAxis durationMs={stats.durationMs} />
    </Chart>
  );
}

/** A ring for the talk share. */
function ShareRing({ me }: Readonly<{ me: number }>) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 64 64" className="size-16 shrink-0 -rotate-90" aria-hidden="true">
      <circle cx="32" cy="32" r={r} className="fill-none stroke-muted" strokeWidth="8" />
      <circle cx="32" cy="32" r={r} className="fill-none stroke-primary" strokeWidth="8" strokeDasharray={`${me * c} ${c}`} />
    </svg>
  );
}

// ── Report ─────────────────────────────────────────────────────────────────────

/**
 * The 評分 report: headline numbers, then the metrics in groups — 語速與停頓,
 * 語言習慣, 對話互動 — each drawn as a chart, and the AI's tone read (passed in
 * as `tone`) last. Everything but the tone comes from the saved transcript; a
 * fact the recording can't answer is left out rather than shown as a dash.
 */
export function DeliveryReport({
  stats,
  ratio,
  measuredRate,
  assessment,
  tone,
}: Readonly<{
  stats: SpeechStats;
  ratio: { me: number; them: number } | null;
  measuredRate: number | null;
  assessment: DeliveryAssessment | null;
  tone: ReactNode;
}>) {
  const { t } = useI18n();
  const talkMin = stats.myTalkMs / 60_000;
  const pace = measuredRate ? syllablesPerMin(measuredRate) : stats.textPace;
  const band = measuredRate ? paceBand(measuredRate) : null;
  const share = ratio ? talkBand(ratio.me) : null;
  const fillerRate = talkMin >= 0.5 ? (stats.fillerTotal / talkMin).toFixed(1) : null;
  const ia = stats.interaction;
  const avgPause = stats.pauses.length ? stats.pauses.reduce((a, p) => a + p.ms, 0) / stats.pauses.length : 0;
  const frequent = assessment?.fillers.level === "frequent";

  const nav = [
    { id: "delivery-profile", label: t("delivery.nav.profile") },
    ...(stats.paceTimeline.length > 1 || stats.pauses.length > 0 ? [{ id: "delivery-pace", label: `01 ${t("delivery.nav.pace")}` }] : []),
    { id: "delivery-habits", label: `02 ${t("delivery.nav.habits")}` },
    ...(ratio || stats.talk.length > 1 ? [{ id: "delivery-interaction", label: `03 ${t("delivery.nav.interaction")}` }] : []),
    { id: "delivery-tone", label: `04 ${t("delivery.nav.tone")}` },
  ];

  return (
    <div className="grid grid-cols-1 gap-3 @min-[680px]:grid-cols-[minmax(0,1fr)_128px] @min-[680px]:gap-8">
    <div className="order-1 flex min-w-0 flex-col gap-6 @min-[680px]:order-none">
      {/* 這場你的說話特徵: the headline numbers. */}
      <section id="delivery-profile" data-report-section className="scroll-mt-4">
      <h2 className="mb-3 text-base font-semibold">{t("delivery.profile")}</h2>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 @min-[520px]:grid-cols-4">
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
        <ReportGroup id="delivery-pace" n="01" en="Speech Fluency" title={t("delivery.group.pace")} desc={t("delivery.group.pace.desc")}>
          <div className="grid grid-cols-1 gap-3 @min-[640px]:grid-cols-2">
            {stats.paceTimeline.length > 1 && <PaceLine stats={stats} t={t} />}
            {stats.pauses.length > 0 && <PauseStrip stats={stats} t={t} />}
          </div>
        </ReportGroup>
      )}

      {/* 02 語言習慣 */}
      <ReportGroup id="delivery-habits" n="02" en="Disfluency Patterns" title={t("delivery.group.habits")} desc={t("delivery.group.habits.desc")}>
        <div className="grid grid-cols-1 gap-3 @min-[640px]:grid-cols-2">
          <Chart
            title={t("delivery.chart.fillers")}
            note={
              assessment && (
                <span className={frequent ? "text-warning-foreground" : ""}>
                  {t("delivery.chart.fillers.ai", { level: t(frequent ? "delivery.filler.frequent" : "delivery.filler.ok") })}
                  {assessment.fillers.note ? ` · ${assessment.fillers.note}` : ""}
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
                <div className="text-xl font-bold tabular-nums">
                  {stats.repetitions.length}
                  <small className="ml-0.5 text-xs font-medium text-muted-foreground">{t("delivery.unit.times")}</small>
                </div>
                <ul className="mt-2 flex flex-col gap-1 text-xs">
                  {stats.repetitions.slice(0, 4).map((r) => (
                    <li key={`${r.atMs}-${r.text}`} className="flex items-center justify-between gap-2">
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

      {/* 03 對話互動 */}
      {(ratio || stats.talk.length > 1) && (
        <ReportGroup id="delivery-interaction" n="03" en="Conversational Dynamics" title={t("delivery.group.interaction")} desc={t("delivery.group.interaction.desc")}>
          <div className="grid grid-cols-1 gap-3 @min-[640px]:grid-cols-2">
            {ratio && share && (
              <Chart title={t("delivery.card.talkRatio")}>
                <div className="flex items-center gap-4">
                  <ShareRing me={ratio.me} />
                  <div className="text-xs">
                    <div className="text-xl font-bold tabular-nums">{Math.round(ratio.me * 100)}%</div>
                    <div className="text-muted-foreground">
                      {t(share.key)} · {t("delivery.share", { me: String(Math.round(ratio.me * 100)), them: String(100 - Math.round(ratio.me * 100)) })}
                    </div>
                  </div>
                </div>
              </Chart>
            )}
            {stats.talk.length > 1 && <TalkColumns stats={stats} t={t} />}
          </div>
          {ia && (
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border bg-muted/10 p-3 @min-[640px]:grid-cols-3">
              <Fact label={t("delivery.fact.turns")} value={`${ia.turns} ${t("delivery.unit.times")}`} sub={t("delivery.fact.avgTurn", { s: sec(ia.avgTurnMs) })} />
              {ia.longestTurn && (
                <Fact
                  label={t("delivery.fact.longestTurn")}
                  value={`${sec(ia.longestTurn.ms)} ${t("delivery.unit.sec")}`}
                  sub={<Stamp ms={ia.longestTurn.atMs} />}
                />
              )}
              {ia.medianLatencyMs != null && (
                <Fact label={t("delivery.fact.latency")} value={`${sec(ia.medianLatencyMs)} ${t("delivery.unit.sec")}`} sub={t("delivery.fact.latency.sub")} />
              )}
              <Fact label={t("delivery.fact.interruptions")} value={`${ia.interruptions} ${t("delivery.unit.times")}`} />
              <Fact
                label={t("delivery.fact.backchannels")}
                value={`${ia.backchannelTotal} ${t("delivery.unit.times")}`}
                sub={ia.backchannels.length > 0 && ia.backchannels.map((b) => `${b.word} ${b.count}`).join(" · ")}
              />
            </div>
          )}
        </ReportGroup>
      )}

      {/* 04 語氣與整體表達 */}
      <ReportGroup id="delivery-tone" n="04" en="Tone & Delivery" title={t("delivery.group.tone")} desc={t("delivery.group.tone.desc")}>
        {tone}
      </ReportGroup>
    </div>
    <ReportNav items={nav} />
    </div>
  );
}

/**
 * The report's module nav, on the right: one entry per section, the one being
 * read highlighted, a click scrolling to it. Sticks while the report scrolls;
 * on a narrow pane it becomes a row above the report.
 */
function ReportNav({ items }: Readonly<{ items: { id: string; label: string }[] }>) {
  const { t } = useI18n();
  const [active, setActive] = useState(items[0]?.id ?? "");
  const ids = items.map((i) => i.id).join(",");
  useEffect(() => {
    const sections = ids
      .split(",")
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => !!el);
    if (sections.length === 0) return;
    // The section whose top has passed the upper third of the pane is current.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "0px 0px -65% 0px" },
    );
    for (const el of sections) observer.observe(el);
    return () => observer.disconnect();
  }, [ids]);
  return (
    <nav
      aria-label={t("delivery.nav.aria")}
      className="order-0 flex flex-row flex-wrap gap-1 border-b pb-2 text-xs @min-[680px]:sticky @min-[680px]:top-2 @min-[680px]:order-none @min-[680px]:flex-col @min-[680px]:self-start @min-[680px]:border-b-0 @min-[680px]:border-l @min-[680px]:pb-0 @min-[680px]:pl-2.5"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-current={active === item.id ? "true" : undefined}
          onClick={() => {
            setActive(item.id);
            document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
          className={`cursor-pointer truncate rounded-md px-2 py-1 text-left transition-colors ${
            active === item.id ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}

