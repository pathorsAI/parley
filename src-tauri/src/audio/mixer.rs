//! Real-time mixer that sums two 16 kHz mono PCM streams (mic + system audio)
//! into one, so a single transcription session can bill 1x instead of 2x.
//! Speaker separation then comes from the provider's diarization rather than
//! from which capture device the audio arrived on.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use tauri::AppHandle;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use super::TARGET_SAMPLE_RATE;
use crate::transcription::common::{LevelMeter, LEVEL_EVENT};

/// Drop the oldest samples once a side backs up beyond this (the other side
/// stalled). Bounds memory and keeps the two streams roughly time-aligned.
const MAX_BACKLOG: usize = TARGET_SAMPLE_RATE as usize * 2; // 2 seconds

/// A side that is open but hasn't delivered for this long is treated as stalled
/// and stops gating the other side. Critical failure mode: the system-audio tap
/// "starts" without the System Audio Recording permission but never produces a
/// frame — min-prefix mixing alone would then dam the MIC too, and the whole
/// meeting transcribes nothing.
const STALL: Duration = Duration::from_millis(600);

/// One input stream's pending samples plus the liveness bookkeeping the mixer
/// needs about it: whether the producer is still open and when it last handed
/// over a chunk.
struct Side {
    buf: VecDeque<i16>,
    open: bool,
    last: Instant,
}

impl Side {
    fn new() -> Self {
        Self {
            buf: VecDeque::new(),
            open: true,
            last: Instant::now(),
        }
    }

    /// Absorb one `recv` result: buffer the chunk, or mark the side closed.
    fn accept(&mut self, chunk: Option<Vec<i16>>) {
        match chunk {
            Some(c) => {
                self.buf.extend(c);
                self.last = Instant::now();
            }
            None => self.open = false,
        }
    }

    /// Open but silent for [STALL] — it must stop gating the other side.
    fn is_stalled(&self) -> bool {
        self.last.elapsed() >= STALL
    }

    /// Whether this side's pending samples may be forwarded unmixed: the
    /// counterpart has permanently ended (nothing left to mix with), or — while
    /// both are still open — it has stalled and must not dam this one.
    fn may_bypass(&self, other: &Side) -> bool {
        !other.open || (self.open && other.is_stalled())
    }

    fn take_all(&mut self) -> Vec<i16> {
        self.buf.drain(..).collect()
    }

    /// Drift guard: only trim a side that is still producing. A closed side's
    /// residual is real captured audio — leave it for the bypass flush rather
    /// than dropping it.
    fn trim_backlog(&mut self) {
        if self.open && self.buf.len() > MAX_BACKLOG {
            self.buf.drain(..self.buf.len() - MAX_BACKLOG);
        }
    }
}

/// Sum the overlapping prefix of both sides, consuming it. `None` when the two
/// don't currently overlap, so there is nothing to mix.
fn mix_prefix(a: &mut Side, b: &mut Side) -> Option<Vec<i16>> {
    let n = a.buf.len().min(b.buf.len());
    if n == 0 {
        return None;
    }
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let s = a.buf.pop_front().unwrap() as i32 + b.buf.pop_front().unwrap() as i32;
        out.push(s.clamp(i16::MIN as i32, i16::MAX as i32) as i16);
    }
    Some(out)
}

/// Audio that has to skip mixing this round: the flowing side's buffer once its
/// counterpart ended or stalled. When the stalled side wakes, min-prefix mixing
/// resumes (the streams re-align within MAX_BACKLOG). At most one side can hold
/// samples here — [`mix_prefix`] just drained the overlap.
fn bypass(a: &mut Side, b: &mut Side) -> Option<Vec<i16>> {
    if !a.buf.is_empty() && a.may_bypass(b) {
        Some(a.take_all())
    } else if !b.buf.is_empty() && b.may_bypass(a) {
        Some(b.take_all())
    } else {
        None
    }
}

/// Sum `rx_a` and `rx_b` sample-by-sample into `tx_out` until both close.
/// Mixes where both sides have data; a side that ends (or stalls — see [STALL])
/// stops gating the other, whose audio then passes through untouched. The mixed
/// OUTPUT is metered and emitted as the "me" input level, so the header meter
/// reflects everything being captured (mic + system) rather than the mic alone
/// — otherwise system audio playing with no mic input would leave the meter
/// flat even though it is being recorded and transcribed.
pub async fn mix_streams(
    app: AppHandle,
    mut rx_a: UnboundedReceiver<Vec<i16>>,
    mut rx_b: UnboundedReceiver<Vec<i16>>,
    tx_out: UnboundedSender<Vec<i16>>,
) {
    let mut meter = LevelMeter::new(app, "me", LEVEL_EVENT);
    let mut a = Side::new();
    let mut b = Side::new();
    // Wakes the loop so a stall is detected even when the stalled side never
    // delivers another chunk (recv alone would park us until the OTHER side's
    // next chunk, which is fine while it flows — the tick covers full silence).
    let mut tick = tokio::time::interval(Duration::from_millis(200));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    // Meter then forward one output chunk. Every send routes through here so the
    // "me" level reflects the exact mixed audio and no emit path is missed.
    // Returns `false` once the consumer is gone, so the caller can stop.
    let mut emit = |out: Vec<i16>| -> bool {
        meter.push(&out);
        tx_out.send(out).is_ok()
    };

    while a.open || b.open {
        tokio::select! {
            chunk = rx_a.recv(), if a.open => a.accept(chunk),
            chunk = rx_b.recv(), if b.open => b.accept(chunk),
            _ = tick.tick() => {}
        }

        if let Some(out) = mix_prefix(&mut a, &mut b) {
            if !emit(out) {
                return;
            }
        }
        if let Some(out) = bypass(&mut a, &mut b) {
            if !emit(out) {
                return;
            }
        }

        a.trim_backlog();
        b.trim_backlog();
    }
}
