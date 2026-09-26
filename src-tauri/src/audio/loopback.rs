//! Platform-neutral pieces of the Windows WASAPI loopback source
//! ([`system_windows`](super::system_windows)): sample conversion, silence
//! padding and the reopen policy. They hold no Windows handles, so they are
//! compiled into every test build and exercised on macOS CI too — the capture
//! itself can only run on Windows.

use std::time::Duration;

use cpal::{FromSample, Sample};

/// Downmix interleaved frames of any cpal sample type to mono `f32` in −1..1.
/// A trailing partial frame (never produced by WASAPI, but cheap to guard) is
/// dropped rather than read past.
pub fn downmix_to_mono<T>(data: &[T], channels: usize) -> Vec<f32>
where
    T: Sample,
    f32: FromSample<T>,
{
    let channels = channels.max(1);
    data.chunks_exact(channels)
        .map(|frame| frame.iter().map(|&s| f32::from_sample(s)).sum::<f32>() / channels as f32)
        .collect()
}

/// How long the loopback stream may deliver nothing before we start filling the
/// gap with silence. WASAPI hands over a packet every ~10 ms while anything is
/// rendering, so 150 ms of nothing means the render device has gone idle — not
/// a scheduling hiccup.
pub const PAD_AFTER: Duration = Duration::from_millis(150);

/// Keeps the "them" stream continuous in wall-clock time.
///
/// WASAPI loopback only produces packets while something is being rendered;
/// with nothing playing (the counterpart muted, a pause in the call) the
/// capture event is simply never signalled and no frames arrive at all. The
/// mixer survives a silent side (it bypasses one that stalls), but it then
/// re-gates the mic for a moment on every notification sound, the far-end
/// analyzer loses its time base, and a non-diarized "them" session would sit on
/// a socket with no audio. macOS never has this problem because a running
/// process tap keeps delivering (silent) frames, so the Windows source restores
/// the same contract: once real audio has been absent for [`PAD_AFTER`], zeros
/// are emitted to cover exactly the wall-clock time that passed.
///
/// Times are durations since the capture started, passed in by the caller so
/// the policy is testable without sleeping.
pub struct SilencePadder {
    rate: u32,
    /// Wall-clock point up to which the stream has been accounted for, by real
    /// audio or by padding.
    covered: Duration,
    /// When real audio last arrived.
    last_real: Duration,
}

impl SilencePadder {
    pub fn new(rate: u32) -> Self {
        Self {
            rate,
            covered: Duration::ZERO,
            last_real: Duration::ZERO,
        }
    }

    /// Real audio arrived at `now`. It is live capture, so it accounts for the
    /// stream up to `now` — this re-anchors padding and keeps device-clock vs.
    /// wall-clock drift from accumulating into one large burst of silence.
    pub fn on_audio(&mut self, now: Duration) {
        self.last_real = now;
        self.covered = self.covered.max(now);
    }

    /// Number of zero samples to emit at `now` (0 while real audio is flowing).
    pub fn pad(&mut self, now: Duration) -> usize {
        if now.saturating_sub(self.last_real) < PAD_AFTER || now <= self.covered {
            return 0;
        }
        // Whole-sample boundaries on both ends, so repeated small pads never
        // lose or gain a sample to rounding.
        let n = self.samples_at(now) - self.samples_at(self.covered);
        self.covered = now;
        n as usize
    }

    fn samples_at(&self, t: Duration) -> u64 {
        (t.as_nanos() * self.rate as u128 / 1_000_000_000) as u64
    }
}

/// First retry delay after a failed open; doubles per consecutive failure.
const RETRY_BASE: Duration = Duration::from_millis(250);
/// Retry delay ceiling — a device that stays gone is polled at this pace.
const RETRY_MAX: Duration = Duration::from_secs(5);
/// A stream that survived this long counts as healthy: losing it afterwards is
/// a fresh incident (device switched, format changed), not part of a flapping
/// series, so the backoff starts over.
const STABLE_AFTER: Duration = Duration::from_secs(5);
/// Tell the user once the capture has been down this long in one stretch.
pub const WARN_AFTER: Duration = Duration::from_secs(3);

/// When to (re)open the loopback stream.
///
/// A WASAPI stream dies for ordinary reasons mid-meeting: the endpoint is
/// unplugged (Bluetooth headset off), the user changes its format in Sound
/// settings, or the audio service restarts — all surface as
/// `AUDCLNT_E_DEVICE_INVALIDATED` on the stream. The first reopen is immediate
/// (the new default endpoint is usually ready); consecutive failures back off
/// exponentially up to [`RETRY_MAX`] so a machine with no output device at all
/// isn't hammered. Switching the default device is not a failure and goes
/// through [`ReopenPolicy::switched`], which never delays.
pub struct ReopenPolicy {
    failures: u32,
    retry_at: Duration,
    opened_at: Option<Duration>,
    /// Start of the current stretch without a working stream.
    down_since: Option<Duration>,
    warned: bool,
}

impl ReopenPolicy {
    pub fn new() -> Self {
        Self {
            failures: 0,
            retry_at: Duration::ZERO,
            opened_at: None,
            down_since: Some(Duration::ZERO),
            warned: false,
        }
    }

    /// Whether an open should be attempted now (only meaningful while closed).
    pub fn should_try(&self, now: Duration) -> bool {
        self.opened_at.is_none() && now >= self.retry_at
    }

    /// The stream opened at `now`.
    pub fn opened(&mut self, now: Duration) {
        self.opened_at = Some(now);
        self.down_since = None;
    }

    /// An open attempt failed at `now`; returns the delay until the next try.
    pub fn open_failed(&mut self, now: Duration) -> Duration {
        self.schedule(now)
    }

    /// A running stream died at `now` (device invalidated, driver error);
    /// returns the delay until the reopen attempt.
    pub fn lost(&mut self, now: Duration) -> Duration {
        if let Some(opened) = self.opened_at.take() {
            if now.saturating_sub(opened) >= STABLE_AFTER {
                self.failures = 0;
            }
        }
        self.down_since.get_or_insert(now);
        self.schedule(now)
    }

    /// The default render device changed under a running stream: close it and
    /// reopen on the new one right away, without touching the failure count.
    pub fn switched(&mut self, now: Duration) {
        self.opened_at = None;
        self.retry_at = now;
        self.down_since.get_or_insert(now);
    }

    /// True exactly once per meeting: the first time the capture has been down
    /// for [`WARN_AFTER`] in one stretch.
    pub fn should_warn(&mut self, now: Duration) -> bool {
        match self.down_since {
            Some(since) if !self.warned && now.saturating_sub(since) >= WARN_AFTER => {
                self.warned = true;
                true
            }
            _ => false,
        }
    }

    fn schedule(&mut self, now: Duration) -> Duration {
        let delay = if self.failures == 0 {
            Duration::ZERO
        } else {
            RETRY_BASE
                .saturating_mul(1u32 << (self.failures - 1).min(16))
                .min(RETRY_MAX)
        };
        self.failures = self.failures.saturating_add(1);
        self.retry_at = now + delay;
        delay
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn downmix_averages_channels_of_float_frames() {
        let stereo = [1.0f32, 0.0, -0.5, -0.5, 0.25, 0.75];
        assert_eq!(downmix_to_mono(&stereo, 2), vec![0.5, -0.5, 0.5]);
    }

    #[test]
    fn downmix_converts_integer_formats_to_unit_range() {
        let pcm = [i16::MAX, i16::MAX, i16::MIN, i16::MIN, 0, 0];
        let mono = downmix_to_mono(&pcm, 2);
        assert!((mono[0] - 1.0).abs() < 1e-3, "{mono:?}");
        assert!((mono[1] + 1.0).abs() < 1e-3, "{mono:?}");
        assert_eq!(mono[2], 0.0);

        let pcm32 = [i32::MAX, 0];
        let mono = downmix_to_mono(&pcm32, 1);
        assert!((mono[0] - 1.0).abs() < 1e-3, "{mono:?}");
    }

    #[test]
    fn downmix_handles_surround_and_drops_partial_frames() {
        // 5.1 mix format: six channels, one of them carrying signal.
        let frame = [0.6f32, 0.0, 0.0, 0.0, 0.0, 0.0];
        let mono = downmix_to_mono(&frame, 6);
        assert_eq!(mono.len(), 1);
        assert!((mono[0] - 0.1).abs() < 1e-6, "{mono:?}");
        // A trailing half frame is ignored instead of read past.
        assert_eq!(downmix_to_mono(&[0.2f32, 0.2, 0.9], 2), vec![0.2]);
        // Zero channels is treated as mono rather than dividing by zero.
        assert_eq!(downmix_to_mono(&[0.3f32], 0), vec![0.3]);
    }

    #[test]
    fn padder_stays_quiet_while_audio_flows() {
        let mut p = SilencePadder::new(16_000);
        for t in (0..1_000).step_by(10) {
            p.on_audio(ms(t));
            assert_eq!(p.pad(ms(t + 5)), 0);
        }
    }

    #[test]
    fn padder_covers_an_idle_device_with_exact_wall_clock_silence() {
        let mut p = SilencePadder::new(16_000);
        // Nothing ever plays: no padding inside the grace period...
        assert_eq!(p.pad(ms(100)), 0);
        // ...then everything since the start, then each tick's increment.
        assert_eq!(p.pad(ms(200)), 3_200);
        assert_eq!(p.pad(ms(220)), 320);
        assert_eq!(p.pad(ms(220)), 0);
        // Over a long idle stretch, the total matches wall clock to the sample.
        let mut total = 3_200 + 320;
        let mut t = 220;
        while t < 60_000 {
            t += 7;
            total += p.pad(ms(t));
        }
        assert_eq!(total, (t * 16) as usize);
    }

    #[test]
    fn padder_resumes_after_real_audio_without_double_counting() {
        let mut p = SilencePadder::new(16_000);
        p.on_audio(ms(1_000));
        // Just after audio: no padding.
        assert_eq!(p.pad(ms(1_100)), 0);
        // Idle past the grace: pad from the last real packet, not from zero.
        assert_eq!(p.pad(ms(1_200)), 3_200);
        // Audio comes back; padding stops again.
        p.on_audio(ms(1_250));
        assert_eq!(p.pad(ms(1_300)), 0);
        // Late-arriving audio never rewinds what was already covered.
        p.on_audio(ms(1_240));
        assert_eq!(p.pad(ms(1_260)), 0);
    }

    #[test]
    fn reopen_first_retry_is_immediate_then_backs_off_to_a_cap() {
        let mut r = ReopenPolicy::new();
        assert!(r.should_try(ms(0)));
        let delays: Vec<_> = (0..8).map(|_| r.open_failed(ms(0))).collect();
        assert_eq!(
            delays,
            vec![
                ms(0),
                ms(250),
                ms(500),
                ms(1_000),
                ms(2_000),
                ms(4_000),
                ms(5_000),
                ms(5_000)
            ]
        );
        assert!(!r.should_try(ms(4_999)));
        assert!(r.should_try(ms(5_000)));
    }

    #[test]
    fn reopen_does_not_retry_while_open() {
        let mut r = ReopenPolicy::new();
        r.opened(ms(0));
        assert!(!r.should_try(ms(10_000)));
    }

    #[test]
    fn reopen_resets_backoff_after_a_stable_stream() {
        let mut r = ReopenPolicy::new();
        r.open_failed(ms(0));
        r.open_failed(ms(0));
        r.open_failed(ms(0));
        r.opened(ms(1_000));
        // Healthy for a minute, then the headset is unplugged: immediate retry.
        assert_eq!(r.lost(ms(61_000)), ms(0));
        assert!(r.should_try(ms(61_000)));
    }

    #[test]
    fn reopen_keeps_backing_off_when_a_stream_flaps() {
        let mut r = ReopenPolicy::new();
        r.opened(ms(0));
        assert_eq!(r.lost(ms(100)), ms(0));
        r.opened(ms(100));
        // Died again within the stability window: this is the same incident.
        assert_eq!(r.lost(ms(200)), ms(250));
        r.opened(ms(450));
        assert_eq!(r.lost(ms(500)), ms(500));
    }

    #[test]
    fn default_device_switch_reopens_at_once_without_counting_a_failure() {
        let mut r = ReopenPolicy::new();
        r.open_failed(ms(0));
        r.open_failed(ms(0));
        r.opened(ms(300));
        r.switched(ms(400));
        assert!(r.should_try(ms(400)));
        r.opened(ms(410));
        // The switch did not add to the failure count: a flap right after it
        // continues the series where it was, not one step further.
        assert_eq!(r.lost(ms(500)), ms(500));
    }

    #[test]
    fn warns_once_after_a_long_outage_only() {
        let mut r = ReopenPolicy::new();
        // Never opened: down since the start.
        assert!(!r.should_warn(ms(2_999)));
        r.opened(ms(1_000));
        assert!(!r.should_warn(ms(10_000)));
        // A brief loss (switching devices) does not warn...
        r.switched(ms(20_000));
        assert!(!r.should_warn(ms(20_500)));
        r.opened(ms(20_500));
        // ...a lasting one does, exactly once.
        r.lost(ms(30_000));
        assert!(!r.should_warn(ms(32_000)));
        assert!(r.should_warn(ms(33_000)));
        assert!(!r.should_warn(ms(40_000)));
    }

    #[test]
    fn warns_when_the_first_open_never_succeeds() {
        let mut r = ReopenPolicy::new();
        r.open_failed(ms(0));
        assert!(r.should_warn(ms(3_000)));
    }
}
