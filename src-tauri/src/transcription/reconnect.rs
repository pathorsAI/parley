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
//! Extracted from the session loop so the arithmetic is testable without a
//! socket: a loop that gives up on the first blip, or one that redials a dead
//! network every 100 ms, is invisible in a UI test and obvious in a unit test.

use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReconnectPolicy {
    /// Delay before the first redial.
    pub base: Duration,
    /// Ceiling the doubling stops at.
    pub cap: Duration,
    /// A leg that stayed up at least this long before dying was a genuine
    /// connection, not another failed redial: the ladder starts over, so a
    /// blip an hour into a meeting is retried after one second, not fifteen.
    pub reset_after: Duration,
}

impl ReconnectPolicy {
    /// The meeting ladder: 1, 2, 4, 8, 15, 15, … seconds.
    pub const MEETING: Self = Self {
        base: Duration::from_secs(1),
        cap: Duration::from_secs(15),
        reset_after: Duration::from_secs(30),
    };

    /// Delay before the `attempt`-th consecutive redial (1-based): 1×, 2×,
    /// 4×, 8× `base`, capped. Deterministic on purpose — one desktop dialling
    /// one provider has no thundering herd to jitter away from, and a fixed
    /// ladder is a ladder that can be tested.
    pub fn delay(&self, attempt: u32) -> Duration {
        // Shift rather than `pow`: exact, and it cannot drift past the cap
        // through floating point. 31 keeps the shift defined for any attempt
        // count a session that runs for days might reach.
        let steps = attempt.saturating_sub(1).min(31);
        self.base.saturating_mul(1u32 << steps).min(self.cap)
    }

    /// The attempt number for the redial after a leg that lived `lived` died,
    /// given the `previous` consecutive attempt (0 = none yet).
    pub fn next_attempt(&self, previous: u32, lived: Duration) -> u32 {
        if lived >= self.reset_after {
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
            attempt = p.next_attempt(attempt, secs(2));
            assert_eq!(attempt, expected);
        }
        assert_eq!(p.delay(attempt), secs(15));
    }

    #[test]
    fn a_long_lived_leg_resets_the_ladder() {
        let p = ReconnectPolicy::MEETING;
        let attempt = p.next_attempt(4, secs(30));
        assert_eq!(attempt, 1);
        assert_eq!(p.delay(attempt), secs(1));
        // Just short of the threshold keeps climbing.
        assert_eq!(p.next_attempt(4, Duration::from_millis(29_999)), 5);
    }
}
