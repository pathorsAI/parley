//! The platform-neutral half of correction watching: the polling schedule, the
//! settle-and-diff state machine, the stop conditions and the event payload.
//!
//! Each platform module only answers one question per tick — "what does the
//! field we pasted into say right now, and is focus still there?" — as a
//! [`Tick`]. Everything that decides what those answers MEAN lives here, so
//! macOS (Accessibility) and Windows (UI Automation) cannot drift apart on
//! cadence, tolerance or payload, and the logic is unit-testable on any host.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter};

/// Event carrying a possible correction to the frontend. Emitted at most once
/// per observation, to every window (the voice-typing overlay is the one that
/// listens).
pub(super) const CORRECTION_CANDIDATE_EVENT: &str = "voicetyping://correction-candidate";

/// How often the focused field is re-read.
pub(super) const POLL_INTERVAL: Duration = Duration::from_secs(1);
/// Total observation window. A correction that arrives later than this is no
/// longer plausibly "about" the dictation that just happened.
pub(super) const MAX_OBSERVATION: Duration = Duration::from_secs(60);
/// Polling ticks in one observation window.
const TICKS: u64 = MAX_OBSERVATION.as_secs() / POLL_INTERVAL.as_secs();
/// Consecutive identical reads before a changed value counts as settled — so
/// mid-typing snapshots ("Parle", "Parl") don't fire a candidate.
const SETTLED_TICKS: u32 = 2;
/// Consecutive failed reads (or consecutive ticks with focus elsewhere)
/// tolerated before giving up. Accessibility queries fail transiently while the
/// target app is busy; one hiccup must not end a legitimate observation, and a
/// glance at another window shouldn't either.
const MAX_MISSES: u32 = 3;
/// Values longer than this are not worth diffing (a whole document, a code
/// editor's buffer): reading them every second is wasteful and the diff would
/// be meaningless. Counted in CHARS, not bytes.
pub(super) const MAX_VALUE_CHARS: usize = 32768;

/// Bumped by every observation request; a running observation compares against
/// it and exits the moment it is no longer the newest. That makes back-to-back
/// dictations safe: only the latest paste is ever being watched, so an older
/// thread can't emit a candidate about a field the user has already moved on
/// from.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Claim the newest generation. Call it before anything that can fail: even an
/// observation that never arms means a fresh paste happened, so any older
/// watcher is stale and should stop rather than report on it.
pub(super) fn claim_generation() -> u64 {
    GENERATION.fetch_add(1, Ordering::SeqCst) + 1
}

/// Whether `generation` is still the newest observation request.
pub(super) fn is_current(generation: u64) -> bool {
    GENERATION.load(Ordering::SeqCst) == generation
}

/// Whether a field value is short enough to be worth watching. Windows bounds
/// its reads in UTF-16 units at the source instead (see `windows.rs`), so only
/// macOS calls this.
#[cfg(any(target_os = "macos", test))]
pub(super) fn within_limit(value: &str) -> bool {
    value.chars().count() <= MAX_VALUE_CHARS
}

/// Whether `current` is just `baseline` with `inserted` spliced in once — i.e.
/// the paste finally landing, not a user edit.
fn is_paste_landing(baseline: &str, current: &str, inserted: &str) -> bool {
    if inserted.is_empty() || current.len() != baseline.len() + inserted.len() {
        return false;
    }
    current.match_indices(inserted).any(|(i, _)| {
        let (head, rest) = current.split_at(i);
        let tail = &rest[inserted.len()..];
        head.len() + tail.len() == baseline.len()
            && baseline.starts_with(head)
            && baseline.ends_with(tail)
    })
}

/// What one polling tick saw. Produced by the platform module.
#[derive(Debug, Clone)]
pub(super) enum Tick {
    /// A readable value for the watched field.
    Value(String),
    /// Nothing readable this tick — a transient failure or a stale reference.
    NoValue,
    /// Focus is demonstrably somewhere else (another app; on Windows also
    /// another element). "Focus unknown" is NOT this — see the platform module.
    FocusAway,
    /// A newer dictation owns the field now.
    Superseded,
}

/// Why an observation ended without a candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Stop {
    Superseded,
    FocusAway,
    Unreadable,
}

/// A settled value that differs from the baseline. The frontend diffs it
/// against the inserted text and decides whether it is a correction.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Candidate {
    pub baseline: String,
    pub current: String,
    pub inserted_text: String,
}

impl Candidate {
    /// The event payload — one shape for every platform.
    fn payload(&self) -> serde_json::Value {
        json!({
            "baseline": self.baseline,
            "current": self.current,
            "insertedText": self.inserted_text,
        })
    }
}

/// What the state machine wants after a tick.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Step {
    Continue,
    Stop(Stop),
    Emit(Candidate),
}

/// How an observation ended.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Outcome {
    Emitted,
    Stopped(Stop),
    Expired,
}

/// The settle-and-diff state of one observation.
pub(super) struct Watch {
    baseline: String,
    inserted_text: String,
    /// The changed value we are waiting to see hold still, and for how many
    /// consecutive ticks it has held.
    candidate: Option<String>,
    stable_ticks: u32,
    /// Consecutive unreadable ticks / consecutive ticks focused elsewhere.
    /// Counted separately: a glance at another window shouldn't spend the
    /// budget that tolerates a busy target app, and vice versa.
    misses: u32,
    away: u32,
}

impl Watch {
    pub(super) fn new(baseline: String, inserted_text: String) -> Self {
        Self {
            baseline,
            inserted_text,
            candidate: None,
            stable_ticks: 0,
            misses: 0,
            away: 0,
        }
    }

    /// Feed one tick; returns what to do next.
    pub(super) fn step(&mut self, tick: Tick) -> Step {
        match tick {
            Tick::Superseded => Step::Stop(Stop::Superseded),
            Tick::FocusAway => {
                self.away += 1;
                Self::tolerate(self.away, Stop::FocusAway)
            }
            Tick::NoValue => {
                self.misses += 1;
                Self::tolerate(self.misses, Stop::Unreadable)
            }
            Tick::Value(current) => {
                self.misses = 0;
                self.away = 0;
                self.observe_value(current)
            }
        }
    }

    fn tolerate(count: u32, stop: Stop) -> Step {
        if count > MAX_MISSES {
            Step::Stop(stop)
        } else {
            Step::Continue
        }
    }

    fn observe_value(&mut self, current: String) -> Step {
        if current == self.baseline {
            // Back to what we pasted: whatever edit was in flight was undone.
            self.candidate = None;
            self.stable_ticks = 0;
            return Step::Continue;
        }
        // First sighting of this value (or it changed again): restart the
        // settle count with this reading as tick one.
        if self.candidate.as_deref() != Some(current.as_str()) {
            self.candidate = Some(current);
            self.stable_ticks = 1;
            return Step::Continue;
        }
        self.stable_ticks += 1;
        if self.stable_ticks < SETTLED_TICKS {
            return Step::Continue;
        }
        // The baseline is snapshotted right after the paste chord is POSTED,
        // not after the target app has PROCESSED it. If the app was slow, the
        // paste itself shows up here as "the field changed" — adopt it as the
        // real baseline and keep watching for the actual correction instead of
        // spending our one event on it.
        if is_paste_landing(&self.baseline, &current, &self.inserted_text) {
            self.baseline = current;
            self.candidate = None;
            self.stable_ticks = 0;
            return Step::Continue;
        }
        Step::Emit(Candidate {
            baseline: std::mem::take(&mut self.baseline),
            current,
            inserted_text: std::mem::take(&mut self.inserted_text),
        })
    }
}

/// The polling loop with its clock and outputs injected, so the cadence is
/// testable without waiting a minute: sleep one interval, read, step — until
/// the state machine stops or emits, or the window runs out.
fn drive(
    mut watch: Watch,
    mut sleep: impl FnMut(Duration),
    mut read: impl FnMut() -> Tick,
    emit: impl FnOnce(Candidate),
) -> Outcome {
    for _ in 0..TICKS {
        sleep(POLL_INTERVAL);
        match watch.step(read()) {
            Step::Continue => {}
            Step::Stop(stop) => return Outcome::Stopped(stop),
            Step::Emit(candidate) => {
                emit(candidate);
                return Outcome::Emitted;
            }
        }
    }
    Outcome::Expired
}

/// Poll `read` on the calling thread until the field settles on a changed
/// value, focus leaves, the window expires, or a newer dictation supersedes
/// this one. Emits at most one [`CORRECTION_CANDIDATE_EVENT`], then returns.
pub(super) fn run(app: &AppHandle, watch: Watch, read: impl FnMut() -> Tick) {
    let outcome = drive(watch, std::thread::sleep, read, |candidate| {
        log::info!(
            "ax_observe: correction candidate (baseline {} chars, current {} chars)",
            candidate.baseline.chars().count(),
            candidate.current.chars().count()
        );
        let _ = app.emit(CORRECTION_CANDIDATE_EVENT, candidate.payload());
    });
    match outcome {
        Outcome::Emitted => {}
        Outcome::Stopped(Stop::Superseded) => {
            log::info!("ax_observe: stopped (superseded by a newer dictation)")
        }
        Outcome::Stopped(Stop::FocusAway) => {
            log::info!("ax_observe: stopped (focus left the field)")
        }
        Outcome::Stopped(Stop::Unreadable) => log::info!(
            "ax_observe: stopped (no readable value for {} ticks — the field went stale or away)",
            MAX_MISSES + 1
        ),
        Outcome::Expired => log::info!("ax_observe: window expired with no correction"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(s: &str) -> Tick {
        Tick::Value(s.to_string())
    }

    fn watch(baseline: &str, inserted: &str) -> Watch {
        Watch::new(baseline.to_string(), inserted.to_string())
    }

    /// Run `ticks` through `drive` with a fake clock. Returns the outcome, the
    /// emitted candidate (if any), and how many reads happened.
    fn drive_ticks(w: Watch, ticks: Vec<Tick>) -> (Outcome, Option<Candidate>, usize) {
        let mut ticks = ticks.into_iter();
        let mut reads = 0;
        let mut emitted = None;
        let outcome = drive(
            w,
            |_| {},
            || {
                reads += 1;
                ticks.next().unwrap_or_else(|| value("unchanged"))
            },
            |c| emitted = Some(c),
        );
        (outcome, emitted, reads)
    }

    #[test]
    fn paste_landing_detected_at_any_position() {
        assert!(is_paste_landing("", "hello", "hello"));
        assert!(is_paste_landing("a b", "a XY b", " XY"));
        assert!(is_paste_landing("前後", "前中後", "中"));
    }

    #[test]
    fn edits_are_not_paste_landings() {
        // Replacement, not insertion.
        assert!(!is_paste_landing("a 派勒 b", "a Parley b", "Parley"));
        // Insertion of something other than the pasted text.
        assert!(!is_paste_landing("ab", "aXb", "Y"));
        // Same length delta but content doesn't splice back to baseline.
        assert!(!is_paste_landing("abc", "abcX", "Y"));
        assert!(!is_paste_landing("abc", "aXbc", "X!"));
    }

    #[test]
    fn settled_change_emits_once_with_the_payload_shape() {
        let mut w = watch("hi 派勒", "派勒");
        assert_eq!(w.step(value("hi Parley")), Step::Continue);
        let Step::Emit(c) = w.step(value("hi Parley")) else {
            panic!("a value held for two ticks must emit");
        };
        assert_eq!(
            c.payload(),
            json!({ "baseline": "hi 派勒", "current": "hi Parley", "insertedText": "派勒" })
        );
    }

    #[test]
    fn mid_typing_values_do_not_emit() {
        let mut w = watch("x", "x");
        for v in ["Pa", "Par", "Parl", "Parle"] {
            assert_eq!(w.step(value(v)), Step::Continue);
        }
    }

    #[test]
    fn returning_to_the_baseline_resets_the_settle_count() {
        let mut w = watch("base", "base");
        assert_eq!(w.step(value("edit")), Step::Continue);
        assert_eq!(w.step(value("base")), Step::Continue);
        // "edit" again is a first sighting, not a second one.
        assert_eq!(w.step(value("edit")), Step::Continue);
        assert!(matches!(w.step(value("edit")), Step::Emit(_)));
    }

    #[test]
    fn a_slow_paste_landing_becomes_the_new_baseline() {
        let mut w = watch("note: ", "派勒");
        assert_eq!(w.step(value("note: 派勒")), Step::Continue);
        assert_eq!(w.step(value("note: 派勒")), Step::Continue);
        assert_eq!(w.step(value("note: Parley")), Step::Continue);
        let Step::Emit(c) = w.step(value("note: Parley")) else {
            panic!("the real correction must still emit");
        };
        assert_eq!(c.baseline, "note: 派勒");
        assert_eq!(c.current, "note: Parley");
    }

    #[test]
    fn misses_are_tolerated_up_to_the_budget_then_stop() {
        let mut w = watch("a", "a");
        for _ in 0..MAX_MISSES {
            assert_eq!(w.step(Tick::NoValue), Step::Continue);
        }
        assert_eq!(w.step(Tick::NoValue), Step::Stop(Stop::Unreadable));
    }

    #[test]
    fn a_readable_tick_refills_the_miss_budget() {
        let mut w = watch("a", "a");
        for _ in 0..10 {
            for _ in 0..MAX_MISSES {
                assert_eq!(w.step(Tick::NoValue), Step::Continue);
            }
            assert_eq!(w.step(value("a")), Step::Continue);
        }
    }

    #[test]
    fn focus_away_is_tolerated_briefly_then_stops() {
        let mut w = watch("a", "a");
        for _ in 0..MAX_MISSES {
            assert_eq!(w.step(Tick::FocusAway), Step::Continue);
        }
        assert_eq!(w.step(Tick::FocusAway), Step::Stop(Stop::FocusAway));
    }

    #[test]
    fn away_and_miss_budgets_are_separate() {
        let mut w = watch("a", "a");
        for _ in 0..MAX_MISSES {
            assert_eq!(w.step(Tick::FocusAway), Step::Continue);
            assert_eq!(w.step(Tick::NoValue), Step::Continue);
        }
    }

    #[test]
    fn superseded_stops_immediately() {
        let mut w = watch("a", "a");
        assert_eq!(w.step(Tick::Superseded), Step::Stop(Stop::Superseded));
    }

    #[test]
    fn window_is_sixty_one_second_ticks() {
        let mut slept = Vec::new();
        let outcome = drive(watch("a", "a"), |d| slept.push(d), || value("a"), |_| {});
        assert_eq!(outcome, Outcome::Expired);
        assert_eq!(slept.len(), 60);
        assert!(slept.iter().all(|d| *d == Duration::from_secs(1)));
    }

    #[test]
    fn drive_stops_reading_after_the_first_emit() {
        let (outcome, emitted, reads) =
            drive_ticks(watch("a", "a"), vec![value("b"), value("b"), value("c")]);
        assert_eq!(outcome, Outcome::Emitted);
        assert_eq!(emitted.map(|c| c.current), Some("b".to_string()));
        assert_eq!(reads, 2);
    }

    #[test]
    fn drive_reports_why_it_stopped() {
        let ticks = vec![Tick::FocusAway; 4];
        let (outcome, emitted, reads) = drive_ticks(watch("a", "a"), ticks);
        assert_eq!(outcome, Outcome::Stopped(Stop::FocusAway));
        assert!(emitted.is_none());
        assert_eq!(reads, 4);
    }

    #[test]
    fn generation_claims_supersede_older_ones() {
        let older = claim_generation();
        assert!(is_current(older));
        let newer = claim_generation();
        assert!(!is_current(older));
        assert!(is_current(newer));
    }

    #[test]
    fn value_limit_counts_chars_not_bytes() {
        assert!(within_limit(&"字".repeat(MAX_VALUE_CHARS)));
        assert!(!within_limit(&"a".repeat(MAX_VALUE_CHARS + 1)));
    }
}
