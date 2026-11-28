//! Software acoustic echo cancellation for the meeting microphone.
//!
//! Without headphones the speakers play the other side of the call, the mic
//! picks it up, and the "me" session transcribes the other side's words a
//! second time as the user's. The system-audio capture (macOS process tap,
//! Windows WASAPI loopback) is exactly what those speakers are playing, so it
//! is a ready-made far-end reference: WebRTC's AEC3 (pure-Rust port, `sonora`)
//! subtracts its echo from the mic before anything downstream hears the mic.
//!
//! The canceller never touches the audio device: no voice-processing I/O mode,
//! no ducking of other apps — the reason macOS VPIO was rejected (it made
//! every other app's microphone 25–30 dB quieter, see PR #757).
//!
//! Two halves, because the two streams arrive on two different tasks:
//!
//! - [`EchoReference`] is the shared far-end queue. The system-audio tap
//!   [`push`](EchoReference::push)es every chunk into it.
//! - [`EchoCanceller`] lives on the mic task. Before each 10 ms mic frame it
//!   hands every pending far-end frame to AEC3 as render audio, then cancels
//!   the frame. That is how WebRTC itself is driven (render and capture called
//!   from separate threads with jitter); AEC3's own render buffer and delay
//!   estimator absorb uneven chunking, the acoustic + output latency, and the
//!   slow drift between two independently clocked devices.
//!
//! The canceller is a pass-through until the reference is
//! [`enable`](EchoReference::enable)d, which only the separate-tracks meeting
//! does once both captures are up. Mixed-mode meetings, mic-only meetings and
//! voice typing never enable it. If AEC3 errors or panics, the canceller logs
//! once and passes the raw mic through for the rest of the meeting: a
//! transcript with an echo beats a dead "me" side.

use std::collections::VecDeque;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use sonora::config::EchoCanceller as AecConfig;
use sonora::{AudioProcessing, Config, StreamConfig};

use super::TARGET_SAMPLE_RATE;

/// AEC3 works on 10 ms frames: 160 samples at 16 kHz.
pub const FRAME: usize = TARGET_SAMPLE_RATE as usize / 100;

/// Far-end audio the mic side has not consumed yet is capped at one second.
/// The mic task drains the queue every 10 ms, so this is only ever reached
/// when the mic capture stalls or dies while the system audio keeps flowing —
/// bounding memory, and keeping the reference from lagging seconds behind once
/// the mic comes back (AEC3 re-estimates the delay from there).
const MAX_FAR_BACKLOG: usize = TARGET_SAMPLE_RATE as usize;

/// The far-end ("them") audio the mic's echo canceller subtracts. Written by
/// the system-audio tap, drained by [`EchoCanceller`] on the mic task.
pub struct EchoReference {
    enabled: AtomicBool,
    pending: Mutex<VecDeque<i16>>,
}

impl Default for EchoReference {
    fn default() -> Self {
        Self::new()
    }
}

impl EchoReference {
    pub fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            pending: Mutex::new(VecDeque::new()),
        }
    }

    /// Turn echo cancellation on for this meeting. Called once both the mic
    /// and the system audio are capturing in separate-tracks mode; until then
    /// the canceller passes the mic through untouched and pushes are dropped.
    pub fn enable(&self) {
        self.enabled.store(true, Ordering::SeqCst);
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    /// Queue one chunk of what the speakers are playing (16 kHz mono).
    pub fn push(&self, chunk: &[i16]) {
        if !self.is_enabled() {
            return;
        }
        let mut pending = self.pending.lock().unwrap();
        pending.extend(chunk.iter().copied());
        if pending.len() > MAX_FAR_BACKLOG {
            let excess = pending.len() - MAX_FAR_BACKLOG;
            pending.drain(..excess);
        }
    }

    /// Move every whole 10 ms frame queued so far into `out`, leaving a
    /// partial frame queued for next time.
    fn take_frames(&self, out: &mut Vec<i16>) {
        let mut pending = self.pending.lock().unwrap();
        let whole = pending.len() / FRAME * FRAME;
        out.extend(pending.drain(..whole));
    }
}

/// Counters for the end-of-meeting log line: enough to tell from a user's
/// `parley.log` whether the canceller ran and whether it had a reference.
#[derive(Default, Debug, Clone, Copy, PartialEq)]
pub struct AecStats {
    /// Mic frames that went through AEC3.
    pub capture_frames: u64,
    /// Far-end frames handed to AEC3 as render audio.
    pub render_frames: u64,
}

/// The mic side's echo canceller. See the module docs.
pub struct EchoCanceller {
    reference: Arc<EchoReference>,
    /// Built on the first frame after the reference is enabled; `None` before
    /// that and after a failure.
    apm: Option<AudioProcessing>,
    /// AEC3 failed once: pass the raw mic through for good.
    failed: bool,
    /// Mic samples short of a whole frame, carried to the next chunk.
    near: Vec<i16>,
    /// Scratch for far-end frames taken off the reference.
    far: Vec<i16>,
    stats: AecStats,
}

impl EchoCanceller {
    pub fn new(reference: Arc<EchoReference>) -> Self {
        Self {
            reference,
            apm: None,
            failed: false,
            near: Vec::with_capacity(FRAME * 4),
            far: Vec::with_capacity(FRAME * 8),
            stats: AecStats::default(),
        }
    }

    pub fn stats(&self) -> AecStats {
        self.stats
    }

    /// Cancel the echo in one mic chunk (16 kHz mono). AEC3 needs whole 10 ms
    /// frames, so up to 159 samples are held back for the next chunk: the
    /// output can be shorter or longer than the input by less than a frame,
    /// but no sample is ever dropped — the mic stays sample-aligned with the
    /// system audio over the meeting, with a constant delay under 10 ms.
    pub fn process(&mut self, chunk: Vec<i16>) -> Vec<i16> {
        if self.failed || !self.reference.is_enabled() {
            // Pass-through. Anything held from before a failure goes out
            // first, so the stream stays continuous.
            if self.near.is_empty() {
                return chunk;
            }
            let mut out = std::mem::take(&mut self.near);
            out.extend_from_slice(&chunk);
            return out;
        }
        self.near.extend_from_slice(&chunk);
        let whole = self.near.len() / FRAME * FRAME;
        let mut out = Vec::with_capacity(whole);
        for start in (0..whole).step_by(FRAME) {
            let frame: [i16; FRAME] = self.near[start..start + FRAME].try_into().unwrap();
            out.extend_from_slice(&self.cancel_frame(&frame));
        }
        self.near.drain(..whole);
        out
    }

    /// The samples still held back, unprocessed. Called when the mic capture
    /// ends so its last few milliseconds are not lost.
    pub fn flush(&mut self) -> Vec<i16> {
        std::mem::take(&mut self.near)
    }

    /// One 10 ms frame: feed AEC3 the far end queued since the last frame,
    /// then cancel. Falls back to the raw frame (for good) on any failure.
    fn cancel_frame(&mut self, frame: &[i16; FRAME]) -> [i16; FRAME] {
        if self.apm.is_none() && !self.failed {
            match catch_unwind(build_apm) {
                Ok(apm) => {
                    log::info!("[aec] echo cancellation on (AEC3, 16 kHz mono)");
                    self.apm = Some(apm);
                }
                Err(_) => self.fail("building AEC3 panicked"),
            }
        }
        let Some(apm) = self.apm.as_mut() else {
            return *frame;
        };

        self.far.clear();
        self.reference.take_frames(&mut self.far);
        let far = &self.far;
        let mut render_frames = 0u64;
        let mut out = [0i16; FRAME];
        let result = catch_unwind(AssertUnwindSafe(|| -> Result<(), sonora::Error> {
            let mut sink = [0i16; FRAME];
            for f in far.as_chunks::<FRAME>().0 {
                apm.process_render_i16(f, &mut sink)?;
                render_frames += 1;
            }
            apm.process_capture_i16(frame, &mut out)
        }));
        match result {
            Ok(Ok(())) => {
                self.stats.render_frames += render_frames;
                self.stats.capture_frames += 1;
                out
            }
            Ok(Err(e)) => {
                self.fail(&format!("AEC3 rejected a frame: {e:?}"));
                *frame
            }
            Err(_) => {
                self.fail("AEC3 panicked");
                *frame
            }
        }
    }

    fn fail(&mut self, why: &str) {
        log::error!("[aec] {why}; passing the raw microphone through for the rest of the meeting");
        self.failed = true;
        self.apm = None;
    }
}

/// AEC3 alone, at the mic's native 16 kHz mono on both sides. No noise
/// suppression or gain control: every STT provider does its own, and a second
/// pass only costs recognition accuracy. AEC3 enforces its own high-pass
/// filter (≈ 80 Hz), which speech recognition does not mind.
fn build_apm() -> AudioProcessing {
    let stream = StreamConfig::new(TARGET_SAMPLE_RATE, 1);
    AudioProcessing::builder()
        .config(Config {
            echo_canceller: Some(AecConfig::default()),
            ..Default::default()
        })
        .capture_config(stream)
        .render_config(stream)
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: usize = TARGET_SAMPLE_RATE as usize;

    /// Deterministic xorshift noise in -1..1, so the tests are repeatable.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> f32 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 >> 40) as f32 / (1u64 << 23) as f32 * 2.0 - 1.0
        }
    }

    /// A speech-like signal: a glottal pulse train (with slowly gliding pitch)
    /// through two formant resonators, gated on and off in syllable-sized
    /// bursts. Real speech's harmonic structure and on/off envelope are what
    /// AEC3's delay estimator and double-talk detector key on; a pure tone or
    /// steady white noise exercises neither.
    fn speech_like(seconds: f32, f0: f32, formants: (f32, f32), seed: u64) -> Vec<f32> {
        let n = (seconds * SR as f32) as usize;
        let mut rng = Rng(seed);
        let mut out = Vec::with_capacity(n);
        let mut phase = 0.0f32;
        // Two resonators (biquad band-passes).
        let mk = |fc: f32, bw: f32| {
            let r = (-std::f32::consts::PI * bw / SR as f32).exp();
            let theta = 2.0 * std::f32::consts::PI * fc / SR as f32;
            (2.0 * r * theta.cos(), -r * r)
        };
        let (a1, a2) = mk(formants.0, 120.0);
        let (b1, b2) = mk(formants.1, 180.0);
        let (mut y1, mut y2, mut z1, mut z2) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
        for i in 0..n {
            let t = i as f32 / SR as f32;
            let pitch = f0 * (1.0 + 0.15 * (2.0 * std::f32::consts::PI * 0.7 * t).sin());
            phase += pitch / SR as f32;
            let excitation = if phase >= 1.0 {
                phase -= 1.0;
                1.0
            } else {
                0.0
            } + 0.05 * rng.next();
            let y = excitation + a1 * y1 + a2 * y2;
            y2 = y1;
            y1 = y;
            let z = y + b1 * z1 + b2 * z2;
            z2 = z1;
            z1 = z;
            // ~4 syllables per second, with gaps between words.
            let syllable = (t * 4.0).fract();
            let word_gap = (t * 0.8).fract() > 0.8;
            let env = if word_gap {
                0.0
            } else {
                (std::f32::consts::PI * syllable).sin().powi(2)
            };
            out.push((y + 0.6 * z) * env);
        }
        normalize(&mut out, 0.1);
        out
    }

    fn normalize(x: &mut [f32], target_rms: f32) {
        let r = rms(x);
        if r > 0.0 {
            for s in x.iter_mut() {
                *s *= target_rms / r;
            }
        }
    }

    fn rms(x: &[f32]) -> f32 {
        if x.is_empty() {
            return 0.0;
        }
        (x.iter().map(|s| s * s).sum::<f32>() / x.len() as f32).sqrt()
    }

    fn db(ratio: f32) -> f32 {
        20.0 * ratio.max(1e-9).log10()
    }

    /// The speaker → room → mic path: a fixed delay, attenuation, and a short
    /// decaying "room" made of a handful of reflections.
    fn echo_path(far: &[f32], delay_ms: usize, gain: f32) -> Vec<f32> {
        let d = delay_ms * SR / 1000;
        let taps: [(usize, f32); 5] = [(0, 1.0), (37, 0.45), (91, -0.3), (173, 0.2), (311, -0.1)];
        let mut out = vec![0.0f32; far.len()];
        for (i, o) in out.iter_mut().enumerate() {
            let mut acc = 0.0;
            for &(t, g) in &taps {
                if i >= d + t {
                    acc += far[i - d - t] * g;
                }
            }
            *o = acc * gain;
        }
        out
    }

    fn to_i16(x: &[f32]) -> Vec<i16> {
        x.iter()
            .map(|s| (s * 32767.0).clamp(-32768.0, 32767.0) as i16)
            .collect()
    }

    fn to_f32(x: &[i16]) -> Vec<f32> {
        x.iter().map(|&s| s as f32 / 32768.0).collect()
    }

    /// Drive the canceller the way the meeting does: the far end arrives in
    /// one chunking, the mic in another, interleaved in time — far chunks are
    /// pushed as soon as their time has come, mic chunks are processed as
    /// theirs has. `far_chunk`/`mic_chunk` are in samples; uneven sizes model
    /// the process tap and cpal delivering different buffer sizes.
    fn run(far: &[f32], mic: &[f32], far_chunk: usize, mic_chunk: usize) -> Vec<f32> {
        let reference = Arc::new(EchoReference::new());
        reference.enable();
        let mut aec = EchoCanceller::new(reference.clone());
        let far = to_i16(far);
        let mic = to_i16(mic);
        let mut out = Vec::with_capacity(mic.len());
        let (mut fi, mut mi) = (0usize, 0usize);
        while mi < mic.len() {
            // Everything the speakers played up to the end of this mic chunk.
            let mic_end = (mi + mic_chunk).min(mic.len());
            while fi < far.len() && fi < mic_end {
                let end = (fi + far_chunk).min(far.len());
                reference.push(&far[fi..end]);
                fi = end;
            }
            out.extend(aec.process(mic[mi..mic_end].to_vec()));
            mi = mic_end;
        }
        out.extend(aec.flush());
        assert_eq!(
            out.len(),
            mic.len(),
            "the canceller must not drop or invent samples"
        );
        to_f32(&out)
    }

    fn window(x: &[f32], from_s: f32, to_s: f32) -> &[f32] {
        &x[(from_s * SR as f32) as usize..((to_s * SR as f32) as usize).min(x.len())]
    }

    /// Far end only (the user is silent, the other side talks through the
    /// speakers): once converged, the echo left in the mic should be far
    /// below what came in. Delay 60 ms, -6 dB acoustic gain, short reverb,
    /// a bit of mic noise; far and mic delivered in different chunk sizes.
    #[test]
    fn suppresses_a_delayed_reverberant_echo() {
        let far = speech_like(12.0, 140.0, (700.0, 1200.0), 1);
        let mut mic = echo_path(&far, 60, 0.5);
        let mut rng = Rng(9);
        for s in mic.iter_mut() {
            *s += 0.0005 * rng.next();
        }
        let out = run(&far, &mic, 441, 170);
        // Skip the first 4 s: AEC3 needs to find the delay and adapt.
        let before = rms(window(&mic, 4.0, 12.0));
        let after = rms(window(&out, 4.0, 12.0));
        let suppression = db(before / after);
        eprintln!("echo-only suppression after convergence: {suppression:.1} dB");
        assert!(
            suppression >= 20.0,
            "only {suppression:.1} dB of echo suppression"
        );
    }

    /// A long acoustic path (speaker output latency + Bluetooth-ish 180 ms)
    /// must still be found by the delay estimator.
    #[test]
    fn finds_a_long_echo_delay() {
        let far = speech_like(14.0, 120.0, (600.0, 1500.0), 2);
        let mic = echo_path(&far, 180, 0.6);
        let out = run(&far, &mic, 512, 160);
        let suppression = db(rms(window(&mic, 6.0, 14.0)) / rms(window(&out, 6.0, 14.0)));
        eprintln!("180 ms path suppression: {suppression:.1} dB");
        assert!(
            suppression >= 15.0,
            "only {suppression:.1} dB at a 180 ms delay"
        );
    }

    /// The user talking with no far end at all (the other side silent, or
    /// the system audio disconnected): the canceller must leave the voice
    /// essentially as it was.
    #[test]
    fn leaves_near_speech_alone_without_far_end() {
        let near = speech_like(6.0, 210.0, (800.0, 1800.0), 3);
        let silence = vec![0.0f32; near.len()];
        let out = run(&silence, &near, 320, 170);
        let change = db(rms(window(&out, 1.0, 6.0)) / rms(window(&near, 1.0, 6.0)));
        eprintln!("near-only level change: {change:.1} dB");
        assert!(change.abs() <= 1.5, "near speech changed by {change:.1} dB");
    }

    /// Double-talk: both sides talking at once after convergence. The echo
    /// should still go down while the user's own voice comes through — the
    /// failure mode to rule out is AEC gating the mic shut whenever the far
    /// end is active (what VPIO did).
    #[test]
    fn keeps_the_users_voice_during_double_talk() {
        let secs = 16.0;
        let far = speech_like(secs, 130.0, (650.0, 1100.0), 4);
        let echo = echo_path(&far, 70, 0.5);
        // The user starts talking at 8 s, over the far end.
        let mut near = speech_like(secs, 220.0, (850.0, 2000.0), 5);
        for (i, s) in near.iter_mut().enumerate() {
            if i < 8 * SR {
                *s = 0.0;
            }
        }
        let mic: Vec<f32> = echo.iter().zip(&near).map(|(e, n)| e + n).collect();
        let out = run(&far, &mic, 441, 160);

        // Separate what the output contains of each source by correlation:
        // project the output onto the near signal over the double-talk span.
        // AEC3 works in 64-sample blocks, so its output lags its input by a
        // few ms; search that lag first.
        let dot = |a: &[f32], b: &[f32]| a.iter().zip(b).map(|(x, y)| x * y).sum::<f32>();
        let from = 9 * SR;
        let to = secs as usize * SR - 512;
        let n = &near[from..to];
        let lag = (0..256)
            .max_by(|&a, &b| {
                let ca = dot(&out[from + a..to + a], n);
                let cb = dot(&out[from + b..to + b], n);
                ca.partial_cmp(&cb).unwrap()
            })
            .unwrap();
        let o = &out[from + lag..to + lag];
        let e = &echo[from..to];
        // Joint least squares, out ≈ gn·near + ge·echo + rest: how much of
        // each source the output still carries, coherently.
        let (nn, ee, ne) = (dot(n, n), dot(e, e), dot(n, e));
        let (on, oe) = (dot(o, n), dot(o, e));
        let det = nn * ee - ne * ne;
        let gn = (on * ee - oe * ne) / det;
        let ge = (oe * nn - on * ne) / det;
        let (near_db, echo_db) = (db(gn.abs()), db(ge.abs()));
        eprintln!(
            "double-talk (output lag {lag} samples): near voice {near_db:.1} dB, echo {echo_db:.1} dB"
        );
        assert!(
            near_db >= -6.0,
            "user's voice lost {near_db:.1} dB during double-talk"
        );
        assert!(
            echo_db <= -10.0,
            "echo only {echo_db:.1} dB down during double-talk"
        );
    }

    /// The system audio stops mid-meeting (tap died, device unplugged): no
    /// more reference arrives at all. The mic must keep flowing, and the
    /// user's voice must come through.
    #[test]
    fn passes_the_mic_when_the_reference_disappears() {
        let far = speech_like(6.0, 140.0, (700.0, 1200.0), 6);
        let near = speech_like(6.0, 210.0, (800.0, 1800.0), 7);
        // 0–6 s: echo only, with reference. 6–12 s: user talks, no reference.
        let mut mic = echo_path(&far, 60, 0.5);
        mic.extend_from_slice(&near);
        let reference = Arc::new(EchoReference::new());
        reference.enable();
        let mut aec = EchoCanceller::new(reference.clone());
        let far_i = to_i16(&far);
        let mic_i = to_i16(&mic);
        let mut out = Vec::new();
        for (k, chunk) in mic_i.chunks(160).enumerate() {
            let at = k * 160;
            if at < far_i.len() {
                reference.push(&far_i[at..(at + 160).min(far_i.len())]);
            }
            out.extend(aec.process(chunk.to_vec()));
        }
        out.extend(aec.flush());
        let out = to_f32(&out);
        assert_eq!(out.len(), mic.len());
        let change = db(rms(window(&out, 7.0, 12.0)) / rms(window(&mic, 7.0, 12.0)));
        eprintln!("after the reference vanished: near level change {change:.1} dB");
        assert!(
            change >= -3.0,
            "near speech lost {change:.1} dB with no reference"
        );
    }

    /// Not enabled (mixed mode, mic-only meeting): bit-exact pass-through,
    /// same chunking, and far-end pushes are dropped instead of queueing.
    #[test]
    fn is_a_pass_through_until_enabled() {
        let reference = Arc::new(EchoReference::new());
        let mut aec = EchoCanceller::new(reference.clone());
        reference.push(&[1, 2, 3]);
        assert!(reference.pending.lock().unwrap().is_empty());
        let chunk: Vec<i16> = (0..123).collect();
        assert_eq!(aec.process(chunk.clone()), chunk);
        assert_eq!(aec.stats(), AecStats::default());
    }

    /// A stalled mic must not let the far-end queue grow without bound.
    #[test]
    fn caps_the_far_end_backlog() {
        let reference = EchoReference::new();
        reference.enable();
        for _ in 0..50 {
            reference.push(&[0i16; 1000]);
        }
        assert_eq!(reference.pending.lock().unwrap().len(), MAX_FAR_BACKLOG);
    }

    /// CPU cost per 10 ms frame (render + capture), for the PR's numbers.
    /// `cargo test --release --lib aec::tests::cost -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn cost() {
        let far = speech_like(60.0, 140.0, (700.0, 1200.0), 8);
        let mic = echo_path(&far, 60, 0.5);
        let t = std::time::Instant::now();
        let _ = run(&far, &mic, 441, 170);
        let el = t.elapsed();
        let frames = far.len() / FRAME;
        eprintln!(
            "{:.1} µs per 10 ms frame ({:.2}% of one core)",
            el.as_secs_f64() * 1e6 / frames as f64,
            el.as_secs_f64() / 60.0 * 100.0
        );
    }
}
