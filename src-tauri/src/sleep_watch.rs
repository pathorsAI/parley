//! Tells the frontend when the computer comes back from sleep, and for how
//! long it was gone.
//!
//! A meeting left recording when the lid closes resumes recording on wake:
//! capture picks up where it stopped, the silence guard's clock is reset by
//! the reconnecting link, and the next morning's meeting is absorbed into the
//! same file (one desktop saved a recording created at 20:47 and updated at
//! 14:56 the next day). The frontend ends and saves such a meeting on wake;
//! this is what tells it the machine slept.
//!
//! The detector is a heartbeat, not an OS notification: a thread wakes every
//! [`TICK`] and compares the wall clock with its last beat. Neither macOS nor
//! Windows runs it while the system is asleep, so a gap far longer than the
//! tick is time the machine spent asleep (or the process spent suspended,
//! which is the same thing for a recording). One mechanism on both platforms,
//! and it reports the duration, which a wake notification alone does not.

use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Emitter};

/// How often the heartbeat beats.
const TICK: Duration = Duration::from_secs(15);
/// A gap this much longer than a tick is reported. Small on purpose: the
/// frontend decides what is long enough to act on, and the line in the log
/// is useful either way.
const REPORT_OVER: Duration = Duration::from_secs(60);

/// The event: `{ sleptMs }`.
pub const WAKE_EVENT: &str = "system://wake";

/// How long the machine was away between two beats `tick` apart, if that is
/// worth reporting. A clock that went BACKWARDS (a manual change, NTP) is not
/// a sleep.
pub fn slept_for(prev: SystemTime, now: SystemTime, tick: Duration) -> Option<Duration> {
    let gap = now.duration_since(prev).ok()?;
    let away = gap.checked_sub(tick)?;
    (away >= REPORT_OVER).then_some(away)
}

/// Start the heartbeat thread (once, at startup).
pub fn install(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("sleep-watch".into())
        .spawn(move || {
            let mut prev = SystemTime::now();
            loop {
                std::thread::sleep(TICK);
                let now = SystemTime::now();
                if let Some(away) = slept_for(prev, now, TICK) {
                    log::info!("system: back after ~{} s asleep", away.as_secs());
                    let _ = app.emit(
                        WAKE_EVENT,
                        serde_json::json!({ "sleptMs": away.as_millis() as u64 }),
                    );
                }
                prev = now;
            }
        });
    if let Err(e) = spawned {
        log::error!("system: sleep watch not started: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_ordinary_beat_is_not_a_sleep() {
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        assert_eq!(slept_for(t0, t0 + TICK, TICK), None);
        // A late beat (a busy machine) is not one either.
        assert_eq!(
            slept_for(t0, t0 + TICK + Duration::from_secs(20), TICK),
            None
        );
    }

    #[test]
    fn a_long_gap_reports_the_time_away() {
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let night = Duration::from_secs(10 * 3600);
        assert_eq!(slept_for(t0, t0 + TICK + night, TICK), Some(night));
    }

    #[test]
    fn a_clock_set_backwards_is_not_a_sleep() {
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        assert_eq!(slept_for(t0, t0 - Duration::from_secs(3600), TICK), None);
    }
}
