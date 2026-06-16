//! Real-time mixer that sums two 16 kHz mono PCM streams (mic + system audio)
//! into one, so a single transcription session can bill 1x instead of 2x.
//! Speaker separation then comes from the provider's diarization rather than
//! from which capture device the audio arrived on.

use std::collections::VecDeque;

use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use super::TARGET_SAMPLE_RATE;

/// Drop the oldest samples once a side backs up beyond this (the other side
/// stalled). Bounds memory and keeps the two streams roughly time-aligned.
const MAX_BACKLOG: usize = TARGET_SAMPLE_RATE as usize * 2; // 2 seconds

/// Sum `rx_a` and `rx_b` sample-by-sample into `tx_out` until both close.
/// Mixes only where both sides have data; once one side ends, the remainder of
/// the other passes through untouched.
pub async fn mix_streams(
    mut rx_a: UnboundedReceiver<Vec<i16>>,
    mut rx_b: UnboundedReceiver<Vec<i16>>,
    tx_out: UnboundedSender<Vec<i16>>,
) {
    let mut a: VecDeque<i16> = VecDeque::new();
    let mut b: VecDeque<i16> = VecDeque::new();
    let mut a_open = true;
    let mut b_open = true;

    while a_open || b_open {
        tokio::select! {
            chunk = rx_a.recv(), if a_open => match chunk {
                Some(c) => a.extend(c),
                None => a_open = false,
            },
            chunk = rx_b.recv(), if b_open => match chunk {
                Some(c) => b.extend(c),
                None => b_open = false,
            },
        }

        // Mix the overlapping prefix of both buffers.
        let n = a.len().min(b.len());
        if n > 0 {
            let mut out = Vec::with_capacity(n);
            for _ in 0..n {
                let s = a.pop_front().unwrap() as i32 + b.pop_front().unwrap() as i32;
                out.push(s.clamp(i16::MIN as i32, i16::MAX as i32) as i16);
            }
            if tx_out.send(out).is_err() {
                return;
            }
        }

        // When one side has permanently ended, flush the other directly.
        if !a_open && !b.is_empty() {
            let out: Vec<i16> = b.drain(..).collect();
            if tx_out.send(out).is_err() {
                return;
            }
        }
        if !b_open && !a.is_empty() {
            let out: Vec<i16> = a.drain(..).collect();
            if tx_out.send(out).is_err() {
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
