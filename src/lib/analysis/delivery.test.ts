import { describe, it, expect } from "vitest";
import {
  DeliveryCoach,
  DEFAULT_THRESHOLDS,
  RunningStats,
  talkTimeRatio,
  syllablesPerMin,
} from "./delivery";
import type { DeliveryToggles, ProsodyMetrics, TranscriptSegment } from "../types";

const ALL_ON: DeliveryToggles = { pace: true, pitch: true, pauses: true, tone: true };

/** A neutral prosody sample; override fields per-test. */
function sample(over: Partial<ProsodyMetrics> = {}): ProsodyMetrics {
  return {
    f0Hz: 150,
    pitchVarSemitones: 3,
    monotonyScore: 0,
    speechRateHz: 3,
    voicedRatio: 0.7,
    silenceMs: 0,
    longestPauseMs: 400,
    speaking: true,
    filledPause: false,
    ...over,
  };
}

/** Feed the coach a steady stream of identical samples up to `untilMs`. */
function warmUp(coach: DeliveryCoach, base: Partial<ProsodyMetrics>, untilMs: number, stepMs = 500) {
  for (let t = 0; t <= untilMs; t += stepMs) coach.observe(sample(base), t);
}

describe("RunningStats", () => {
  it("tracks mean and sample std", () => {
    const s = new RunningStats();
    [2, 4, 4, 4, 5, 5, 7, 9].forEach((x) => s.push(x));
    expect(s.mean).toBeCloseTo(5, 5);
    expect(s.std).toBeCloseTo(2.138, 2);
  });
});

describe("DeliveryCoach", () => {
  const seg = DEFAULT_THRESHOLDS.calibrationSec * 1000;

  it("stays quiet during the calibration warm-up even when rushing", () => {
    const coach = new DeliveryCoach(ALL_ON);
    let fired = false;
    for (let t = 0; t < seg - 1000; t += 500) {
      if (coach.observe(sample({ speechRateHz: 9 }), t)) fired = true;
    }
    expect(fired).toBe(false);
  });

  it("fires a sustained pace nudge once calibrated, then respects cooldown", () => {
    const coach = new DeliveryCoach(ALL_ON);
    // Calibrate with a calm ~3/s baseline.
    warmUp(coach, { speechRateHz: 3 }, seg);

    // Now rush well above baseline + the absolute ceiling, sustained.
    const triggers: string[] = [];
    for (let t = seg + 500; t <= seg + 12000; t += 500) {
      const r = coach.observe(sample({ speechRateHz: 9 }), t);
      if (r) triggers.push(r.kind);
    }
    expect(triggers).toContain("pace");
    // Cooldown (18s) means it should not fire repeatedly in a 12s span.
    expect(triggers.filter((k) => k === "pace").length).toBe(1);
  });

  it("does not fire pace for a single brief blip (sustain requirement)", () => {
    const coach = new DeliveryCoach(ALL_ON);
    warmUp(coach, { speechRateHz: 3 }, seg);
    // One fast sample, then back to normal — under sustainMs.
    const a = coach.observe(sample({ speechRateHz: 9 }), seg + 500);
    const b = coach.observe(sample({ speechRateHz: 3 }), seg + 1000);
    expect(a).toBeNull();
    expect(b).toBeNull();
  });

  it("flags dead air after the user has spoken then goes quiet", () => {
    const coach = new DeliveryCoach(ALL_ON);
    // Speak briefly so `hasSpoken` is set (else opening silence must NOT nudge).
    for (let t = 0; t <= 3000; t += 500) {
      coach.observe(sample({ speaking: true, speechRateHz: 3 }), t);
    }
    // Then go silent; dead air should surface after the threshold + sustain.
    let kind: string | null = null;
    for (let t = 3500; t <= 16000; t += 500) {
      const r = coach.observe(
        sample({ speaking: false, silenceMs: t - 3000, voicedRatio: 0 }),
        t
      );
      if (r) kind = r.kind;
    }
    expect(kind).toBe("deadair");
  });

  it("nudges once on a filled pause, then respects cooldown", () => {
    const coach = new DeliveryCoach(ALL_ON);
    // A filled-pause edge fires immediately (no calibration needed).
    expect(coach.observe(sample({ filledPause: true }), 1000)?.kind).toBe("filledpause");
    // Another within the cooldown window is suppressed.
    expect(coach.observe(sample({ filledPause: true }), 5000)).toBeNull();
    // After the cooldown it can fire again.
    expect(
      coach.observe(sample({ filledPause: true }), 1000 + DEFAULT_THRESHOLDS.cooldownMs + 1)?.kind
    ).toBe("filledpause");
  });

  it("does NOT flag dead air on opening silence before any speech", () => {
    const coach = new DeliveryCoach(ALL_ON);
    let fired = false;
    for (let t = 0; t <= 16000; t += 500) {
      if (coach.observe(sample({ speaking: false, silenceMs: t, voicedRatio: 0 }), t)) fired = true;
    }
    expect(fired).toBe(false);
  });

  it("flags steamrolling after a long unbroken talking run", () => {
    const coach = new DeliveryCoach(ALL_ON);
    let kind: string | null = null;
    // ~45s of continuous talking (voiced, no real pause) — single-frame voicing
    // would flicker, but the windowed talk signal must still accumulate the run.
    for (let t = 0; t <= 45000; t += 500) {
      const r = coach.observe(
        sample({ speaking: true, voicedRatio: 0.7, silenceMs: 0, speechRateHz: 3 }),
        t
      );
      if (r?.kind === "steamroll") kind = r.kind;
    }
    expect(kind).toBe("steamroll");
  });

  it("does NOT steamroll when real pauses break the run", () => {
    const coach = new DeliveryCoach(ALL_ON);
    let steam = false;
    for (let t = 0; t <= 60000; t += 500) {
      const inPause = t % 10000 < 2000; // a >1.5s pause every ~10s
      const r = coach.observe(
        sample(
          inPause
            ? { speaking: false, voicedRatio: 0, silenceMs: 2000 }
            : { speaking: true, voicedRatio: 0.7, silenceMs: 0, speechRateHz: 3 }
        ),
        t
      );
      if (r?.kind === "steamroll") steam = true;
    }
    expect(steam).toBe(false);
  });

  it("flags monotone delivery only when pitch toggle is on", () => {
    const flat = { pitchVarSemitones: 0.5, voicedRatio: 0.8, speechRateHz: 3 };
    const on = new DeliveryCoach(ALL_ON);
    warmUp(on, flat, seg);
    let firedOn = false;
    for (let t = seg + 500; t <= seg + 8000; t += 500) {
      if (on.observe(sample(flat), t)?.kind === "monotone") firedOn = true;
    }
    expect(firedOn).toBe(true);

    const off = new DeliveryCoach({ ...ALL_ON, pitch: false });
    warmUp(off, flat, seg);
    let firedOff = false;
    for (let t = seg + 500; t <= seg + 8000; t += 500) {
      if (off.observe(sample(flat), t)?.kind === "monotone") firedOff = true;
    }
    expect(firedOff).toBe(false);
  });
});

describe("talkTimeRatio", () => {
  const fseg = (source: TranscriptSegment["source"], startMs: number, endMs: number): TranscriptSegment => ({
    id: `${source}-${startMs}`,
    source,
    speaker: 0,
    text: "x",
    isFinal: true,
    startMs,
    endMs,
  });

  it("splits me vs them by voiced duration", () => {
    const r = talkTimeRatio([fseg("me", 0, 3000), fseg("them", 3000, 4000)]);
    expect(r).not.toBeNull();
    expect(r!.me).toBeCloseTo(0.75, 5);
    expect(r!.them).toBeCloseTo(0.25, 5);
  });

  it("returns null for diarized mix sessions (no per-source me)", () => {
    expect(talkTimeRatio([fseg("mix", 0, 1000), fseg("mix", 1000, 2000)])).toBeNull();
  });
});

describe("syllablesPerMin", () => {
  it("converts hz to rounded per-minute", () => {
    expect(syllablesPerMin(3)).toBe(180);
  });
});
