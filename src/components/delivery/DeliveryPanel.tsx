import { useMemo, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useStore } from "../../lib/store";
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

/** Map a live speaking rate (syllables/sec ≈ value × 60 字/分) to a band label +
 *  whether it warrants a watch (amber) accent. Reference points for Mandarin:
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
 *  float unlabeled in the title bar — green reads "fine", amber reads "worth a
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
  let bar = "bg-emerald-500";
  if (muted) {
    bar = "bg-muted-foreground/30";
  } else if (watch) {
    bar = "bg-amber-400";
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
          watch ? "font-medium text-amber-400" : "text-foreground/80"
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
  const className = count >= 5 ? "font-medium text-amber-400" : "tabular-nums text-foreground/80";
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
          <span className={frequentFillers ? "font-medium text-amber-400" : "text-muted-foreground"}>
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

/** One stat tile of the full-variant replay scorecard. */
function StatTile({
  label,
  value,
  sub,
  watch,
}: Readonly<{ label: string; value: string; sub?: string; watch?: boolean }>) {
  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={`mt-0.5 truncate text-base font-semibold tabular-nums ${watch ? "text-amber-400" : ""}`}>
        {value}
      </div>
      {sub && (
        <div className={`truncate text-[10px] ${watch ? "text-amber-400" : "text-muted-foreground"}`}>
          {sub}
        </div>
      )}
    </div>
  );
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

function TalkVolumeStrip({ buckets, title }: Readonly<{ buckets: TalkBucket[]; title: string }>) {
  const max = Math.max(...buckets.map((b) => b.voicedMs), 1);
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="flex h-10 items-end gap-px">
        {buckets.map((b) => (
          <span
            key={b.startMs}
            className={`min-w-0 flex-1 rounded-t-sm ${b.voicedMs === max ? "bg-primary" : "bg-primary/50"}`}
            style={{ height: `${Math.max(4, Math.round((b.voicedMs / max) * 100))}%` }}
          />
        ))}
      </div>
    </div>
  );
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

/** The pace tile's sub-label: the measured band when there is one, otherwise
 *  the LLM's coarse read, otherwise nothing. */
function paceTileSub(
  t: TFn,
  measuredRate: number | null,
  band: ReturnType<typeof paceBand> | null,
  assessment: DeliveryAssessment | null,
): string | undefined {
  if (measuredRate && band) return `${t("delivery.unit.sylPerMin")} · ${t(band.key)}`;
  if (assessment) return t(`delivery.pace.${assessment.pace}` as TranslationKey);
  return undefined;
}

/** The tone tile's value: the verdict once assessed, an ellipsis while the pass
 *  is still running, a dash when there is nothing to say. */
function toneTileValue(t: TFn, assessment: DeliveryAssessment | null, running: boolean): string {
  if (assessment) return t(TONE_KEY[assessment.tone]);
  return running ? "…" : "—";
}

/** Sharp and above warrants an amber tile. */
function toneNeedsWatch(assessment: DeliveryAssessment | null): boolean {
  if (!assessment) return false;
  return assessment.tone === "sharp" || assessment.tone === "aggressive" || assessment.tone === "rude";
}

/** The study tense's locally-computed scorecard (`variant="full"`). */
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
  const measuredBand = measuredRate ? paceBand(measuredRate) : null;
  const ratioBand = stats.ratio ? talkBand(stats.ratio.me) : null;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile
          label={t("delivery.card.pace")}
          value={measuredRate ? `${syllablesPerMin(measuredRate)}` : "—"}
          sub={paceTileSub(t, measuredRate, measuredBand, assessment)}
          watch={!!measuredBand?.watch}
        />
        {stats.ratio && ratioBand && (
          <StatTile
            label={t("delivery.card.talkRatio")}
            value={`${Math.round(stats.ratio.me * 100)}%`}
            sub={t(ratioBand.key)}
            watch={ratioBand.watch}
          />
        )}
        <StatTile
          label={t("delivery.tile.fillers")}
          value={`${stats.fillers}`}
          sub={t("delivery.unit.times")}
          watch={stats.fillers >= 10}
        />
        <StatTile
          label={t("delivery.card.tone")}
          value={toneTileValue(t, assessment, running)}
          sub={assessment?.toneEvidence ? `“${assessment.toneEvidence}”` : undefined}
          watch={toneNeedsWatch(assessment)}
        />
      </div>

      {stats.buckets.length > 0 && (
        <TalkVolumeStrip buckets={stats.buckets} title={t("delivery.card.paceTimeline")} />
      )}

      <div className="rounded-lg border bg-muted/20 p-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-semibold tracking-tight">{t("delivery.card.llmRead")}</span>
          {status === "running" && assessment && (
            <Loader2 className="size-3 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className="flex flex-col gap-1.5 text-[11px]">
          <DeliveryReadout mode={mode} status={status} running={running} assessment={assessment} t={t} />
        </div>
      </div>
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
 * green/amber language.
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
