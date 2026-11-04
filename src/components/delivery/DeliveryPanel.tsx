import { useMemo, type ReactNode } from "react";
import { Clock, Loader2 } from "lucide-react";
import { useStore } from "../../lib/store";
import { useStudyArtifactDisplay } from "../../lib/analysis/studyPipeline";
import { Skeleton } from "@/components/ui/skeleton";
import { useProsody } from "../../lib/analysis/useDelivery";
import { syllablesPerMin, talkTimeRatio } from "../../lib/analysis/delivery";
import { countFillerSounds } from "../../lib/analysis/fillerWords";
import { useI18n } from "../../i18n";
import type { TranslationKey } from "../../i18n";
import type {
  DeliveryAssessment,
  DeliveryToggles,
  ToneVerdict,
  TranscriptSegment,
} from "../../lib/types";

type TFn = ReturnType<typeof useI18n>["t"];
type DeliveryStatus = ReturnType<typeof useStore.getState>["deliveryStatus"];
type Prosody = ReturnType<typeof useProsody>;

/** Accent color per tone verdict — neutral/firm are fine, sharp+ warn. */
function toneClass(tone: ToneVerdict): string {
  switch (tone) {
    case "rude":
    case "aggressive":
      return "text-danger-foreground";
    case "sharp":
      return "text-warning-foreground";
    case "warm":
      return "text-success-foreground";
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

/** Map a live speaking rate (syllables/sec ≈ value × 60 字/分) to a band label +
 *  whether it warrants a watch (warning) accent. Reference points for Mandarin:
 *  ~180 字/分 normal conversation, ~240–300 presentation, 300+ fast. The single
 *  tuning knob is `FAST_HZ`: lower it to make "too fast" trigger sooner.
 *  4.0/s ≈ 240 字/分 (upper-presentation — deliberately on the sensitive side). */
const FAST_HZ = 4;
function paceBand(hz: number): { key: TranslationKey; watch: boolean } {
  if (hz > FAST_HZ) return { key: "delivery.pace.fast", watch: true };
  if (hz >= 2) return { key: "delivery.pace.comfortable", watch: false };
  return { key: "delivery.pace.slow", watch: false };
}

/** Shared label | bar | value grid for stacked {@link MeterRow}s. The label and
 *  value columns size to their longest content (no more hard-coded label width —
 *  "Intonation" overflowed it and ran into the bar), and subgrid keeps the
 *  columns aligned across rows. */
function MeterGroup({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5">
      {children}
    </div>
  );
}

/** One labeled meter row: name on the left, a bar in the middle, a number on the
 *  right. Must render inside a {@link MeterGroup}. Unifies the gauges that used to
 *  float unlabeled in the title bar — primary reads "fine", warning reads "worth a
 *  look", muted grey reads "no signal yet". */
function MeterRow({
  label,
  pct,
  watch,
  muted,
  value,
}: Readonly<{
  label: string;
  pct: number;
  watch: boolean;
  muted: boolean;
  value: string;
}>) {
  let bar = "bg-primary";
  if (muted) {
    bar = "bg-muted-foreground/30";
  } else if (watch) {
    bar = "bg-warning-foreground";
  }
  return (
    <div className="col-span-3 grid grid-cols-subgrid items-center">
      <span className="whitespace-nowrap text-muted-foreground">{label}</span>
      <span className="h-1.5 overflow-hidden rounded-full bg-muted">
        <span
          className={`block h-full rounded-full transition-[width] duration-200 ${bar}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span
        className={`whitespace-nowrap text-right tabular-nums ${
          watch ? "font-medium text-warning-foreground" : "text-foreground/80"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function livePaceValue(t: TFn, hasProsody: boolean, paceHz: number, band: ReturnType<typeof paceBand>): string {
  if (!hasProsody || paceHz <= 1) return "—";
  return `${syllablesPerMin(paceHz)} ${t("delivery.unit.sylPerMin")} · ${t(band.key)}`;
}

function intonationValue(t: TFn, hasProsody: boolean, sd: number): string {
  if (!hasProsody || sd <= 0) return "—";
  const key: TranslationKey = sd < 1.2 ? "delivery.intonation.flat" : "delivery.intonation.lively";
  return `±${sd.toFixed(1)} ${t("delivery.unit.semitones")} · ${t(key)}`;
}

function LiveFillerCount({
  count,
  t,
}: Readonly<{
  count: number;
  t: TFn;
}>) {
  const className = count >= 5 ? "font-medium text-warning-foreground" : "tabular-nums text-foreground/80";
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{t("delivery.card.fillerSounds")}</span>
      <span className={className}>
        {count} {t("delivery.unit.times")}
      </span>
    </div>
  );
}

function DeliveryReadout({
  mode,
  status,
  running,
  assessment,
  t,
}: Readonly<{
  mode: "live" | "replay";
  status: DeliveryStatus;
  running: boolean;
  assessment: DeliveryAssessment | null;
  t: TFn;
}>) {
  if (running) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        {t("delivery.card.analyzing")}
      </div>
    );
  }

  if (assessment) {
    const frequentFillers = assessment.fillers.level === "frequent";
    const fillerKey: TranslationKey = frequentFillers ? "delivery.filler.frequent" : "delivery.filler.ok";
    return (
      <>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-muted-foreground">{t("delivery.card.tone")}</span>
          <span className={`font-medium ${toneClass(assessment.tone)}`}>{t(TONE_KEY[assessment.tone])}</span>
        </div>
        {assessment.toneEvidence && (
          <p className="-mt-1 truncate text-[10px] italic text-muted-foreground">“{assessment.toneEvidence}”</p>
        )}
        <p className="-mt-0.5 text-[10px] text-muted-foreground/70">{t("delivery.card.tone.advisory")}</p>

        <div className="flex items-baseline justify-between gap-2">
          <span className="text-muted-foreground">{t("delivery.card.fillers")}</span>
          <span className={frequentFillers ? "font-medium text-warning-foreground" : "text-muted-foreground"}>
            {t(fillerKey)}
            {frequentFillers && assessment.fillers.examples.length > 0 && (
              <span className="ml-1 font-normal opacity-80">
                ({assessment.fillers.examples.slice(0, 3).join("、")})
              </span>
            )}
          </span>
        </div>

        {assessment.summary && <p className="mt-0.5 text-[11px] leading-snug text-foreground/80">{assessment.summary}</p>}
      </>
    );
  }

  if (mode === "replay" && status === "error") {
    return <p className="text-muted-foreground">{t("delivery.card.error")}</p>;
  }
  if (mode === "replay" && status === "done") {
    return <p className="text-muted-foreground">{t("delivery.card.none")}</p>;
  }
  if (mode === "live") {
    return <p className="text-muted-foreground">{t("delivery.card.waiting")}</p>;
  }
  return null;
}

/** One slice of the talk-volume strip. `startMs` doubles as its identity — the
 *  buckets tile a recording of at least 3 min into at most 60 slices, so no two
 *  ever start at the same offset. */
interface TalkBucket {
  startMs: number;
  voicedMs: number;
}

/** Per-bucket voiced ms of the user's own speech across the recording — a cheap,
 *  fully local "where was I talking (a lot)" strip. Empty for short recordings
 *  (< 3 min) and when the session has no source-split "me" segments. */
function talkVolumeBuckets(segments: TranscriptSegment[]): TalkBucket[] {
  const spoken = segments.filter((s) => s.isFinal && s.source === "me" && s.text.trim());
  if (spoken.length === 0) return [];
  let endMs = 0;
  for (const s of segments) if (s.isFinal && s.endMs > endMs) endMs = s.endMs;
  if (endMs < 3 * 60_000) return [];
  const count = Math.min(60, Math.ceil(endMs / 60_000));
  const bucketMs = endMs / count;
  const buckets: TalkBucket[] = Array.from({ length: count }, (_, i) => ({
    startMs: Math.round(i * bucketMs),
    voicedMs: 0,
  }));
  for (const s of spoken) {
    const i = Math.min(count - 1, Math.floor(s.startMs / bucketMs));
    buckets[i].voicedMs += Math.max(0, s.endMs - s.startMs);
  }
  return buckets;
}

/** Talk-share band: ≥65% of the talking reads as steamrolling, ≤35% as quiet. */
function talkBand(me: number): { key: TranslationKey; watch: boolean } {
  if (me >= 0.65) return { key: "delivery.talk.high", watch: true };
  if (me <= 0.35) return { key: "delivery.talk.low", watch: false };
  return { key: "delivery.talk.balanced", watch: false };
}

/** Everything the full-variant scorecard derives from the saved transcript. */
interface LocalDeliveryStats {
  ratio: ReturnType<typeof talkTimeRatio>;
  fillers: number;
  buckets: TalkBucket[];
}

/** Replay stats straight from the saved transcript — no model call. */
function computeLocalStats(segments: TranscriptSegment[]): LocalDeliveryStats {
  const ratio = talkTimeRatio(segments);
  let fillers = 0;
  for (const s of segments) {
    if (s.isFinal && s.source === "me") fillers += countFillerSounds(s.text);
  }
  return { ratio, fillers, buckets: talkVolumeBuckets(segments) };
}

/** The LLM read's placeholder, in the loaded readout's shape: tone row, the
 *  advisory line, fillers row, then a two-line summary. Same text sizes and
 *  gaps, so the box keeps its height when the assessment lands. */
function DeliveryReadoutSkeleton({ caption }: Readonly<{ caption: ReactNode }>) {
  return (
    <>
      <div className="flex h-4 items-center justify-between gap-2" aria-hidden="true">
        <Skeleton className="h-3 w-10" />
        <Skeleton className="h-3 w-14" />
      </div>
      {/* The advisory line's slot carries the status, so the wait is named. */}
      <output className="-mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground/70">
        {caption}
      </output>
      <div className="flex h-4 items-center justify-between gap-2" aria-hidden="true">
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-3 w-20" />
      </div>
      <div className="mt-0.5 flex flex-col gap-1.5" aria-hidden="true">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </>
  );
}


/** The per-minute strip of the user's own voiced time. */
function TalkVolumeStrip({ buckets }: Readonly<{ buckets: TalkBucket[] }>) {
  const max = Math.max(...buckets.map((b) => b.voicedMs), 1);
  return (
    <div className="flex h-8 w-full max-w-72 items-end gap-px" aria-hidden="true">
      {buckets.map((b) => (
        <span
          key={b.startMs}
          className={`min-w-0 flex-1 rounded-t-sm ${b.voicedMs === max ? "bg-primary" : "bg-primary/50"}`}
          style={{ height: `${Math.max(4, Math.round((b.voicedMs / max) * 100))}%` }}
        />
      ))}
    </div>
  );
}

/**
 * One group of the 評分 report: a number, a title, what it covers, then its
 * rows. Groups follow the speech-analysis proposal's modules (fluency, speech
 * habits, interaction) plus the AI's tone read, each holding only the metrics
 * Parley already has for a recording.
 */
function ReportGroup({
  n,
  title,
  desc,
  children,
}: Readonly<{ n: string; title: string; desc: string; children: ReactNode }>) {
  return (
    <section className="border-t pt-4 first:border-t-0 first:pt-0">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[11px] font-semibold text-primary">{n}</span>
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <p className="mt-0.5 mb-2 text-[11px] text-muted-foreground">{desc}</p>
      <div className="grid grid-cols-[max-content_max-content_minmax(0,1fr)] items-center gap-x-4">{children}</div>
    </section>
  );
}

/** One metric row: label | value | detail. Rows of a group share columns. */
function ReportRow({
  label,
  value,
  detail,
  watch,
}: Readonly<{ label: string; value: ReactNode; detail?: ReactNode; watch?: boolean }>) {
  return (
    <div className="col-span-3 grid grid-cols-subgrid items-center border-b border-border/60 py-2 text-xs last:border-b-0">
      <span className="whitespace-nowrap text-muted-foreground">{label}</span>
      <span className={`whitespace-nowrap font-semibold tabular-nums ${watch ? "text-warning-foreground" : ""}`}>
        {value}
      </span>
      <span className="min-w-0 text-[11px] text-muted-foreground">{detail}</span>
    </div>
  );
}

/** 01 語速: the measured pace when there is one, else the AI's read of it —
 *  one row either way (the old tile and the AI note said the same thing). */
function PaceGroup({
  t,
  measuredRate,
  assessment,
}: Readonly<{ t: TFn; measuredRate: number | null; assessment: DeliveryAssessment | null }>) {
  let row: ReactNode = null;
  if (measuredRate) {
    const band = paceBand(measuredRate);
    row = (
      <ReportRow
        label={t("delivery.card.pace")}
        value={
          <>
            {syllablesPerMin(measuredRate)} <small className="font-normal text-muted-foreground">{t("delivery.unit.sylPerMin")}</small>
          </>
        }
        detail={t(band.key)}
        watch={band.watch}
      />
    );
  } else if (assessment?.pace) {
    row = (
      <ReportRow
        label={t("delivery.card.pace")}
        value={t(`delivery.pace.${assessment.pace}` as TranslationKey)}
        detail={t("delivery.card.tone.advisory")}
      />
    );
  }
  if (!row) return null;
  return (
    <ReportGroup n="01" title={t("delivery.group.pace")} desc={t("delivery.group.pace.desc")}>
      {row}
    </ReportGroup>
  );
}

/** 02 口頭禪與贅字: the counted 痾/嗯 sounds and the AI's filler-word read,
 *  merged into one row — count, how dense, and the words themselves. */
function HabitsGroup({
  t,
  fillers,
  assessment,
}: Readonly<{ t: TFn; fillers: number; assessment: DeliveryAssessment | null }>) {
  const frequent = assessment?.fillers.level === "frequent";
  const examples = assessment?.fillers.examples.slice(0, 5) ?? [];
  let level: string | null = null;
  if (assessment) level = t(frequent ? "delivery.filler.frequent" : "delivery.filler.ok");
  return (
    <ReportGroup n="02" title={t("delivery.group.habits")} desc={t("delivery.group.habits.desc")}>
      <ReportRow
        label={t("delivery.row.fillers")}
        value={
          <>
            {fillers} <small className="font-normal text-muted-foreground">{t("delivery.unit.times")}</small>
          </>
        }
        watch={fillers >= 10 || frequent}
        detail={
          (level || examples.length > 0) && (
            <span className="flex flex-wrap items-center gap-1">
              {level && <span className={frequent ? "text-warning-foreground" : ""}>{level}</span>}
              {examples.map((w) => (
                <span key={w} className="rounded-full border bg-muted/40 px-1.5 text-[10.5px] text-foreground/80">
                  {w}
                </span>
              ))}
            </span>
          )
        }
      />
    </ReportGroup>
  );
}

/** 03 對話互動: talk share and where in the meeting you talked. Absent when
 *  the session can't tell you from the others. */
function InteractionGroup({ t, stats }: Readonly<{ t: TFn; stats: LocalDeliveryStats }>) {
  const ratio = stats.ratio;
  if (!ratio && stats.buckets.length === 0) return null;
  const band = ratio ? talkBand(ratio.me) : null;
  const me = ratio ? Math.round(ratio.me * 100) : 0;
  return (
    <ReportGroup n="03" title={t("delivery.group.interaction")} desc={t("delivery.group.interaction.desc")}>
      {ratio && band && (
        <ReportRow
          label={t("delivery.card.talkRatio")}
          value={`${me}%`}
          watch={band.watch}
          detail={
            <span className="flex flex-col gap-0.5">
              <span className="flex h-1.5 w-full max-w-56 overflow-hidden rounded-full bg-muted">
                <span className="bg-primary" style={{ width: `${me}%` }} />
              </span>
              <span>
                {t(band.key)} · {t("delivery.share", { me: String(me), them: String(100 - me) })}
              </span>
            </span>
          }
        />
      )}
      {stats.buckets.length > 0 && (
        <ReportRow label={t("delivery.row.timeline")} value="" detail={<TalkVolumeStrip buckets={stats.buckets} />} />
      )}
    </ReportGroup>
  );
}

/** 04 語氣與整體表達: the AI's tone verdict, its quote and its one-line read,
 *  together — they are one judgement, so they sit in one group. */
function ToneGroup({
  t,
  mode,
  status,
  running,
  assessment,
  pending,
}: Readonly<{
  t: TFn;
  mode: "live" | "replay";
  status: DeliveryStatus;
  running: boolean;
  assessment: DeliveryAssessment | null;
  pending: boolean;
}>) {
  let body: ReactNode;
  if (pending) {
    body = (
      <div className="col-span-3 flex flex-col gap-1.5 py-2 text-[11px]">
        <DeliveryReadoutSkeleton
          caption={
            running ? (
              <>
                <Loader2 className="size-2.5 animate-spin" />
                {t("delivery.card.analyzing")}
              </>
            ) : (
              <>
                <Clock className="size-2.5" />
                {t("delivery.card.queued")}
              </>
            )
          }
        />
      </div>
    );
  } else if (assessment) {
    body = (
      <>
        <ReportRow
          label={t("delivery.card.tone")}
          value={<span className={toneClass(assessment.tone)}>{t(TONE_KEY[assessment.tone])}</span>}
          detail={assessment.toneEvidence && <span className="italic">“{assessment.toneEvidence}”</span>}
        />
        {assessment.summary && (
          <p className="col-span-3 pt-2 text-xs leading-relaxed text-foreground/85">{assessment.summary}</p>
        )}
        <p className="col-span-3 pt-1 text-[10px] text-muted-foreground/70">{t("delivery.card.tone.advisory")}</p>
      </>
    );
  } else {
    body = (
      <div className="col-span-3 py-2 text-xs">
        <DeliveryReadout mode={mode} status={status} running={running} assessment={null} t={t} />
      </div>
    );
  }
  return (
    <ReportGroup n="04" title={t("delivery.group.tone")} desc={t("delivery.group.tone.desc")}>
      {body}
    </ReportGroup>
  );
}

/** The study tense's 評分 report (`variant="full"`): the metrics grouped, the
 *  duplicates merged — numbers from the saved transcript, the tone from AI. */
function DeliveryScorecard({
  mode,
  stats,
  measuredRate,
  assessment,
  status,
  running,
  t,
}: Readonly<{
  mode: "live" | "replay";
  stats: LocalDeliveryStats;
  measuredRate: number | null;
  assessment: DeliveryAssessment | null;
  status: DeliveryStatus;
  running: boolean;
  t: TFn;
}>) {
  // Queued (waiting on the findings pass) or running, with nothing to show yet.
  const display = useStudyArtifactDisplay("delivery");
  const pending = !assessment && (running || display === "queued");
  return (
    <div className="flex flex-col gap-4">
      <PaceGroup t={t} measuredRate={measuredRate} assessment={assessment} />
      <HabitsGroup t={t} fillers={stats.fillers} assessment={assessment} />
      <InteractionGroup t={t} stats={stats} />
      <ToneGroup t={t} mode={mode} status={status} running={running} assessment={assessment} pending={pending} />
    </div>
  );
}

/** Live ambient meters (mic-anchored): pace and intonation. */
function LiveMeters({
  t,
  prosody,
  paceOn,
  pitchOn,
}: Readonly<{ t: TFn; prosody: Prosody; paceOn: boolean; pitchOn: boolean }>) {
  if (!paceOn && !pitchOn) return null;
  // Null prosody → muted "—" until the first sample.
  const paceHz = prosody?.speechRateHz ?? 0;
  const sd = prosody?.pitchVarSemitones ?? 0;
  const band = paceBand(paceHz);
  const hasProsody = !!prosody;
  return (
    <MeterGroup>
      {paceOn && (
        <MeterRow
          label={t("delivery.card.pace")}
          pct={Math.min(100, Math.round((paceHz / 6) * 100))}
          watch={band.watch}
          muted={!hasProsody || paceHz <= 1}
          value={livePaceValue(t, hasProsody, paceHz, band)}
        />
      )}
      {pitchOn && (
        <MeterRow
          label={t("delivery.card.intonation")}
          pct={Math.min(100, Math.round((sd / 3) * 100))}
          watch={sd > 0 && sd < 1.2}
          muted={!hasProsody || sd <= 0}
          value={intonationValue(t, hasProsody, sd)}
        />
      )}
    </MeterGroup>
  );
}

/** Replay's acoustically MEASURED pace — from Rust, not an LLM guess. */
function MeasuredPaceMeter({ t, rate }: Readonly<{ t: TFn; rate: number }>) {
  const band = paceBand(rate);
  return (
    <MeterGroup>
      <MeterRow
        label={t("delivery.card.pace")}
        pct={Math.min(100, Math.round((rate / 6) * 100))}
        watch={band.watch}
        muted={false}
        value={`${syllablesPerMin(rate)} ${t("delivery.unit.sylPerMin")} · ${t(band.key)}`}
      />
    </MeterGroup>
  );
}

/** The compact card: live meters + filler tally, or replay's measured pace,
 *  topped off with the LLM tone/filler read. */
function DeliveryCard({
  mode,
  t,
  toggles,
  prosody,
  measuredRate,
  filledPauseCount,
  status,
  assessment,
  running,
}: Readonly<{
  mode: "live" | "replay";
  t: TFn;
  toggles: DeliveryToggles;
  prosody: Prosody;
  /** The measured rate, already gated on this being a replay that has one. */
  measuredRate: number | null;
  filledPauseCount: number;
  status: DeliveryStatus;
  assessment: DeliveryAssessment | null;
  running: boolean;
}>) {
  // The LLM tone/filler block shows in replay always; live only when opted in.
  const showLlm = mode === "replay" || toggles.tone;
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold tracking-tight">{t("delivery.card.title")}</span>
        {status === "running" && assessment && (
          <Loader2 className="size-3 animate-spin text-muted-foreground" />
        )}
      </div>

      <div className="flex flex-col gap-1.5 text-[11px]">
        {mode === "live" && (
          <LiveMeters t={t} prosody={prosody} paceOn={toggles.pace} pitchOn={toggles.pitch} />
        )}
        {/* Live filler-sound ("um/uh/嗯/呃") tally — counted from your own
            transcript against a global, cross-language filler map, in real time. */}
        {mode === "live" && toggles.pauses && <LiveFillerCount count={filledPauseCount} t={t} />}

        {/* Replay: the measured (not guessed) pace. */}
        {measuredRate ? <MeasuredPaceMeter t={t} rate={measuredRate} /> : null}

        {/* LLM read: tone (+ evidence) and over-frequent fillers. */}
        {showLlm && (
          <DeliveryReadout mode={mode} status={status} running={running} assessment={assessment} t={t} />
        )}
      </div>
    </div>
  );
}

/** Whether the card has anything to say. Replay speaks up once analysis has been
 *  attempted or a rate was measured; live only when a signal is opted in. */
function shouldShow(
  mode: "live" | "replay",
  toggles: DeliveryToggles,
  status: DeliveryStatus,
  assessment: DeliveryAssessment | null,
  hasMeasured: boolean,
): boolean {
  if (mode === "replay") return status !== "idle" || !!assessment || hasMeasured;
  return toggles.tone || toggles.pace || toggles.pitch || toggles.pauses;
}

/**
 * Persistent "Delivery" card — the always-visible counterpart to the transient
 * nudges, rendered at the top of the findings column in BOTH live and replay.
 *
 * LIVE: ambient meters driven by the mic-anchored prosody stream — pace
 * (syllables/min) and intonation (pitch spread) with at-a-glance bands — plus the
 * rolling LLM read (tone + over-frequent fillers). The meters used to be three
 * unlabeled bars crammed next to the mic level in the title bar, indistinguishable
 * from each other; they live here now with labels, numbers, and one consistent
 * primary/warning language.
 *
 * REPLAY: the pace number is an acoustically MEASURED articulation rate (from
 * Rust), not an LLM guess from STT-timed text — plus the post-call tone/filler
 * read. For live-recorded meetings it's accumulated from the user's OWN mic
 * (issue #22: never the counterpart); for uploads it's measured over the file.
 *
 * Gated so it stays out of the way when delivery coaching isn't in play.
 *
 * `variant="full"` (the study tense's 評分 page) adds a locally-computed
 * scorecard on top: stat tiles (measured pace, talk share, filler sounds, tone)
 * and a per-minute talk-volume strip — all derived from the saved segments at
 * zero LLM cost, so the page always has content.
 */
export function DeliveryPanel({
  mode,
  variant = "compact",
}: Readonly<{ mode: "live" | "replay"; variant?: "compact" | "full" }>) {
  const { t } = useI18n();
  const toneOn = useStore((s) => s.settings.delivery.tone);
  const paceOn = useStore((s) => s.settings.delivery.pace);
  const pitchOn = useStore((s) => s.settings.delivery.pitch);
  const pausesOn = useStore((s) => s.settings.delivery.pauses);
  const filledPauseCount = useStore((s) => s.filledPauseCount);
  const assessment = useStore((s) => s.deliveryAssessment);
  const status = useStore((s) => s.deliveryStatus);
  const prosody = useProsody();
  const measuredRate = useStore((s) => s.replay?.speechRateHz ?? null);
  const segments = useStore((s) => s.segments);

  const toggles: DeliveryToggles = { tone: toneOn, pace: paceOn, pitch: pitchOn, pauses: pausesOn };
  const full = variant === "full" && mode === "replay";
  // Local replay stats (full variant only) — computed straight from the saved
  // transcript, no model call. Ratio is null for diarized "mix" sessions.
  const localStats = useMemo(() => (full ? computeLocalStats(segments) : null), [full, segments]);

  const hasMeasured = mode === "replay" && !!measuredRate;
  if (!full && !shouldShow(mode, toggles, status, assessment, hasMeasured)) return null;

  const running = status === "running" && !assessment;

  if (full && localStats) {
    return (
      <DeliveryScorecard
        mode={mode}
        stats={localStats}
        measuredRate={measuredRate}
        assessment={assessment}
        status={status}
        running={running}
        t={t}
      />
    );
  }

  return (
    <DeliveryCard
      mode={mode}
      t={t}
      toggles={toggles}
      prosody={prosody}
      measuredRate={hasMeasured ? measuredRate : null}
      filledPauseCount={filledPauseCount}
      status={status}
      assessment={assessment}
      running={running}
    />
  );
}
