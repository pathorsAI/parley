//! Real-time prosody analysis of the user's own ("me") microphone stream.
//!
//! This is the live-coaching counterpart to [`LevelMeter`](crate::transcription::common::LevelMeter):
//! where the level meter shows raw loudness, [`ProsodyAnalyzer`] derives *delivery*
//! signals — pitch variation (monotony) and pausing — from the same 16 kHz mono
//! PCM, and emits an `audio://prosody` event ~6–7×/s for the frontend gauges/nudges.
//!
//! HARD CONSTRAINT (issue #22): delivery is scored on the **mic ("me") stream
//! only**, never the counterpart. The caller taps the pre-mix mic receiver
//! *before* the mixer (see `spawn_mic_prosody_tap` in `commands.rs`), so with
//! diarization on we still analyze raw mic, not the mixed/diarized stream. The
//! system-audio stream IS analyzed too ([`FarEndAnalyzer`]) — but only as a
//! reference for rejecting the far voice bleeding through the speakers into the
//! mic; it feeds no user-facing stat of its own.
//!
//! F0 is estimated with a self-contained YIN detector (no extra crates, in keeping
//! with the project's no-native-deps posture). Monotony is the spread of F0 *in
//! semitones* over a rolling window: a log scale whose variance is independent of
//! the reference pitch, so it calibrates to the speaker rather than to absolute Hz.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::audio::TARGET_SAMPLE_RATE;
use crate::transcription::common::PROSODY_EVENT;

/// Analysis frame: ~64 ms at 16 kHz. Large enough that the YIN difference function
/// reaches the ~228-sample lag of a low (70 Hz) male voice (needs frame ≥ 2·lag).
const FRAME: usize = 1024;
/// Hop between successive frames: ~16 ms → ~62 frames/s. Finer than the frame so
/// the RMS envelope resolves adjacent syllables in fast speech (a coarser ~32 ms
/// hop smeared them together and under-counted quick talkers).
const HOP: usize = 256;
/// Rolling window over which monotony / pause stats are computed.
const WINDOW_MS: u64 = 7_000;
/// Shorter rolling window for the SPEECH-RATE read specifically: the 7 s monotony
/// window made pace lag by seconds (slow to react, slow to clear). ~2 s (6–10
/// syllables at conversational pace) is the floor where the count still reads
/// stable; the `< 8` frame / `< 800 ms` span guards below it keep startup sane.
const RATE_WINDOW_MS: u64 = 2_000;
/// Emit cadence (~6–7 Hz). Was 500 ms to match the level meter's "glanceable"
/// rate, but that alone put up to half a second between a behavior change and
/// the gauges/nudge logic seeing it — the single largest incidental lag in the
/// delivery path. The DSP work per emit is trivial, so emit near-continuously
/// and let the UI's 200 ms width transition do the visual smoothing.
const EMIT_EVERY_MS: u64 = 150;
/// Minimum voiced (pitched) frames in the window before monotony is meaningful
/// (scaled to the ~16 ms hop so it still means ~0.4 s of real voicing).
const MIN_VOICED_FRAMES: usize = 24;

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

/// Far-end ("them") bleed rejection: with the counterpart played over SPEAKERS,
/// the mic physically hears them, and their speech would otherwise pollute every
/// "me" statistic (pace baseline, pitch spread, filled pauses). The system-audio
/// stream gives us the clean far-end signal, so a mic frame is rejected as bleed
/// when it is pitch-matched to a recent far-end frame — a purely acoustic test
/// (never STT). Headphone users are unaffected: without bleed the mic only ever
/// carries the user's own pitch.
///
/// How long a far-end frame stays queryable. Covers capture/chunking skew between
/// the two streams plus the match window below.
const FAR_RETAIN_MS: u64 = 600;
/// A mic frame is compared against far-end frames at most this much older. Wide
/// enough to absorb the ~100 ms chunk cadence + speaker→mic acoustic delay.
const FAR_MATCH_WINDOW_MS: u64 = 350;
/// "The counterpart is (still) talking" for the dead-air gate — wider than the
/// match window so brief inter-word gaps don't read as the far side going quiet.
const FAR_ACTIVE_WINDOW_MS: u64 = 800;
/// Max pitch distance (semitones, octave-tolerant) for a mic frame to count as
/// the far voice leaking through the speakers. YIN octave errors on the
/// reverberant bleed path are common, hence the octave folding.
const BLEED_SEMITONE_TOL: f32 = 1.0;
/// Bleed must not be dramatically LOUDER than the far-end digital signal; direct
/// speech into the mic usually is. Loose (mic AGC makes levels incomparable) —
/// the pitch match is the primary discriminator, this only rescues the case of
/// the user talking over the far side at a coincidentally matching pitch.
const BLEED_LEVEL_CEIL: f32 = 1.5;

/// Trailing silence (ms) after which the emitted pitch-spread reads as "no
/// signal" (0) instead of lingering on the rolling window's stale frames — the
/// intonation gauge should clear promptly once the user stops talking, not ~7 s
/// later when the window drains.
const PITCH_CLEAR_SILENCE_MS: u64 = 2_000;

/// Filled-pause ("um/uh/呃/痾/嗯") detection. A filled pause is one sustained,
/// flat, vowel-like sound — distinct from connected speech (which has syllable
/// structure) and from a normal syllable (which is short). STT drops these and the
/// LLM filler check ignores them, so they're detected purely acoustically here.
/// Minimum held duration (ms): longer than a normal syllable (~150–250 ms) so we
/// don't flag ordinary speech.
const FILLED_MIN_MS: u64 = 400;
/// Maximum F0 spread (semitones) over the held sound — filled pauses are flat;
/// real words carry more pitch movement.
const FILLED_FLAT_SEMITONES: f32 = 1.2;

/// Payload emitted to the frontend ~6–7×/s. Snake-case on the wire; the frontend
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
    /// Whole-session articulation rate (nuclei per *voiced* second) accumulated
    /// over the mic stream — the streaming twin of [`measure_speech_rate_hz`].
    /// The retro's measured-pace read uses the last value of this instead of
    /// measuring the saved recording, which in diarized meetings is the MIX of
    /// both sides and would score the counterpart's pace too (issue #22).
    session_rate_hz: f32,
    /// Fraction of frames in the window that were voiced (0..1).
    voiced_ratio: f32,
    /// Current trailing silence in ms (0 while speaking).
    silence_ms: u64,
    /// Longest pause within the window in ms.
    longest_pause_ms: u64,
    /// Whether the most recent frame was voiced.
    speaking: bool,
    /// One-shot edge: true on the single emit where a filled pause ("um/uh") has
    /// just been recognized (a sustained, flat, single held vowel). The frontend
    /// counts these + nudges; STT can't see them so this is the only source.
    filled_pause: bool,
    /// Whether the counterpart's (system-audio) stream is currently audible —
    /// the dead-air nudge must not fire while the other side is talking. Always
    /// false when there is no system capture (non-macOS / capture failed).
    farend_active: bool,
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
    /// True while the current trailing voiced run already qualifies as a filled
    /// pause, so it's reported once (rising edge) rather than every emit it's held.
    in_filled_pause: bool,
    /// Cumulative whole-session articulation rate over this (mic-only) stream.
    session_rate: SessionRateMeter,
    /// The counterpart's recent acoustic state, for speaker-bleed rejection.
    /// `None` when there is no system-audio capture to compare against.
    far: Option<Arc<FarEndState>>,
}

impl ProsodyAnalyzer {
    pub fn new(app: AppHandle, source: &'static str, far: Option<Arc<FarEndState>>) -> Self {
        Self {
            app,
            source,
            buf: Vec::with_capacity(FRAME * 2),
            consumed: 0,
            frames: VecDeque::new(),
            last_emit_ms: 0,
            last_voiced_ms: None,
            in_filled_pause: false,
            session_rate: SessionRateMeter::new(),
            far,
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
            // Speaker-bleed rejection: a voiced frame that is really the far
            // side leaking through the speakers is dropped from EVERY "me"
            // statistic — zeroed rms so it can't seed syllable nuclei or raise
            // the per-window loudness floor, and unvoiced so it can't feed the
            // pitch/pace/filled-pause stats or reset the silence clock.
            let bleed = self
                .far
                .as_ref()
                .is_some_and(|f| f.is_bleed_at(Instant::now(), rms, semitones));
            let (rms, semitones) = if bleed { (0.0, None) } else { (rms, semitones) };
            let voiced = semitones.is_some();
            if voiced {
                self.last_voiced_ms = Some(t_ms);
            }
            self.session_rate.push(rms);
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

    fn emit(&mut self, now_ms: u64) {
        // Rising-edge filled-pause detection: qualifies once the trailing held
        // sound passes the duration/flatness/single-nucleus test; reported true
        // only on the transition into that state (drop the borrow before mutating).
        let qualifies = {
            let run = self.current_voiced_run();
            Self::is_filled_pause_run(&run)
        };
        let filled_pause = qualifies && !self.in_filled_pause;
        self.in_filled_pause = qualifies;

        let voiced_semitones: Vec<f32> = self.frames.iter().filter_map(|f| f.semitones).collect();
        let total = self.frames.len().max(1);
        let voiced_ratio = voiced_semitones.len() as f32 / total as f32;

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

        // Once the user has been quiet for a bit, the intonation read is over —
        // report "no signal" instead of letting the rolling window's stale
        // frames hold the gauge at its last value for ~WINDOW_MS.
        let pitch_done = silence_ms >= PITCH_CLEAR_SILENCE_MS;
        let (pitch_var_semitones, monotony_score) =
            if !pitch_done && voiced_semitones.len() >= MIN_VOICED_FRAMES {
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

        let _ = self.app.emit(
            PROSODY_EVENT,
            ProsodyEvent {
                source: self.source.to_string(),
                f0_hz,
                pitch_var_semitones,
                monotony_score,
                speech_rate_hz: self.speech_rate_hz(),
                session_rate_hz: self.session_rate.rate_hz(),
                voiced_ratio,
                silence_ms,
                longest_pause_ms: self.longest_pause(now_ms),
                speaking,
                filled_pause,
                farend_active: self
                    .far
                    .as_ref()
                    .is_some_and(|f| f.is_active_at(Instant::now())),
            },
        );
    }

    /// The current trailing run of voiced speech (walking back from the latest
    /// frame), bridging a single-frame voicing flicker. Empty if not speaking.
    fn current_voiced_run(&self) -> Vec<&FrameStat> {
        let mut run: Vec<&FrameStat> = Vec::new();
        let mut gap = 0;
        for f in self.frames.iter().rev() {
            if f.semitones.is_some() && f.rms >= VOICING_RMS_FLOOR {
                run.push(f);
                gap = 0;
            } else {
                gap += 1;
                if gap > 1 {
                    break;
                }
            }
        }
        run.reverse();
        run
    }

    /// Whether a trailing voiced run is a filled pause: held long enough, with a
    /// flat pitch, and no real syllable structure (one continuous sound, not
    /// connected speech). These three together separate "uhhh" from both a normal
    /// syllable (too short) and a run of real words (multiple nuclei / pitch move).
    fn is_filled_pause_run(run: &[&FrameStat]) -> bool {
        if run.len() < 3 {
            return false;
        }
        let dur_ms = run
            .last()
            .unwrap()
            .t_ms
            .saturating_sub(run.first().unwrap().t_ms);
        if dur_ms < FILLED_MIN_MS {
            return false;
        }
        let semis: Vec<f32> = run.iter().filter_map(|f| f.semitones).collect();
        if semis.len() < 3 {
            return false;
        }
        let mean = semis.iter().sum::<f32>() / semis.len() as f32;
        let var = semis.iter().map(|x| (x - mean) * (x - mean)).sum::<f32>() / semis.len() as f32;
        if var.sqrt() > FILLED_FLAT_SEMITONES {
            return false;
        }
        // A held vowel has ≤1 intensity peak; connected speech has several.
        let rms: Vec<f32> = run.iter().map(|f| f.rms).collect();
        let voiced: Vec<bool> = run.iter().map(|f| f.semitones.is_some()).collect();
        count_syllable_nuclei(&rms, &voiced) <= 1
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

    /// Live speaking rate (syllable nuclei per second) over the most recent
    /// {@link RATE_WINDOW_MS}. Two deliberate choices:
    ///  - a SHORT window (not the 7 s monotony window) so the read reacts quickly
    ///    and doesn't linger after you stop — fixing the "laggy" feel;
    ///  - dividing by the window's wall-clock span (a *speaking* rate, pauses
    ///    included) so the number lines up with the familiar 字/分 references the
    ///    user calibrates against (~180 normal, ~300 fast). Syllable peaks are
    ///    voicing-gated so breaths / fricatives aren't miscounted.
    ///
    /// (The post-call/replay number uses `measure_speech_rate_hz`, an articulation
    /// rate over the whole recording — a different, pause-excluding summary.)
    fn speech_rate_hz(&self) -> f32 {
        let Some(last_t) = self.frames.back().map(|f| f.t_ms) else {
            return 0.0;
        };
        let cutoff = last_t.saturating_sub(RATE_WINDOW_MS);
        let recent: Vec<&FrameStat> = self.frames.iter().filter(|f| f.t_ms >= cutoff).collect();
        if recent.len() < 8 {
            return 0.0;
        }
        let span_ms = recent
            .last()
            .unwrap()
            .t_ms
            .saturating_sub(recent.first().unwrap().t_ms);
        if span_ms < 800 {
            return 0.0;
        }
        let rms: Vec<f32> = recent.iter().map(|f| f.rms).collect();
        // Gate nuclei on YIN voicing (a syllable nucleus is a vowel → pitched).
        let voiced: Vec<bool> = recent.iter().map(|f| f.voiced).collect();
        let nuclei = count_syllable_nuclei(&rms, &voiced);
        nuclei as f32 / (span_ms as f32 / 1000.0)
    }
}

/// Count syllable nuclei in an RMS envelope — local maxima above a per-window
/// loudness floor, each separated from the previous peak by a clear dip, and
/// VOICED (a nucleus is a vowel → pitched). The voicing gate (`voiced[i]`) rejects
/// breaths, fricatives, and clicks that would otherwise inflate the count. A cheap
/// approximation of de Jong & Wempe's intensity-peak method; we only need it to be
/// *self-consistent* (the frontend judges rate relative to the speaker's own
/// baseline), not perfectly calibrated. `voiced` must be the same length as `rms`.
fn count_syllable_nuclei(rms: &[f32], voiced: &[bool]) -> usize {
    if rms.len() < 3 {
        return 0;
    }
    // dB-ish scale; clamp the floor so silence doesn't blow up the log.
    let db: Vec<f32> = rms.iter().map(|&r| 20.0 * r.max(1e-6).log10()).collect();
    let peak_db = db.iter().copied().fold(f32::MIN, f32::max);
    // Ignore frames more than 25 dB below the window's loudest — that's silence
    // / background, not a voiced syllable.
    let floor = peak_db - 25.0;
    // Require a dip between successive nuclei so one syllable isn't counted twice
    // on a noisy plateau. Kept modest (1.2 dB) because fast, connected speech
    // smooths the inter-syllable valleys via coarticulation — a stricter threshold
    // merged adjacent syllables and systematically UNDER-counted quick talkers,
    // capping the measured rate well below their real pace.
    const MIN_DIP_DB: f32 = 1.2;

    let mut count = 0usize;
    let mut last_peak: Option<f32> = None;
    let mut valley = f32::MAX;
    for i in 1..db.len() - 1 {
        let v = db[i];
        valley = valley.min(v);
        let is_local_max =
            v > db[i - 1] && v >= db[i + 1] && v > floor && voiced.get(i).copied().unwrap_or(true);
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

/// Batch speech rate (syllable nuclei per second of *voiced* speech — i.e.
/// articulation rate) over a whole decoded recording in normalized mono `f32`.
///
/// Unlike the live [`ProsodyAnalyzer`], which reports a windowed *speaking* rate
/// that includes pauses, this divides by phonation (voiced) time only, so long
/// silences in an uploaded recording don't drag the number down. The replay/retro
/// path uses it so the post-call pace read is a real acoustic measurement — not an
/// LLM guess from the transcript (whose timing reflects STT cadence, not how fast
/// the speaker actually talks). Returns 0.0 when there isn't enough voiced speech.
///
/// Nuclei are counted in `WINDOW_MS`-sized blocks so the per-window loudness floor
/// adapts to a recording whose level drifts, matching the live analyzer's framing.
pub fn measure_speech_rate_hz(pcm: &[f32], sample_rate: u32) -> f32 {
    if sample_rate == 0 || pcm.len() < FRAME {
        return 0.0;
    }
    let hop_sec = HOP as f32 / sample_rate as f32;

    // Per-frame RMS envelope + per-frame voicing (above the loudness floor) — the
    // same framing the live analyzer uses, so the two rates are comparable. Here
    // voicing is RMS-based (the batch has no per-frame YIN); it both gates the
    // nuclei and measures phonation time.
    let mut rms: Vec<f32> = Vec::new();
    let mut voiced: Vec<bool> = Vec::new();
    let mut i = 0;
    while i + FRAME <= pcm.len() {
        let r = rms_of(&pcm[i..i + FRAME]);
        voiced.push(r >= VOICING_RMS_FLOOR);
        rms.push(r);
        i += HOP;
    }
    let voiced_sec = voiced.iter().filter(|&&v| v).count() as f32 * hop_sec;
    if voiced_sec <= 0.0 {
        return 0.0;
    }

    let block = (((WINDOW_MS as f32 / 1000.0) / hop_sec).round() as usize).max(8);
    let mut nuclei = 0usize;
    let mut start = 0;
    while start < rms.len() {
        let end = (start + block).min(rms.len());
        nuclei += count_syllable_nuclei(&rms[start..end], &voiced[start..end]);
        start = end;
    }

    nuclei as f32 / voiced_sec
}

/// Streaming twin of [`measure_speech_rate_hz`]: accumulates the whole-session
/// articulation rate frame-by-frame as the live mic is analyzed, so the retro can
/// report the USER'S pace without ever decoding the saved recording — which in
/// diarized meetings is the mic+system MIX and would fold the counterpart's speech
/// into the number. Framing, per-`WINDOW_MS`-block loudness floor, RMS-based
/// voicing, and the voiced-time denominator all mirror the batch function, so the
/// two quantities stay comparable (upload entries still use the batch measure).
struct SessionRateMeter {
    /// Frames per nuclei-counting block (~`WINDOW_MS`), matching the batch fn.
    block: usize,
    /// Current (partial) block's per-frame RMS envelope + voicing flags.
    rms: Vec<f32>,
    voiced: Vec<bool>,
    /// Totals over all completed blocks.
    nuclei: usize,
    voiced_frames: u64,
}

impl SessionRateMeter {
    fn new() -> Self {
        let hop_sec = HOP as f32 / TARGET_SAMPLE_RATE as f32;
        Self {
            block: (((WINDOW_MS as f32 / 1000.0) / hop_sec).round() as usize).max(8),
            rms: Vec::new(),
            voiced: Vec::new(),
            nuclei: 0,
            voiced_frames: 0,
        }
    }

    /// Feed one analysis frame's RMS. Voicing is RMS-based like the batch measure
    /// (not YIN-gated like the live windowed rate) to keep the quantities aligned.
    fn push(&mut self, rms: f32) {
        self.rms.push(rms);
        self.voiced.push(rms >= VOICING_RMS_FLOOR);
        if self.rms.len() >= self.block {
            self.nuclei += count_syllable_nuclei(&self.rms, &self.voiced);
            self.voiced_frames += self.voiced.iter().filter(|&&v| v).count() as u64;
            self.rms.clear();
            self.voiced.clear();
        }
    }

    /// Articulation rate (nuclei per voiced second) over everything seen so far,
    /// including the current partial block; 0.0 until any voiced speech.
    fn rate_hz(&self) -> f32 {
        let partial_voiced = self.voiced.iter().filter(|&&v| v).count() as u64;
        let voiced_sec =
            (self.voiced_frames + partial_voiced) as f32 * HOP as f32 / TARGET_SAMPLE_RATE as f32;
        if voiced_sec <= 0.0 {
            return 0.0;
        }
        (self.nuclei + count_syllable_nuclei(&self.rms, &self.voiced)) as f32 / voiced_sec
    }
}

/// One analyzed far-end frame, timestamped at analysis time. Wall-clock (not
/// sample-clock) because the mic and system streams are captured by independent
/// tasks whose sample counters aren't aligned.
struct FarFrame {
    at: Instant,
    rms: f32,
    semitones: Option<f32>,
}

/// Shared view of the counterpart's ("them") recent acoustic state. Written by
/// [`FarEndAnalyzer`] on the system-audio task, read by [`ProsodyAnalyzer`] on
/// the mic task to reject speaker bleed — see the `FAR_*`/`BLEED_*` constants.
pub struct FarEndState {
    frames: Mutex<VecDeque<FarFrame>>,
}

impl FarEndState {
    pub fn new() -> Self {
        Self {
            frames: Mutex::new(VecDeque::new()),
        }
    }

    fn push_frame_at(&self, at: Instant, rms: f32, semitones: Option<f32>) {
        let mut frames = self.frames.lock().unwrap();
        frames.push_back(FarFrame { at, rms, semitones });
        while frames
            .front()
            .is_some_and(|f| at.duration_since(f.at).as_millis() as u64 > FAR_RETAIN_MS)
        {
            frames.pop_front();
        }
    }

    /// Whether a VOICED mic frame is the far voice leaking through the speakers:
    /// a recent far-end frame is pitch-matched (octave-tolerant) and the mic
    /// level is plausibly bleed rather than direct speech. Unvoiced mic frames
    /// are never bleed — they carry no pitch and are excluded from stats anyway.
    fn is_bleed_at(&self, now: Instant, mic_rms: f32, mic_semitones: Option<f32>) -> bool {
        let Some(mic_st) = mic_semitones else {
            return false;
        };
        let frames = self.frames.lock().unwrap();
        let mut far_max_rms = 0.0f32;
        let mut pitch_match = false;
        for f in frames.iter().rev() {
            if now.duration_since(f.at).as_millis() as u64 > FAR_MATCH_WINDOW_MS {
                break;
            }
            if f.rms < VOICING_RMS_FLOOR {
                continue;
            }
            far_max_rms = far_max_rms.max(f.rms);
            if let Some(far_st) = f.semitones {
                let d = (far_st - mic_st).abs();
                // Octave-fold: bleed through a speaker+room often YIN-detects an
                // octave off; treat ±12 st as the same voice.
                let d = d.min((d - 12.0).abs());
                if d <= BLEED_SEMITONE_TOL {
                    pitch_match = true;
                }
            }
        }
        pitch_match && mic_rms < far_max_rms * BLEED_LEVEL_CEIL
    }

    /// Whether the far side has produced audible signal within
    /// [`FAR_ACTIVE_WINDOW_MS`] — gates the dead-air nudge ("nobody talking"),
    /// which must not fire in the middle of the counterpart's monologue.
    fn is_active_at(&self, now: Instant) -> bool {
        self.frames.lock().unwrap().iter().rev().any(|f| {
            now.duration_since(f.at).as_millis() as u64 <= FAR_ACTIVE_WINDOW_MS
                && f.rms >= VOICING_RMS_FLOOR
        })
    }
}

/// Streaming analyzer for the SYSTEM-AUDIO ("them") stream: same FRAME/HOP
/// framing and YIN pitch as the mic analyzer, but it only feeds the shared
/// [`FarEndState`] — it emits no events and keeps no windows of its own.
pub struct FarEndAnalyzer {
    buf: Vec<f32>,
    state: Arc<FarEndState>,
}

impl FarEndAnalyzer {
    pub fn new(state: Arc<FarEndState>) -> Self {
        Self {
            buf: Vec::with_capacity(FRAME * 2),
            state,
        }
    }

    /// Feed one PCM chunk (16 kHz mono i16) of the counterpart's audio.
    pub fn push(&mut self, chunk: &[i16]) {
        self.buf.extend(chunk.iter().map(|&s| s as f32 / 32768.0));
        while self.buf.len() >= FRAME {
            let rms = rms_of(&self.buf[..FRAME]);
            let semitones = if rms >= VOICING_RMS_FLOOR {
                yin_f0(&self.buf[..FRAME], TARGET_SAMPLE_RATE as f32).map(hz_to_semitones)
            } else {
                None
            };
            self.state.push_frame_at(Instant::now(), rms, semitones);
            self.buf.drain(..HOP);
        }
    }
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
        let voiced = vec![true; env.len()];
        let n = count_syllable_nuclei(&env, &voiced);
        assert!((4..=6).contains(&n), "expected ~5 nuclei, got {n}");
    }

    #[test]
    fn syllable_nuclei_ignores_flat_silence() {
        let env = vec![0.0001f32; 50];
        assert_eq!(count_syllable_nuclei(&env, &vec![true; env.len()]), 0);
    }

    #[test]
    fn syllable_nuclei_unvoiced_peaks_rejected() {
        // A loud peak that isn't voiced (e.g. a fricative/click burst) must NOT be
        // counted as a syllable — the voicing gate rejects it.
        let env = vec![0.05, 0.5, 0.05];
        assert_eq!(count_syllable_nuclei(&env, &[true, false, true]), 0);
        assert_eq!(count_syllable_nuclei(&env, &[true, true, true]), 1);
    }

    #[test]
    fn syllable_nuclei_splits_shallow_dips() {
        // Two voiced peaks separated by only a ~1.6 dB dip (0.5 → 0.416 → 0.5): a
        // stricter ≥2 dB threshold merged these into one nucleus (under-counting
        // fast, connected speech); the 1.2 dB threshold resolves them as two.
        let env = vec![0.05, 0.5, 0.416, 0.5, 0.05];
        assert_eq!(count_syllable_nuclei(&env, &vec![true; env.len()]), 2);
    }

    #[test]
    fn measure_speech_rate_tracks_bump_density() {
        // 3 s of a 150 Hz carrier amplitude-modulated into 9 loudness bumps
        // (3 syllables/s). The whole clip is voiced, so articulation rate ≈ 3/s.
        let rate = TARGET_SAMPLE_RATE;
        let dur_s = 3.0f32;
        let bumps = 9.0f32;
        let n = (rate as f32 * dur_s) as usize;
        let mut pcm = vec![0f32; n];
        for (k, s) in pcm.iter_mut().enumerate() {
            let t = k as f32 / rate as f32;
            let carrier = (2.0 * PI * 150.0 * t).sin();
            let frac = ((t / dur_s) * bumps).fract();
            let env = 0.5 - 0.5 * (2.0 * PI * frac).cos(); // one raised-cosine peak per bump
            *s = carrier * (0.05 + 0.5 * env);
        }
        let r = measure_speech_rate_hz(&pcm, rate);
        assert!((r - 3.0).abs() < 1.2, "rate {r} should be ~3 syllables/s");
    }

    fn frame_at(i: u64, semitones: f32, rms: f32) -> FrameStat {
        let hop_ms = HOP as u64 * 1000 / TARGET_SAMPLE_RATE as u64;
        FrameStat {
            t_ms: i * hop_ms,
            voiced: true,
            semitones: Some(semitones),
            rms,
        }
    }

    #[test]
    fn filled_pause_detects_held_flat_vowel() {
        // ~480 ms of steady, flat, voiced sound (one held "uhhh") → filled pause.
        let frames: Vec<FrameStat> = (0..30).map(|i| frame_at(i, 0.01 * i as f32, 0.2)).collect();
        let run: Vec<&FrameStat> = frames.iter().collect();
        assert!(ProsodyAnalyzer::is_filled_pause_run(&run));
    }

    #[test]
    fn filled_pause_rejects_short_and_pitch_varied() {
        // Too short (~200 ms) — a normal syllable, not a held filler.
        let short: Vec<FrameStat> = (0..13).map(|i| frame_at(i, 0.0, 0.2)).collect();
        assert!(!ProsodyAnalyzer::is_filled_pause_run(
            &short.iter().collect::<Vec<_>>()
        ));
        // Long but pitch swings widely — a real word, not a flat "um".
        let varied: Vec<FrameStat> = (0..30)
            .map(|i| frame_at(i, (i as f32 * 0.5).sin() * 3.0, 0.2))
            .collect();
        assert!(!ProsodyAnalyzer::is_filled_pause_run(
            &varied.iter().collect::<Vec<_>>()
        ));
    }

    #[test]
    fn session_rate_meter_matches_batch_measure() {
        // The streaming meter must report the same articulation rate the batch
        // function measures over identical audio — it replaces the batch measure
        // for live meetings (where the saved file may be a mix of both sides).
        let rate = TARGET_SAMPLE_RATE;
        let dur_s = 9.0f32; // spans >1 block (~7 s) so completed + partial paths run
        let bumps = 27.0f32; // 3 syllables/s
        let n = (rate as f32 * dur_s) as usize;
        let mut pcm = vec![0f32; n];
        for (k, s) in pcm.iter_mut().enumerate() {
            let t = k as f32 / rate as f32;
            let carrier = (2.0 * PI * 150.0 * t).sin();
            let frac = ((t / dur_s) * bumps).fract();
            let env = 0.5 - 0.5 * (2.0 * PI * frac).cos();
            *s = carrier * (0.05 + 0.5 * env);
        }

        let mut meter = SessionRateMeter::new();
        let mut i = 0;
        while i + FRAME <= pcm.len() {
            meter.push(rms_of(&pcm[i..i + FRAME]));
            i += HOP;
        }

        let batch = measure_speech_rate_hz(&pcm, rate);
        let streaming = meter.rate_hz();
        assert!(batch > 0.0, "batch measure should see the bumps");
        assert!(
            (streaming - batch).abs() < 0.3,
            "streaming {streaming} should match batch {batch}"
        );
    }

    #[test]
    fn farend_pitch_match_rejects_bleed() {
        let far = FarEndState::new();
        let now = Instant::now();
        // Far side spoke ~100 ms ago at 10 st, moderately loud.
        far.push_frame_at(now - std::time::Duration::from_millis(100), 0.2, Some(10.0));

        // Mic frame at the same pitch, quieter → speaker bleed.
        assert!(far.is_bleed_at(now, 0.05, Some(10.3)));
        // Octave-folded match (10 + 12 = 22 st) is still the same voice.
        assert!(far.is_bleed_at(now, 0.05, Some(22.0)));
        // Same pitch but mic much LOUDER than the far signal → the user talking.
        assert!(!far.is_bleed_at(now, 0.5, Some(10.0)));
        // Clearly different pitch → the user talking over the far side.
        assert!(!far.is_bleed_at(now, 0.05, Some(4.0)));
        // Unvoiced mic frames are never bleed.
        assert!(!far.is_bleed_at(now, 0.05, None));
    }

    #[test]
    fn farend_stale_frames_do_not_match() {
        let far = FarEndState::new();
        let now = Instant::now();
        far.push_frame_at(now - std::time::Duration::from_millis(500), 0.2, Some(10.0));
        // Outside FAR_MATCH_WINDOW_MS → no bleed verdict…
        assert!(!far.is_bleed_at(now, 0.05, Some(10.0)));
        // …but still inside FAR_ACTIVE_WINDOW_MS → the far side counts as talking.
        assert!(far.is_active_at(now));
        // And silence far frames never make it active.
        let quiet = FarEndState::new();
        quiet.push_frame_at(now, 0.001, None);
        assert!(!quiet.is_active_at(now));
    }

    #[test]
    fn session_rate_meter_zero_on_silence() {
        let mut meter = SessionRateMeter::new();
        assert_eq!(meter.rate_hz(), 0.0);
        for _ in 0..1000 {
            meter.push(0.0);
        }
        assert_eq!(meter.rate_hz(), 0.0);
    }

    #[test]
    fn measure_speech_rate_zero_on_silence() {
        let silence = vec![0.0f32; TARGET_SAMPLE_RATE as usize];
        assert_eq!(measure_speech_rate_hz(&silence, TARGET_SAMPLE_RATE), 0.0);
        assert_eq!(measure_speech_rate_hz(&[], TARGET_SAMPLE_RATE), 0.0);
    }

    #[test]
    fn semitone_roundtrip() {
        for &hz in &[80.0_f32, 110.0, 200.0, 350.0] {
            let back = semitones_to_hz(hz_to_semitones(hz));
            assert!((back - hz).abs() < 0.01, "{hz} -> {back}");
        }
    }
}
