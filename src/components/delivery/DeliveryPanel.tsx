import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Clock, Loader2, Sparkles } from "lucide-react";
import { isTrimmed, useStore } from "../../lib/store";
import { useStudyArtifactDisplay } from "../../lib/analysis/studyPipeline";
import { Skeleton } from "@/components/ui/skeleton";
import { useProsody } from "../../lib/analysis/useDelivery";
import { syllablesPerMin } from "../../lib/analysis/delivery";
import { computeSpeechStats, talkShare } from "../../lib/analysis/speechStats";
import { isSpeaker, resolveSelf, speakerRoster, type SelfSpeaker } from "../../lib/speakers/self";
import { displaySpeakerLabel, speakerLabel } from "../../lib/speakers/labels";
import { useRelabel } from "../../lib/speakers/useRelabel";
import { Button } from "@/components/ui/button";
import { DeliveryReport } from "./DeliveryReport";
import { SpeakerSwitch } from "./SpeakerSwitch";
import { canReadSpeakerTone, readSpeakerTone, speakerToneKey, useSpeakerTone } from "../../lib/analysis/speakerTone";
import { paceBand } from "./bands";
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
  const relabel = useRelabel();
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
          <p className="-mt-1 truncate text-[10px] italic text-muted-foreground">“{relabel(assessment.toneEvidence)}”</p>
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

        {assessment.summary && <p className="mt-0.5 text-[11px] leading-snug text-foreground/80">{relabel(assessment.summary)}</p>}
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
  const relabel = useRelabel();
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
          detail={assessment.toneEvidence && <span className="italic">“{relabel(assessment.toneEvidence)}”</span>}
        />
        {assessment.summary && (
          <p className="col-span-3 pt-2 text-xs leading-relaxed text-foreground/85">{relabel(assessment.summary)}</p>
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
    <div className="grid grid-cols-[max-content_max-content_minmax(0,1fr)] items-center gap-x-4">{body}</div>
  );
}

/** 03 語氣 for a speaker who isn't the user: read only when asked (each read
 *  is a paid call), then kept for as long as the app is open. */
function OtherToneGroup({
  t,
  speaker,
  label,
  displayLabel,
}: Readonly<{
  t: TFn;
  speaker: string;
  /** The speaker as the model sees the transcript label it ("Speaker 2"). */
  label: string;
  /** The speaker as the screen shows it. */
  displayLabel: string;
}>) {
  const recordingId = useStore((s) => s.loadedHistoryId);
  const read = useSpeakerTone((s) => s.reads[speakerToneKey(recordingId, speaker)]);
  const canRead = canReadSpeakerTone();
  // Read as soon as the speaker is shown, once per recording + speaker; a
  // failed read waits for 再試一次 rather than retrying on every render.
  useEffect(() => {
    if (!read && canRead) void readSpeakerTone(speaker, label);
  }, [read, canRead, speaker, label]);
  if (read?.status === "done" && read.assessment) {
    return <ToneGroup t={t} mode="replay" status="done" running={false} assessment={read.assessment} pending={false} />;
  }
  if (read?.status === "error") {
    return (
      <div className="flex flex-col items-start gap-2 py-2 text-xs text-muted-foreground">
        <p>{read.error}</p>
        <Button size="sm" variant="outline" onClick={() => void readSpeakerTone(speaker, label)}>
          <Sparkles className="size-3.5" />
          {t("delivery.speaker.tone.retry")}
        </Button>
      </div>
    );
  }
  if (read?.status === "done" || !canRead) {
    return (
      <p className="py-2 text-xs text-muted-foreground">
        {t(canRead ? "delivery.speaker.tone.empty" : "delivery.speaker.tone.noKey", { name: displayLabel })}
      </p>
    );
  }
  // Running, or about to start on this render's effect.
  return <ToneGroup t={t} mode="replay" status="running" running assessment={null} pending />;
}

/** The study tense's 評分 report (`variant="full"`): a switch over the
 *  recording's speakers, then the transcript-derived charts (DeliveryReport)
 *  for the one picked, with the AI's tone read as its last group. It opens on
 *  the user when Parley knows who that is, else on whoever talked most. */
function DeliveryScorecard({
  mode,
  segments,
  self,
  measuredRate,
  assessment,
  status,
  running,
  t,
}: Readonly<{
  mode: "live" | "replay";
  segments: TranscriptSegment[];
  self: SelfSpeaker | null;
  measuredRate: number | null;
  assessment: DeliveryAssessment | null;
  status: DeliveryStatus;
  running: boolean;
  t: TFn;
}>) {
  const names = useStore((s) => s.speakerNames);
  const marked = useStore((s) => s.selfSpeaker);
  const roster = useMemo(() => speakerRoster(segments, self), [segments, self]);
  const [picked, setPicked] = useState<string | null>(null);
  // A pick on a speaker that is gone (re-diarized) falls back to the default.
  const viewed = roster.find((r) => r.key === picked) ?? roster[0];
  const match = useMemo(() => isSpeaker(viewed?.key ?? ""), [viewed?.key]);
  const stats = useMemo(() => computeSpeechStats(segments, match), [segments, match]);
  const ratio = useMemo(() => talkShare(segments, match), [segments, match]);
  // Queued (waiting on the findings pass) or running, with nothing to show yet.
  const display = useStudyArtifactDisplay("delivery");
  if (!viewed) return null;
  // The model reads the transcript with English labels; the screen localizes.
  const label = speakerLabel(viewed, names);
  const displayLabel = displaySpeakerLabel(viewed, names, t);
  // The pipeline's tone read is the user's; anyone else is read when shown.
  const ownRead = viewed.isSelf && !!self;
  const pending = !assessment && (running || display === "queued");
  return (
    <div className="@container">
      <SpeakerSwitch
        roster={roster}
        viewed={viewed}
        onView={setPicked}
        names={names}
        origin={self?.origin ?? null}
        marked={marked}
      />
      <DeliveryReport
        // The speaker switch above already says whose numbers these are.
        title={null}
        stats={stats}
        ratio={ratio}
        // The mic's measured pace is the user's only while the mic was theirs
        // alone; a hand-marked speaker is usually a room the mic heard whole.
        measuredRate={ownRead && self.origin !== "marked" ? measuredRate : null}
        assessment={ownRead ? assessment : null}
        tone={
          ownRead ? (
            <ToneGroup t={t} mode={mode} status={status} running={running} assessment={assessment} pending={pending} />
          ) : (
            <OtherToneGroup key={viewed.key} t={t} speaker={viewed.key} label={label} displayLabel={displayLabel} />
          )
        }
      />
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
  const recordingId = useStore((s) => s.loadedHistoryId);
  const selfSpeaker = useStore((s) => s.selfSpeaker);
  const micActivity = useStore((s) => s.replay?.micActivity);
  const voiceSelf = useStore((s) => s.voiceSelfKey);
  const self = resolveSelf(segments, selfSpeaker, micActivity, voiceSelf);

  const toggles: DeliveryToggles = { tone: toneOn, pace: paceOn, pitch: pitchOn, pauses: pausesOn };
  const full = variant === "full" && mode === "replay";
  const replayTrim = useStore((s) => s.replayTrim);
  // Trimmed-away speech is left out, matching what the delivery pass reads.
  const kept = useMemo(
    () => (full ? segments.filter((s) => !isTrimmed(s, replayTrim)) : segments),
    [full, segments, replayTrim],
  );

  const hasMeasured = mode === "replay" && !!measuredRate;
  if (!full && !shouldShow(mode, toggles, status, assessment, hasMeasured)) return null;

  const running = status === "running" && !assessment;

  if (full) {
    return (
      <DeliveryScorecard
        // A new recording opens on its own default speaker.
        key={recordingId ?? "unsaved"}
        mode={mode}
        segments={kept}
        self={self}
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
