//! When a meeting redials its transcription provider, and how long it waits.
//!
//! A realtime session is not resumable — every reconnect is a fresh leg with
//! its own handshake and billing session — and hammering a provider (or a
//! network) that is down helps nobody. The ladder doubles from one second and
//! caps at fifteen: long enough to stop hammering, short enough that walking
//! back into Wi-Fi picks the live transcript up within a breath.
//!
//! Unlike the iOS `ReconnectPolicy` there is no attempt ceiling. A desktop
//! meeting can run for hours, and the whole point is to pick the transcript
//! back up whenever the network returns; a handshake that fails while offline
//! costs nothing, and a failure a redial cannot fix (quota, a rejected key) is
//! classified as fatal before it ever reaches this ladder.
//!
//! What IS bounded is redialling for nothing. Every hosted leg that completes
//! its handshake holds an upstream recognizer socket, whether or not it ever
//! carries a sample, so a meeting that is not capturing audio (paused, a
//! microphone that went away, a Mac that slept with the meeting open) must not
//! keep opening legs. Two rules keep it from happening:
//!
//! - a leg that has carried no audio for [`LEG_IDLE`] is closed by the client
//!   (well inside the relay's own 90 s idle timeout), and
//! - after the first leg, a redial waits until there is captured audio for the
//!   new leg to carry (see `SttBridge::audio_held`).
//!
//! Before these, a meeting left open with no audio flowing redialled every
//! ~93 s for as long as the app ran: the relay idled each leg out at 90 s, the
//! 90 s leg counted as "a genuine connection" and reset the ladder to one
//! second, and the next leg idled out the same way — ~2 000 empty sessions in
//! three days from one desktop (2026-10-10..12). The ladder now resets only
//! after a leg that carried audio, so a leg dying the same way again and again
//! climbs to the cap instead of redialling every second.
//!
//! Extracted from the session loop so the arithmetic is testable without a
//! socket: a loop that gives up on the first blip, or one that redials a dead
//! network every 100 ms, is invisible in a UI test and obvious in a unit test.

use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ReconnectPolicy {
    /// Delay before the first redial.
    pub base: Duration,
    /// Ceiling the doubling stops at.
    pub cap: Duration,
    /// A leg that stayed up at least this long before dying — AND carried
    /// audio — was a genuine connection, not another failed redial: the
    /// ladder starts over, so a blip an hour into a meeting is retried after
    /// one second, not fifteen.
    pub reset_after: Duration,
    /// Each delay is spread by up to this fraction either way, so a relay
    /// deploy that drops every desktop at once is not redialled by all of
    /// them on the same second.
    pub jitter: f64,
}

/// A meeting leg that has carried no captured audio for this long is closed by
/// the client. Below the hosted relay's 90 s idle timeout on purpose: the
/// client ends the leg on its own terms (a normal `end`, nothing to redial)
/// instead of the relay failing it, and an idle leg never sits on an upstream
/// socket for hours on keepalives alone (a paused meeting used to hold one
/// until the 6 h session cap, then end transcription with a quota error).
pub const LEG_IDLE: Duration = Duration::from_secs(60);

/// Whether a leg should be closed for carrying no audio: nothing has reached
/// the bridge for [`LEG_IDLE`], counted from the later of the last captured
/// chunk and the leg's start (a leg dialled after a long silence gets the
/// full window, not an instant park).
pub fn leg_is_idle(
    since_last_audio: Option<Duration>,
    since_leg_start: Duration,
    limit: Duration,
) -> bool {
    let quiet = match since_last_audio {
        Some(a) => a.min(since_leg_start),
        None => since_leg_start,
    };
    quiet >= limit
}

impl ReconnectPolicy {
    /// The meeting ladder: 1, 2, 4, 8, 15, 15, … seconds.
    pub const MEETING: Self = Self {
        base: Duration::from_secs(1),
        cap: Duration::from_secs(15),
        reset_after: Duration::from_secs(30),
        jitter: 0.2,
    };

    /// Delay before the `attempt`-th consecutive redial (1-based): 1×, 2×,
    /// 4×, 8× `base`, capped. Deterministic so the ladder can be tested; the
    /// session loop spreads it with [`jittered`](Self::jittered).
    pub fn delay(&self, attempt: u32) -> Duration {
        // Shift rather than `pow`: exact, and it cannot drift past the cap
        // through floating point. 31 keeps the shift defined for any attempt
        // count a session that runs for days might reach.
        let steps = attempt.saturating_sub(1).min(31);
        self.base.saturating_mul(1u32 << steps).min(self.cap)
    }

    /// `delay` spread by ±[`jitter`](Self::jitter), with `unit` a uniform
    /// sample from [0, 1) (out-of-range values are clamped).
    pub fn jittered(&self, delay: Duration, unit: f64) -> Duration {
        let unit = if unit.is_finite() {
            unit.clamp(0.0, 1.0)
        } else {
            0.5
        };
        let factor = 1.0 - self.jitter + 2.0 * self.jitter * unit;
        delay.mul_f64(factor.max(0.0))
    }

    /// The attempt number for the redial after a leg that lived `lived` died,
    /// given the `previous` consecutive attempt (0 = none yet). Only a leg
    /// that `carried_audio` resets the ladder: a leg that sat connected with
    /// nothing to send until something closed it is not evidence that the
    /// link is healthy, and resetting on it is what turned a relay idle
    /// timeout into a redial every ~93 s, forever.
    pub fn next_attempt(&self, previous: u32, lived: Duration, carried_audio: bool) -> u32 {
        if carried_audio && lived >= self.reset_after {
            1
        } else {
            previous.saturating_add(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    #[test]
    fn the_ladder_doubles_from_one_second_and_caps_at_fifteen() {
        let p = ReconnectPolicy::MEETING;
        let ladder: Vec<Duration> = (1..=6).map(|a| p.delay(a)).collect();
        assert_eq!(
            ladder,
            vec![secs(1), secs(2), secs(4), secs(8), secs(15), secs(15)]
        );
    }

    #[test]
    fn the_cap_holds_for_any_attempt_count() {
        let p = ReconnectPolicy::MEETING;
        assert_eq!(p.delay(40), secs(15));
        assert_eq!(p.delay(u32::MAX), secs(15));
        // Attempt 0 is not a real attempt; it gets the base rather than a panic.
        assert_eq!(p.delay(0), secs(1));
    }

    #[test]
    fn consecutive_failures_climb_the_ladder() {
        let p = ReconnectPolicy::MEETING;
        let mut attempt = 0;
        for expected in 1..=5 {
            // Failed handshakes die within seconds.
            attempt = p.next_attempt(attempt, secs(2), true);
            assert_eq!(attempt, expected);
        }
        assert_eq!(p.delay(attempt), secs(15));
    }

    #[test]
    fn a_long_lived_leg_resets_the_ladder() {
        let p = ReconnectPolicy::MEETING;
        let attempt = p.next_attempt(4, secs(30), true);
        assert_eq!(attempt, 1);
        assert_eq!(p.delay(attempt), secs(1));
        // Just short of the threshold keeps climbing.
        assert_eq!(p.next_attempt(4, Duration::from_millis(29_999), true), 5);
    }

    /// The 2026-10-10 storm: the relay idled out every audio-less leg at
    /// ~91 s, and a 91 s leg used to reset the ladder to one second. Without
    /// audio it must climb instead.
    #[test]
    fn a_long_leg_that_carried_no_audio_does_not_reset_the_ladder() {
        let p = ReconnectPolicy::MEETING;
        let mut attempt = 0;
        for _ in 0..6 {
            attempt = p.next_attempt(attempt, secs(91), false);
        }
        assert_eq!(attempt, 6);
        assert_eq!(p.delay(attempt), secs(15));
    }

    #[test]
    fn jitter_spreads_the_delay_within_twenty_percent() {
        let p = ReconnectPolicy::MEETING;
        assert_eq!(p.jittered(secs(10), 0.0), secs(8));
        assert_eq!(p.jittered(secs(10), 0.5), secs(10));
        assert_eq!(p.jittered(secs(10), 1.0), secs(12));
        // Garbage in never escapes the band.
        assert_eq!(p.jittered(secs(10), -3.0), secs(8));
        assert_eq!(p.jittered(secs(10), 7.0), secs(12));
        assert_eq!(p.jittered(secs(10), f64::NAN), secs(10));
        for i in 0..100 {
            let d = p.jittered(secs(15), i as f64 / 100.0);
            assert!(d >= secs(12) && d <= secs(18), "{d:?}");
        }
    }

    #[test]
    fn a_leg_is_idle_after_a_full_window_without_audio() {
        let limit = LEG_IDLE;
        // Audio a moment ago: busy, however old the leg is.
        assert!(!leg_is_idle(Some(secs(1)), secs(3_600), limit));
        // No audio for the whole window on an old leg: idle.
        assert!(leg_is_idle(Some(secs(60)), secs(3_600), limit));
        // Old audio, but the leg itself is young: it gets its full window.
        assert!(!leg_is_idle(Some(secs(600)), secs(5), limit));
        assert!(leg_is_idle(Some(secs(600)), secs(60), limit));
        // Never any audio (a microphone dead from the start).
        assert!(!leg_is_idle(None, secs(59), limit));
        assert!(leg_is_idle(None, secs(60), limit));
    }

    /// The window sits inside the relay's own idle timeout, so the client
    /// always closes an idle leg before the relay fails it.
    #[test]
    fn the_leg_idle_window_is_shorter_than_the_relay_idle_timeout() {
        assert!(LEG_IDLE < secs(90));
    }
}
