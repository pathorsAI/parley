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
    let mut a: VecDeque<i16> = VecDeque::new();
    let mut b: VecDeque<i16> = VecDeque::new();
    let mut a_open = true;
    let mut b_open = true;
    let mut last_a = Instant::now();
    let mut last_b = Instant::now();
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

    while a_open || b_open {
        tokio::select! {
            chunk = rx_a.recv(), if a_open => match chunk {
                Some(c) => {
                    a.extend(c);
                    last_a = Instant::now();
                }
                None => a_open = false,
            },
            chunk = rx_b.recv(), if b_open => match chunk {
                Some(c) => {
                    b.extend(c);
                    last_b = Instant::now();
                }
                None => b_open = false,
            },
            _ = tick.tick() => {}
        }

        // Mix the overlapping prefix of both buffers.
        let n = a.len().min(b.len());
        if n > 0 {
            let mut out = Vec::with_capacity(n);
            for _ in 0..n {
                let s = a.pop_front().unwrap() as i32 + b.pop_front().unwrap() as i32;
                out.push(s.clamp(i16::MIN as i32, i16::MAX as i32) as i16);
            }
            if !emit(out) {
                return;
            }
        }

        // Stall guard: an open-but-silent side must not dam the flowing one.
        // Pass the flowing side straight through; when the stalled side wakes,
        // min-prefix mixing resumes (the streams re-align within MAX_BACKLOG).
        if a_open && b_open {
            if !a.is_empty() && b.is_empty() && last_b.elapsed() >= STALL {
                let out: Vec<i16> = a.drain(..).collect();
                if !emit(out) {
                    return;
                }
            } else if !b.is_empty() && a.is_empty() && last_a.elapsed() >= STALL {
                let out: Vec<i16> = b.drain(..).collect();
                if !emit(out) {
                    return;
                }
            }
        }

        // When one side has permanently ended, flush the other directly.
        if !a_open && !b.is_empty() {
            let out: Vec<i16> = b.drain(..).collect();
            if !emit(out) {
                return;
            }
        }
        if !b_open && !a.is_empty() {
            let out: Vec<i16> = a.drain(..).collect();
            if !emit(out) {
                return;
            }
        }

        // Drift guard: only trim a side that is still producing. A closed
        // side's residual is real captured audio — leave it for the flush
        // above rather than dropping it.
        if a_open && a.len() > MAX_BACKLOG {
            a.drain(..a.len() - MAX_BACKLOG);
        }
        if b_open && b.len() > MAX_BACKLOG {
            b.drain(..b.len() - MAX_BACKLOG);
        }
    }
}
