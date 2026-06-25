//! Real-time prosody analysis of the user's own ("me") microphone stream.
//!
//! This is the live-coaching counterpart to [`LevelMeter`](crate::transcription::common::LevelMeter):
//! where the level meter shows raw loudness, [`ProsodyAnalyzer`] derives *delivery*
//! signals — pitch variation (monotony) and pausing — from the same 16 kHz mono
//! PCM, and emits an `audio://prosody` event ~2×/s for the frontend gauges/nudges.
//!
//! HARD CONSTRAINT (issue #22): this runs on the **mic ("me") stream only**, never
//! the counterpart. The caller taps the pre-mix mic receiver *before* the mixer
//! (see `spawn_mic_prosody_tap` in `commands.rs`), so with diarization on we still
//! analyze raw mic, not the mixed/diarized stream.
//!
//! F0 is estimated with a self-contained YIN detector (no extra crates, in keeping
//! with the project's no-native-deps posture). Monotony is the spread of F0 *in
//! semitones* over a rolling window: a log scale whose variance is independent of
//! the reference pitch, so it calibrates to the speaker rather than to absolute Hz.

use std::collections::VecDeque;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::audio::TARGET_SAMPLE_RATE;
use crate::transcription::common::PROSODY_EVENT;

/// Analysis frame: ~64 ms at 16 kHz. Large enough that the YIN difference function
/// reaches the ~228-sample lag of a low (70 Hz) male voice (needs frame ≥ 2·lag).
const FRAME: usize = 1024;
/// Hop between successive frames: ~32 ms → ~31 frames/s.
const HOP: usize = 512;
/// Rolling window over which monotony / pause stats are computed.
const WINDOW_MS: u64 = 7_000;
/// Emit cadence (~2 Hz), matching the level meter's "glanceable" rate.
const EMIT_EVERY_MS: u64 = 500;
/// Minimum voiced (pitched) frames in the window before monotony is meaningful.
const MIN_VOICED_FRAMES: usize = 12;

/// Below this RMS (on a 0..1 scale) a frame is treated as silence/unvoiced and
/// excluded from F0 stats. Speech RMS is typically > 0.02; quiet rooms < 0.005.
const VOICING_RMS_FLOOR: f32 = 0.012;
/// YIN aperiodicity threshold — a frame only yields an F0 when the normalized
/// difference dips below this (i.e. it is clearly periodic / voiced).
const YIN_THRESHOLD: f32 = 0.15;
/// Plausible human-voice F0 band; estimates outside are rejected as octave errors
/// or noise.
const F0_MIN_HZ: f32 = 70.0;
const F0_MAX_HZ: f32 = 400.0;
/// Reference pitch for the Hz↔semitone conversion. Arbitrary: variance (the only
/// thing monotony uses) is invariant to it.
const SEMITONE_REF_HZ: f32 = 100.0;

/// Payload emitted to the frontend ~2×/s. Snake-case on the wire; the frontend
/// maps it to camelCase (see `tauriEvents.ts`), mirroring `transcript://segment`.
#[derive(Clone, Serialize)]
struct ProsodyEvent {
    source: String,
    /// Latest voiced-frame pitch in Hz (0.0 when currently unvoiced).
    f0_hz: f32,
    /// Std-dev of F0 (in semitones) over the window — the raw monotony signal.
    /// The frontend compares it against a fixed semitone threshold for the
    /// "you've gone flat" nudge (reference-independent, so it reads consistently
    /// across speakers without per-session calibration).
    pitch_var_semitones: f32,
    /// Convenience 0..1 (1 = very monotone) from a fixed mapping; 0 until there
    /// are enough voiced frames to judge.
    monotony_score: f32,
    /// Speech rate as syllable nuclei per second over the window — a mic-anchored
    /// pace estimate that (unlike transcript WPM) works in diarized mode too, and
    /// is "me"-only by construction. The frontend baselines it per session.
    speech_rate_hz: f32,
    /// Fraction of frames in the window that were voiced (0..1).
    voiced_ratio: f32,
    /// Current trailing silence in ms (0 while speaking).
    silence_ms: u64,
    /// Longest pause within the window in ms.
    longest_pause_ms: u64,
    /// Whether the most recent frame was voiced.
    speaking: bool,
}

/// One analyzed frame's contribution to the rolling stats.
struct FrameStat {
    /// Frame-end timestamp, ms since capture start.
    t_ms: u64,
    /// Voiced = produced a confident in-band F0.
    voiced: bool,
    /// F0 in semitones (present iff voiced).
    semitones: Option<f32>,
    /// Frame RMS (0..1) — feeds the syllable-nuclei envelope for speech rate.
    rms: f32,
}

/// Streaming prosody analyzer. Fed every mic PCM chunk via [`push`](Self::push);
/// emits `audio://prosody` on its own cadence. One per meeting (mic stream).
pub struct ProsodyAnalyzer {
    app: AppHandle,
    source: &'static str,
    /// Pending normalized (−1..1) samples not yet consumed by a frame.
    buf: Vec<f32>,
    /// Absolute count of samples already consumed (frame timestamps derive from it).
    consumed: u64,
    frames: VecDeque<FrameStat>,
    last_emit_ms: u64,
    /// Timestamp of the most recent voiced frame, or `None` until the user has
    /// voiced anything — so pre-speech startup reports 0 trailing silence rather
    /// than the full elapsed time (which would spuriously trip a dead-air nudge).
    last_voiced_ms: Option<u64>,
}

impl ProsodyAnalyzer {
    pub fn new(app: AppHandle, source: &'static str) -> Self {
        Self {
            app,
            source,
            buf: Vec::with_capacity(FRAME * 2),
            consumed: 0,
            frames: VecDeque::new(),
            last_emit_ms: 0,
            last_voiced_ms: None,
        }
    }

    /// Feed one PCM chunk (16 kHz mono i16). Slices it into overlapping frames,
    /// updates rolling stats, and emits at ~2 Hz.
    pub fn push(&mut self, chunk: &[i16]) {
        self.buf.extend(chunk.iter().map(|&s| s as f32 / 32768.0));

        while self.buf.len() >= FRAME {
            // Frame end in absolute samples → ms.
            let t_ms = (self.consumed + FRAME as u64) * 1000 / TARGET_SAMPLE_RATE as u64;
            let rms = rms_of(&self.buf[..FRAME]);
            let semitones = if rms >= VOICING_RMS_FLOOR {
                yin_f0(&self.buf[..FRAME], TARGET_SAMPLE_RATE as f32).map(hz_to_semitones)
            } else {
                None
            };
            let voiced = semitones.is_some();
            if voiced {
                self.last_voiced_ms = Some(t_ms);
            }
            self.frames.push_back(FrameStat {
                t_ms,
                voiced,
                semitones,
                rms,
            });

            // Advance by one hop.
            self.consumed += HOP as u64;
            self.buf.drain(..HOP);

            // Drop frames older than the window.
            let cutoff = t_ms.saturating_sub(WINDOW_MS);
            while self.frames.front().is_some_and(|f| f.t_ms < cutoff) {
                self.frames.pop_front();
            }

            if t_ms >= self.last_emit_ms + EMIT_EVERY_MS {
                self.last_emit_ms = t_ms;
                self.emit(t_ms);
            }
        }
    }

    fn emit(&self, now_ms: u64) {
        let voiced_semitones: Vec<f32> = self.frames.iter().filter_map(|f| f.semitones).collect();
        let total = self.frames.len().max(1);
        let voiced_ratio = voiced_semitones.len() as f32 / total as f32;

        let (pitch_var_semitones, monotony_score) = if voiced_semitones.len() >= MIN_VOICED_FRAMES {
            let mean = voiced_semitones.iter().sum::<f32>() / voiced_semitones.len() as f32;
            let var = voiced_semitones
                .iter()
                .map(|x| (x - mean) * (x - mean))
                .sum::<f32>()
                / voiced_semitones.len() as f32;
            let sd = var.sqrt();
            // Expressive speech varies ~2.5+ semitones; < ~1 reads as monotone.
            (sd, (1.0 - sd / 2.5).clamp(0.0, 1.0))
        } else {
            (0.0, 0.0)
        };

        let speaking = self.frames.back().is_some_and(|f| f.voiced);
        let f0_hz = self
            .frames
            .iter()
            .rev()
            .find_map(|f| f.semitones.map(semitones_to_hz))
            .unwrap_or(0.0);
        let silence_ms = match self.last_voiced_ms {
            // No trailing silence while speaking, or before the first voiced frame.
            _ if speaking => 0,
            Some(t) => now_ms.saturating_sub(t),
            None => 0,
        };

        let _ = self.app.emit(
            PROSODY_EVENT,
            ProsodyEvent {
                source: self.source.to_string(),
                f0_hz,
                pitch_var_semitones,
                monotony_score,
                speech_rate_hz: self.speech_rate_hz(),
                voiced_ratio,
                silence_ms,
                longest_pause_ms: self.longest_pause(now_ms),
                speaking,
            },
        );
    }

    /// Longest gap (ms) between consecutive voiced frames in the window, including
    /// the trailing gap up to `now_ms`. With continuous voicing the gap is ~one
    /// hop, so this naturally reflects real silences.
    fn longest_pause(&self, now_ms: u64) -> u64 {
        let voiced_times: Vec<u64> = self
            .frames
            .iter()
            .filter(|f| f.voiced)
            .map(|f| f.t_ms)
            .collect();
        let Some(&last) = voiced_times.last() else {
            // Whole window unvoiced → the pause spans the window we have.
            return self
                .frames
                .front()
                .map(|f| now_ms.saturating_sub(f.t_ms))
                .unwrap_or(0);
        };
        let mut longest = now_ms.saturating_sub(last);
        for pair in voiced_times.windows(2) {
            longest = longest.max(pair[1] - pair[0]);
        }
        longest
    }

    /// Speech rate (syllable nuclei per second) over the frames currently in the
    /// window. Returns 0 until the window spans enough time to be meaningful.
    fn speech_rate_hz(&self) -> f32 {
        let span_ms = match (self.frames.front(), self.frames.back()) {
            (Some(first), Some(last)) => last.t_ms.saturating_sub(first.t_ms),
            _ => 0,
        };
        if span_ms < 1_000 {
            return 0.0;
        }
        let rms: Vec<f32> = self.frames.iter().map(|f| f.rms).collect();
        let nuclei = count_syllable_nuclei(&rms);
        nuclei as f32 / (span_ms as f32 / 1000.0)
    }
}

/// Count syllable nuclei in an RMS envelope — local maxima above a per-window
/// loudness floor, each separated from the previous peak by a clear dip. A cheap
/// approximation of de Jong & Wempe's intensity-peak method; we only need it to
/// be *self-consistent* (the frontend judges rate relative to the speaker's own
/// baseline), not perfectly calibrated.
fn count_syllable_nuclei(rms: &[f32]) -> usize {
    if rms.len() < 3 {
        return 0;
    }
    // dB-ish scale; clamp the floor so silence doesn't blow up the log.
    let db: Vec<f32> = rms.iter().map(|&r| 20.0 * r.max(1e-6).log10()).collect();
    let peak_db = db.iter().copied().fold(f32::MIN, f32::max);
    // Ignore frames more than 25 dB below the window's loudest — that's silence
    // / background, not a voiced syllable.
    let floor = peak_db - 25.0;
    // Require a 2 dB dip between successive nuclei so one syllable isn't counted
    // twice on a noisy plateau.
    const MIN_DIP_DB: f32 = 2.0;

    let mut count = 0usize;
    let mut last_peak: Option<f32> = None;
    let mut valley = f32::MAX;
    for i in 1..db.len() - 1 {
        let v = db[i];
        valley = valley.min(v);
        let is_local_max = v > db[i - 1] && v >= db[i + 1] && v > floor;
        if !is_local_max {
            continue;
        }
        match last_peak {
            None => {
                count += 1;
                last_peak = Some(v);
                valley = v;
            }
            Some(prev) => {
                if v - valley >= MIN_DIP_DB {
                    count += 1;
                    last_peak = Some(v);
                    valley = v;
                } else if v > prev {
                    // Same nucleus rising — track its true peak, don't recount.
                    last_peak = Some(v);
                }
            }
        }
    }
    count
}

/// Root-mean-square amplitude of a frame (samples already in −1..1).
fn rms_of(frame: &[f32]) -> f32 {
    if frame.is_empty() {
        return 0.0;
    }
    let sum: f32 = frame.iter().map(|x| x * x).sum();
    (sum / frame.len() as f32).sqrt()
}

fn hz_to_semitones(hz: f32) -> f32 {
    12.0 * (hz / SEMITONE_REF_HZ).log2()
}

fn semitones_to_hz(st: f32) -> f32 {
    SEMITONE_REF_HZ * 2.0_f32.powf(st / 12.0)
}

/// Estimate fundamental frequency (Hz) of one frame via the YIN algorithm, or
/// `None` if the frame is aperiodic (unvoiced) or out of the human-voice band.
///
/// Steps: squared-difference function → cumulative-mean normalization → absolute
/// threshold with local-minimum refinement → parabolic interpolation for sub-bin
/// accuracy. See de Cheveigné & Kawahara (2002).
fn yin_f0(frame: &[f32], sample_rate: f32) -> Option<f32> {
    let tau_max = (sample_rate / F0_MIN_HZ).ceil() as usize;
    let tau_min = (sample_rate / F0_MAX_HZ).floor() as usize;
    let w = frame.len() / 2;
    if tau_max >= w || tau_min == 0 {
        return None;
    }

    // Difference function d(tau) over the integration window w.
    let mut d = vec![0.0f32; tau_max + 1];
    for (tau, slot) in d.iter_mut().enumerate().take(tau_max + 1).skip(1) {
        let mut sum = 0.0f32;
        for j in 0..w {
            let diff = frame[j] - frame[j + tau];
            sum += diff * diff;
        }
        *slot = sum;
    }

    // Cumulative mean normalized difference d'(tau).
    let mut cmnd = vec![1.0f32; tau_max + 1];
    let mut running = 0.0f32;
    for tau in 1..=tau_max {
        running += d[tau];
        cmnd[tau] = if running > 0.0 {
            d[tau] * tau as f32 / running
        } else {
            1.0
        };
    }

    // First lag below the threshold, then descend to its local minimum.
    let mut tau = tau_min;
    let best_tau = loop {
        if tau > tau_max {
            return None;
        }
        if cmnd[tau] < YIN_THRESHOLD {
            while tau < tau_max && cmnd[tau + 1] < cmnd[tau] {
                tau += 1;
            }
            break tau;
        }
        tau += 1;
    };

    // Parabolic interpolation around best_tau for sub-sample precision.
    let refined = if best_tau > tau_min && best_tau < tau_max {
        let s0 = cmnd[best_tau - 1];
        let s1 = cmnd[best_tau];
        let s2 = cmnd[best_tau + 1];
        let denom = 2.0 * (2.0 * s1 - s2 - s0);
        if denom.abs() > f32::EPSILON {
            best_tau as f32 + (s2 - s0) / denom
        } else {
            best_tau as f32
        }
    } else {
        best_tau as f32
    };

    let f0 = sample_rate / refined;
    (F0_MIN_HZ..=F0_MAX_HZ).contains(&f0).then_some(f0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    /// A clean sine at `freq` should be detected within ~1 Hz by YIN.
    fn synth_sine(freq: f32, samples: usize, rate: f32) -> Vec<f32> {
        (0..samples)
            .map(|n| (2.0 * PI * freq * n as f32 / rate).sin() * 0.5)
            .collect()
    }

    #[test]
    fn yin_detects_known_pitches() {
        let rate = TARGET_SAMPLE_RATE as f32;
        for &freq in &[90.0_f32, 150.0, 220.0, 330.0] {
            let frame = synth_sine(freq, FRAME, rate);
            let est = yin_f0(&frame, rate).expect("voiced sine should yield F0");
            assert!(
                (est - freq).abs() < 3.0,
                "F0 {est} should be within 3 Hz of {freq}"
            );
        }
    }

    #[test]
    fn yin_rejects_noise_and_silence() {
        let rate = TARGET_SAMPLE_RATE as f32;
        let silence = vec![0.0f32; FRAME];
        assert!(yin_f0(&silence, rate).is_none());
    }

    #[test]
    fn syllable_nuclei_counts_bumps() {
        // Five clear loudness bumps separated by dips → ~5 nuclei.
        let mut env = Vec::new();
        for _ in 0..5 {
            env.extend_from_slice(&[0.01, 0.05, 0.3, 0.5, 0.3, 0.05, 0.01]);
        }
        let n = count_syllable_nuclei(&env);
        assert!((4..=6).contains(&n), "expected ~5 nuclei, got {n}");
    }

    #[test]
    fn syllable_nuclei_ignores_flat_silence() {
        let env = vec![0.0001f32; 50];
        assert_eq!(count_syllable_nuclei(&env), 0);
    }

    #[test]
    fn semitone_roundtrip() {
        for &hz in &[80.0_f32, 110.0, 200.0, 350.0] {
            let back = semitones_to_hz(hz_to_semitones(hz));
            assert!((back - hz).abs() < 0.01, "{hz} -> {back}");
        }
    }
}
