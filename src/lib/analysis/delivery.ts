//! Live delivery-coaching logic: turns the raw `audio://prosody` stream (and,
//! for talk-time, the transcript) into self-calibrating nudge triggers.
//!
//! All inputs are the user's own mic ("me") — see issue #22. Everything here is
//! pure and framework-free so it unit-tests without React; the `useDelivery`
//! hook drives a [`DeliveryCoach`] with live samples and localizes its triggers.

import type {
  DeliveryNudgeKind,
  DeliveryToggles,
  ProsodyMetrics,
  TranscriptSegment,
} from "../types";

/** Online mean/variance (Welford) — for thresholds relative to the speaker. */
export class RunningStats {
  private n = 0;
  private mean_ = 0;
  private m2 = 0;

  push(x: number): void {
    this.n += 1;
    const delta = x - this.mean_;
    this.mean_ += delta / this.n;
    this.m2 += delta * (x - this.mean_);
  }

  get count(): number {
    return this.n;
  }
  get mean(): number {
    return this.mean_;
  }
  /** Sample standard deviation (0 with <2 samples). */
  get std(): number {
    return this.n > 1 ? Math.sqrt(this.m2 / (this.n - 1)) : 0;
  }
}

/** A coach decision: which nudge to surface, and how strongly. */
export interface DeliveryTrigger {
  kind: DeliveryNudgeKind;
  severity: "info" | "warn";
}

/** Tunables for the nudge logic. Defaults are deliberately conservative so the
 *  surface stays quiet — it should feel like an occasional tap, not a nag. */
export interface DeliveryThresholds {
  /** Seconds of speech to observe before pace/monotony nudges may fire. */
  calibrationSec: number;
  /** How many std-devs above the speaker's own baseline counts as "rushing". */
  paceZ: number;
  /** Absolute syllables/sec ceiling — a floor under the relative test so a slow
   *  baseline can't make any speed acceptable. On the live speaking-rate signal
   *  ~4.0/s ≈ 240 字/分 reads as fast; kept in step with the DeliveryPanel gauge's
   *  FAST_HZ so the nudge and the meter agree. */
  paceAbsHz: number;
  /** F0 spread (semitones) below which sustained speech reads as monotone. */
  monotoneSemitones: number;
  /** Voiced ratio required before judging monotony (need real speech, not ums). */
  monotoneMinVoiced: number;
  /** Trailing silence (ms) that counts as unintended dead air. */
  deadAirMs: number;
  /** Continuous speaking (ms) with no real pause that counts as steamrolling. */
  steamrollMs: number;
  /** Trailing silence (ms) that counts as a genuine pause and ends a talking run. */
  pauseResetMs: number;
  /** Per-kind cooldown (ms) so a nudge fires at most this often. */
  cooldownMs: number;
  /** A condition must hold this long (ms) before firing — kills one-off blips. */
  sustainMs: number;
}

export const DEFAULT_THRESHOLDS: DeliveryThresholds = {
  calibrationSec: 30,
  paceZ: 1.5,
  paceAbsHz: 4.0,
  monotoneSemitones: 1.2,
  monotoneMinVoiced: 0.55,
  deadAirMs: 6000,
  steamrollMs: 40000,
  pauseResetMs: 1500,
  cooldownMs: 18000,
  sustainMs: 2500,
};

/**
 * Stateful, mic-driven coach. Feed every prosody sample via [`observe`]; it
 * returns at most one localized-by-caller trigger, honoring per-kind cooldowns,
 * a sustained-condition requirement, and a self-calibration warm-up. Pure: no
 * timers, no globals — `nowMs` is supplied so tests stay deterministic.
 */
export class DeliveryCoach {
  private paceBaseline = new RunningStats();
  private startMs: number | null = null;
  /** True once the user has produced any speech this session. */
  private hasSpoken = false;
  /** When the current talking run began (null while genuinely paused). */
  private speakingSince: number | null = null;
  private lastFiredAt: Partial<Record<DeliveryNudgeKind, number>> = {};
  private sustainedSince: Partial<Record<DeliveryNudgeKind, number>> = {};

  constructor(
    private toggles: DeliveryToggles,
    private th: DeliveryThresholds = DEFAULT_THRESHOLDS
  ) {}

  observe(m: ProsodyMetrics, nowMs: number): DeliveryTrigger | null {
    if (this.startMs === null) this.startMs = nowMs;
    const elapsedSec = (nowMs - this.startMs) / 1000;

    // Feed the pace baseline only while genuinely speaking, so silence/noise
    // don't skew the speaker's reference. It keeps updating all session.
    if (m.speaking && m.speechRateHz > 0) {
      this.paceBaseline.push(m.speechRateHz);
      this.hasSpoken = true;
    }
    const calibrated = elapsedSec >= this.th.calibrationSec;

    // Track the current talking RUN for steamroll detection. `m.speaking` is a
    // single-frame voicing flag that flickers off on every stop / fricative /
    // breath, so drive the run from a windowed talk signal and only reset it on
    // a genuine inter-utterance pause — otherwise a 40s monologue (riddled with
    // sub-pause gaps) could never accumulate and steamroll would never fire.
    const talking = m.speaking || (m.voicedRatio >= 0.2 && m.silenceMs < this.th.deadAirMs);
    if (m.silenceMs >= this.th.pauseResetMs) {
      this.speakingSince = null;
    } else if (talking && this.speakingSince === null) {
      this.speakingSince = nowMs;
    }

    // Evaluate every candidate; the first that is allowed to fire wins. Order is
    // priority: dead air and steamrolling are the most actionable mid-call.
    // Dead air means NOBODY is talking: the mic is silent AND the counterpart's
    // stream is quiet — with speaker-bleed rejection the mic no longer "hears"
    // the far side, so their monologue must not read as dead air.
    const deadAir =
      this.toggles.pauses &&
      this.hasSpoken &&
      !m.speaking &&
      !m.farendActive &&
      m.silenceMs >= this.th.deadAirMs;
    if (this.gate("deadair", deadAir, nowMs)) return { kind: "deadair", severity: "info" };

    const steamroll =
      this.toggles.pauses &&
      this.speakingSince !== null &&
      nowMs - this.speakingSince >= this.th.steamrollMs;
    if (this.gate("steamroll", steamroll, nowMs)) return { kind: "steamroll", severity: "warn" };

    // Filled pause ("um/uh/呃/痾"): a one-shot edge from the mic DSP, already
    // de-duped per occurrence in Rust — so gate on cooldown ONLY (no sustain;
    // `gate` would never fire on a single-sample edge). A burst of ums yields one
    // gentle nudge; the running count surfaces every one. Grouped under `pauses`.
    if (this.toggles.pauses && m.filledPause) {
      const last = this.lastFiredAt.filledpause ?? -Infinity;
      if (nowMs - last >= this.th.cooldownMs) {
        this.lastFiredAt.filledpause = nowMs;
        return { kind: "filledpause", severity: "info" };
      }
    }

    const paceCeiling = Math.max(
      this.th.paceAbsHz,
      this.paceBaseline.mean + this.th.paceZ * this.paceBaseline.std
    );
    const rushing =
      this.toggles.pace && calibrated && m.speaking && m.speechRateHz > paceCeiling;
    if (this.gate("pace", rushing, nowMs)) return { kind: "pace", severity: "warn" };

    const monotone =
      this.toggles.pitch &&
      calibrated &&
      m.voicedRatio >= this.th.monotoneMinVoiced &&
      m.pitchVarSemitones > 0 &&
      m.pitchVarSemitones < this.th.monotoneSemitones;
    if (this.gate("monotone", monotone, nowMs)) return { kind: "monotone", severity: "info" };

    return null;
  }

  /**
   * Returns true exactly when `active` has held continuously for `sustainMs`
   * AND the kind is past its cooldown — and records the firing. Clears the
   * sustain timer when the condition lapses.
   */
  private gate(kind: DeliveryNudgeKind, active: boolean, nowMs: number): boolean {
    if (!active) {
      delete this.sustainedSince[kind];
      return false;
    }
    const since = this.sustainedSince[kind] ?? nowMs;
    this.sustainedSince[kind] = since;
    if (nowMs - since < this.th.sustainMs) return false;

    const last = this.lastFiredAt[kind] ?? -Infinity;
    if (nowMs - last < this.th.cooldownMs) return false;

    this.lastFiredAt[kind] = nowMs;
    // Reset the sustain window so the next fire requires a fresh sustained spell.
    delete this.sustainedSince[kind];
    return true;
  }
}

/** Convert syllables/sec to a friendlier syllables/min for display. */
export function syllablesPerMin(hz: number): number {
  return Math.round(hz * 60);
}

/**
 * Talk-time split of the user vs everyone else, by voiced duration of finalized
 * segments. Only meaningful when speakers are split by capture source (non-
 * diarized: "me" vs "them"); in diarized "mix" sessions there is no per-source
 * "me", so this returns null and callers fall back to the mic voiced-ratio.
 */
export function talkTimeRatio(
  segments: TranscriptSegment[]
): { me: number; them: number } | null {
  let me = 0;
  let them = 0;
  let sawSplit = false;
  for (const s of segments) {
    if (!s.isFinal) continue;
    const dur = Math.max(0, s.endMs - s.startMs);
    if (s.source === "me") {
      me += dur;
      sawSplit = true;
    } else if (s.source === "them") {
      them += dur;
      sawSplit = true;
    }
  }
  const total = me + them;
  if (!sawSplit || total <= 0) return null;
  return { me: me / total, them: them / total };
}
