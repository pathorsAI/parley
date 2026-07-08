import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useStore } from "../../lib/store";
import { useProsody } from "../../lib/analysis/useDelivery";
import { syllablesPerMin } from "../../lib/analysis/delivery";
import { useI18n } from "../../i18n";
import type { TranslationKey } from "../../i18n";
import type { DeliveryAssessment, ToneVerdict } from "../../lib/types";

type TFn = ReturnType<typeof useI18n>["t"];
type DeliveryStatus = ReturnType<typeof useStore.getState>["deliveryStatus"];

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
const FAST_HZ = 4.0;
function paceBand(hz: number): { key: TranslationKey; watch: boolean } {
  if (hz > FAST_HZ) return { key: "delivery.pace.fast", watch: true };
  if (hz >= 2.0) return { key: "delivery.pace.comfortable", watch: false };
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
 */
export function DeliveryPanel({ mode }: Readonly<{ mode: "live" | "replay" }>) {
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

  const hasMeasured = mode === "replay" && !!measuredRate;
  const showLive = toneOn || paceOn || pitchOn || pausesOn;
  const show = mode === "replay" ? status !== "idle" || !!assessment || hasMeasured : showLive;
  if (!show) return null;

  const running = status === "running" && !assessment;
  // Live meter inputs (null prosody → muted "—" until the first sample).
  const paceHz = prosody?.speechRateHz ?? 0;
  const liveBand = paceBand(paceHz);
  const sd = prosody?.pitchVarSemitones ?? 0;
  const mBand = measuredRate ? paceBand(measuredRate) : null;
  const hasProsody = !!prosody;

  // The LLM tone/filler block shows in replay always; live only when opted in.
  const showLlm = mode === "replay" || toneOn;

  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold tracking-tight">{t("delivery.card.title")}</span>
        {status === "running" && assessment && (
          <Loader2 className="size-3 animate-spin text-muted-foreground" />
        )}
      </div>

      <div className="flex flex-col gap-1.5 text-[11px]">
        {/* Live ambient meters (mic-anchored). */}
        {mode === "live" && (paceOn || pitchOn) && (
          <MeterGroup>
            {paceOn && (
              <MeterRow
                label={t("delivery.card.pace")}
                pct={Math.min(100, Math.round((paceHz / 6) * 100))}
                watch={liveBand.watch}
                muted={!prosody || paceHz <= 1}
                value={livePaceValue(t, hasProsody, paceHz, liveBand)}
              />
            )}
            {pitchOn && (
              <MeterRow
                label={t("delivery.card.intonation")}
                pct={Math.min(100, Math.round((sd / 3) * 100))}
                watch={sd > 0 && sd < 1.2}
                muted={!prosody || sd <= 0}
                value={intonationValue(t, hasProsody, sd)}
              />
            )}
          </MeterGroup>
        )}
        {/* Live filler-sound ("um/uh/嗯/呃") tally — counted from your own
            transcript against a global, cross-language filler map, in real time. */}
        {mode === "live" && pausesOn && <LiveFillerCount count={filledPauseCount} t={t} />}

        {/* Replay: the measured (not guessed) pace. */}
        {hasMeasured && mBand && (
          <MeterGroup>
            <MeterRow
              label={t("delivery.card.pace")}
              pct={Math.min(100, Math.round((measuredRate! / 6) * 100))}
              watch={mBand.watch}
              muted={false}
              value={`${syllablesPerMin(measuredRate!)} ${t("delivery.unit.sylPerMin")} · ${t(mBand.key)}`}
            />
          </MeterGroup>
        )}

        {/* LLM read: tone (+ evidence) and over-frequent fillers. */}
        {showLlm && (
          <DeliveryReadout mode={mode} status={status} running={running} assessment={assessment} t={t} />
        )}
      </div>
    </div>
  );
}
