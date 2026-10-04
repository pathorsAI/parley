//! The meeting's audio → transcription handoff, built so a dropped connection
//! costs the live transcript a gap at most — never the recording.
//!
//! A realtime STT session is not resumable: the socket carries one provider
//! session, and once it dies the next one is a fresh "leg" with its own clock
//! starting at zero. Before this type existed the meter fed the adapter's
//! channel directly, so the leg dying closed that channel, the meter stopped,
//! and the capture behind it shut down with it — losing the network ended the
//! whole meeting (pathorsAI/parley#570). Now the bridge is the meter's only
//! counterparty, and it is always there:
//!
//! ```text
//! meter ──▶ bridge ──┬── attached ──▶ current leg's channel
//!                    └── holding  ──▶ ring of held chunks, flushed into the
//!                                     next leg the moment it is attached
//! ```
//!
//! ## The clock
//!
//! The bridge counts every sample it is handed — post-pause, so the count is
//! a position on the same pause-compacted timeline as the recording. When a
//! new leg is attached, the offset that leg must add to its timestamps is not
//! "now": it is the position of the **oldest sample the new leg will actually
//! receive**, the front of the hold buffer. Offsetting to "now" would file a
//! gap's worth of speech after the words that followed it.
//!
//! ## The handshake
//!
//! A freshly attached leg is only *probing*: it is fed (so transcription
//! starts the moment the handshake completes) but the bridge keeps a copy of
//! everything it is fed until the adapter reports the handshake done
//! ([`SttBridge::confirm`], via `common::note_connected`). A dial into a dead
//! network fails fast, or only after the connect timeout, and takes its
//! channel with it; without the copies, every failed redial would cost the
//! live transcript the audio queued in it.
//!
//! ## The bound
//!
//! Holding is capped at [`HOLD_LIMIT_SECS`] and overflow drops the *oldest*
//! chunk, which also moves the front of the buffer — so the offset handed to
//! the next leg stays honest about what that leg is fed. The recording is
//! teed off before the bridge and is never at risk here; the worst case is a
//! live transcript missing the start of a very long outage.
//!
//! Mirrors the iOS `RelayAudioBridge` (ParleyKit), adapted to a channel-fed
//! adapter: attaching a leg hands it a fresh receiver instead of a client.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio::sync::Notify;

use crate::audio::TARGET_SAMPLE_RATE;

/// How much audio is held for the next leg while there is none. 45 s covers
/// the reconnect ladder (1, 2, 4, 8, 15 … s) plus a slow handshake and the
/// ~10 s a stalled socket takes to be noticed, at a cost of at most
/// 16 000 × 2 B × 45 ≈ 1.4 MB of i16 while full.
pub const HOLD_LIMIT_SECS: u64 = 45;

/// Where the next chunk goes.
enum Route {
    /// A leg was attached but has not finished its handshake: forward to its
    /// channel AND keep a copy in the hold ring. A handshake that fails (fast
    /// while offline, or after the full connect timeout) takes its channel —
    /// and every chunk queued in it — down with it; the copies are what the
    /// next leg is fed instead, at the offset of the first of them.
    Probing(UnboundedSender<Vec<i16>>),
    /// The leg is live (its handshake completed — see [`SttBridge::confirm`]):
    /// forward to its channel only.
    Leg(UnboundedSender<Vec<i16>>),
    /// No leg: keep the chunk for the next one.
    Hold,
    /// No leg is ever coming (a fatal failure gave up on transcription, or
    /// the capture ended): count the chunk for the clock, then drop it rather
    /// than carry a buffer nobody will read.
    Discard,
}

struct Inner {
    route: Route,
    held: VecDeque<Vec<i16>>,
    held_samples: u64,
    /// Samples handed to the bridge so far — the position of the next one.
    total_samples: u64,
    /// Samples actually handed to a live leg (forwards to a confirmed leg,
    /// plus whatever a probing leg was fed by the time it confirmed). What the
    /// session bills: audio dropped from an overflowing hold buffer, discarded,
    /// or swallowed by a handshake that never completed never reached a
    /// provider.
    delivered_samples: u64,
    /// Samples forwarded to the probing leg so far — billed by `confirm`, or
    /// forgotten when the probe dies (its copies are flushed, and billed,
    /// again into the next leg).
    probe_samples: u64,
    hold_limit_samples: u64,
}

impl Inner {
    /// Position of the oldest held sample. Held chunks are always the most
    /// recent ones sent (everything since the last confirmed leg, minus
    /// overflow), so the front sits exactly `held_samples` behind the live
    /// position; with nothing held that is the live position itself.
    fn held_start_samples(&self) -> u64 {
        self.total_samples - self.held_samples
    }

    fn push_held(&mut self, chunk: Vec<i16>) {
        self.held_samples += chunk.len() as u64;
        self.held.push_back(chunk);
        // Overflow drops the oldest chunk, and with it the front of the
        // buffer — `held_start_samples` advances by construction.
        while self.held_samples > self.hold_limit_samples && self.held.len() > 1 {
            if let Some(first) = self.held.pop_front() {
                self.held_samples -= first.len() as u64;
            }
        }
    }

    /// Stop routing to the current leg (probing or live) and hold from here.
    /// A probe's copies stay held — they are the point — and its unconfirmed
    /// forwards go unbilled.
    fn detach(&mut self) {
        if matches!(self.route, Route::Probing(_) | Route::Leg(_)) {
            self.route = Route::Hold;
        }
        self.probe_samples = 0;
    }
}

/// What [`SttBridge::attach`] hands the next leg.
pub struct Attached {
    /// The leg's input. Everything held is already queued in it, in order,
    /// ahead of any live audio.
    pub rx: UnboundedReceiver<Vec<i16>>,
    /// Milliseconds into the (pause-compacted) recording at which the first
    /// sample this leg receives was captured. The leg adds it to every
    /// timestamp it emits.
    pub time_offset_ms: u64,
}

/// Routes the meter's chunks to whichever leg is current and holds them while
/// there is none — or while the current one has yet to prove it is up. See
/// the module docs.
///
/// One producer (the meter task) and one consumer of the lifecycle (the
/// session's reconnect loop, plus the adapter's [`confirm`](Self::confirm)
/// from inside it). The mutex is only ever held for a channel send
/// (non-blocking — the channels are unbounded) or a buffer push, never across
/// an await, so the ~100 ms audio cadence never contends in practice.
pub struct SttBridge {
    inner: Mutex<Inner>,
    /// Set once by [`SttBridge::close`]: the capture ended.
    closed: AtomicBool,
    closed_notify: Notify,
}

impl Default for SttBridge {
    fn default() -> Self {
        Self::new(HOLD_LIMIT_SECS * TARGET_SAMPLE_RATE as u64)
    }
}

impl SttBridge {
    /// A bridge holding at most `hold_limit_samples` while detached. It starts
    /// detached, so audio arriving before the first [`attach`](Self::attach)
    /// is kept for it.
    pub fn new(hold_limit_samples: u64) -> Self {
        Self {
            inner: Mutex::new(Inner {
                route: Route::Hold,
                held: VecDeque::new(),
                held_samples: 0,
                total_samples: 0,
                delivered_samples: 0,
                probe_samples: 0,
                hold_limit_samples,
            }),
            closed: AtomicBool::new(false),
            closed_notify: Notify::new(),
        }
    }

    /// Hand one chunk to the current leg, or hold it. A leg whose receiver is
    /// gone (it died between two chunks) is detached on the spot and the chunk
    /// comes back from the failed send into the hold buffer — so a leg dying
    /// costs nothing that reached the bridge after it stopped reading.
    pub fn send(&self, chunk: Vec<i16>) {
        if self.is_closed() {
            return;
        }
        let mut guard = self.inner.lock().unwrap();
        let inner = &mut *guard;
        let len = chunk.len() as u64;
        inner.total_samples += len;
        let bounced = match &inner.route {
            Route::Leg(tx) => match tx.send(chunk) {
                Ok(()) => {
                    inner.delivered_samples += len;
                    return;
                }
                Err(returned) => returned.0,
            },
            Route::Probing(tx) => match tx.send(chunk.clone()) {
                Ok(()) => {
                    // Forwarded, and kept until the leg proves it is up.
                    inner.probe_samples += len;
                    inner.push_held(chunk);
                    return;
                }
                Err(_) => chunk,
            },
            Route::Hold => {
                inner.push_held(chunk);
                return;
            }
            Route::Discard => return,
        };
        // Reached only when a leg's send bounced: it died, so detach it.
        inner.detach();
        inner.push_held(bounced);
    }

    /// Attach the next leg: create its channel, queue everything held into it
    /// (oldest first), and route live audio to it from now on — probing, so
    /// the held audio stays held until the leg [confirms](Self::confirm).
    /// Offset, flush and swap happen under one lock, so a chunk the meter
    /// sends concurrently lands either in the hold buffer before the flush or
    /// straight in the new channel after it — never out of order.
    ///
    /// `None` once the bridge is closed: the capture has ended and no leg
    /// should be started.
    pub fn attach(&self) -> Option<Attached> {
        if self.is_closed() {
            return None;
        }
        let mut inner = self.inner.lock().unwrap();
        let offset_samples = inner.held_start_samples();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
        for chunk in &inner.held {
            // The receiver is in hand, so this cannot fail.
            let _ = tx.send(chunk.clone());
        }
        inner.probe_samples = inner.held_samples;
        inner.route = Route::Probing(tx);
        Some(Attached {
            rx,
            time_offset_ms: offset_samples * 1000 / TARGET_SAMPLE_RATE as u64,
        })
    }

    /// The probing leg's handshake completed: it has everything it was fed
    /// and will transcribe it, so drop the held copies and bill what it got.
    /// Called from `common::note_connected` (via the `BRIDGE` task-local the
    /// session loop scopes around each leg). A no-op unless a leg is probing —
    /// except that a confirm landing after [`close`](Self::close) (stop hit
    /// mid-handshake, and the leg then came up to flush its input) still bills
    /// the audio that leg is about to transcribe.
    pub fn confirm(&self) {
        let mut guard = self.inner.lock().unwrap();
        let inner = &mut *guard;
        inner.delivered_samples += inner.probe_samples;
        inner.probe_samples = 0;
        if let Route::Probing(tx) = &inner.route {
            inner.route = Route::Leg(tx.clone());
            inner.held.clear();
            inner.held_samples = 0;
        }
    }

    /// The current leg is gone: drop its sender (closing its input, if it is
    /// somehow still reading) and hold audio from here until the next attach.
    /// Idempotent — the meter may already have detached it on a failed send.
    pub fn hold(&self) {
        self.inner.lock().unwrap().detach();
    }

    /// No leg is coming (a failure a redial cannot fix). Drop what is held and
    /// stop holding; the clock keeps counting.
    pub fn discard(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.route = Route::Discard;
        inner.held.clear();
        inner.held_samples = 0;
        inner.probe_samples = 0;
    }

    /// The capture ended: drop the current leg's sender so its input drains
    /// and the provider flushes its final tokens, drop whatever is held, and
    /// wake anyone waiting in [`closed`](Self::closed). A probing leg's
    /// unbilled forwards are kept for a late [`confirm`](Self::confirm).
    pub fn close(&self) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.route = Route::Discard;
            inner.held.clear();
            inner.held_samples = 0;
        }
        self.closed.store(true, Ordering::SeqCst);
        self.closed_notify.notify_waiters();
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Resolves once [`close`](Self::close) has been called (immediately if
    /// it already was) — what a reconnect backoff races against, so stopping
    /// the meeting never waits out a sleep.
    pub async fn closed(&self) {
        loop {
            let notified = self.closed_notify.notified();
            tokio::pin!(notified);
            // Register before checking the flag, so a close landing between
            // the check and the await still wakes us.
            notified.as_mut().enable();
            if self.is_closed() {
                return;
            }
            notified.await;
        }
    }

    /// Samples actually handed to a live leg — see `Inner::delivered_samples`.
    pub fn delivered_samples(&self) -> u64 {
        self.inner.lock().unwrap().delivered_samples
    }

    /// Position of the next sample, in samples.
    #[cfg(test)]
    fn total_samples(&self) -> u64 {
        self.inner.lock().unwrap().total_samples
    }

    /// Samples currently held for the next leg.
    #[cfg(test)]
    fn held_samples(&self) -> u64 {
        self.inner.lock().unwrap().held_samples
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u64 = TARGET_SAMPLE_RATE as u64;

    /// One second of audio whose every sample is `tag`, so a chunk's origin is
    /// readable on the far side.
    fn second(tag: i16) -> Vec<i16> {
        vec![tag; RATE as usize]
    }

    fn drain(rx: &mut UnboundedReceiver<Vec<i16>>) -> Vec<i16> {
        let mut tags = Vec::new();
        while let Ok(chunk) = rx.try_recv() {
            tags.push(chunk[0]);
        }
        tags
    }

    /// Attach a leg and complete its handshake, as a leg that came up does.
    fn live_leg(bridge: &SttBridge) -> Attached {
        let leg = bridge.attach().unwrap();
        bridge.confirm();
        leg
    }

    #[test]
    fn forwards_live_audio_to_the_attached_leg() {
        let bridge = SttBridge::default();
        let mut leg = live_leg(&bridge);
        assert_eq!(leg.time_offset_ms, 0);
        bridge.send(second(1));
        bridge.send(second(2));
        assert_eq!(drain(&mut leg.rx), vec![1, 2]);
        assert_eq!(bridge.held_samples(), 0);
        assert_eq!(bridge.delivered_samples(), 2 * RATE);
    }

    #[test]
    fn holds_while_detached_and_flushes_held_audio_before_live_audio() {
        let bridge = SttBridge::default();
        let first = live_leg(&bridge);
        bridge.send(second(1));
        bridge.hold();
        drop(first);
        bridge.send(second(2));
        bridge.send(second(3));
        assert_eq!(bridge.held_samples(), 2 * RATE);

        let mut next = live_leg(&bridge);
        bridge.send(second(4));
        assert_eq!(drain(&mut next.rx), vec![2, 3, 4]);
        assert_eq!(bridge.held_samples(), 0);
    }

    #[test]
    fn the_next_leg_is_offset_to_the_first_held_sample_not_to_now() {
        let bridge = SttBridge::default();
        let first = live_leg(&bridge);
        for _ in 0..10 {
            bridge.send(second(1));
        }
        bridge.hold();
        drop(first);
        for _ in 0..3 {
            bridge.send(second(2));
        }
        // 10 s went to the first leg, 3 s are held: the next leg starts at
        // the 10 s mark, where the held audio was spoken — not at 13 s.
        let next = bridge.attach().unwrap();
        assert_eq!(next.time_offset_ms, 10_000);
    }

    #[test]
    fn with_nothing_held_the_offset_is_the_live_position() {
        let bridge = SttBridge::default();
        let first = live_leg(&bridge);
        for _ in 0..4 {
            bridge.send(second(1));
        }
        bridge.hold();
        drop(first);
        let next = bridge.attach().unwrap();
        assert_eq!(next.time_offset_ms, 4_000);
    }

    #[test]
    fn overflow_drops_the_oldest_chunk_and_advances_the_offset() {
        let bridge = SttBridge::default();
        // Detached from the start: everything is held.
        for tag in 0..(HOLD_LIMIT_SECS as i16 + 5) {
            bridge.send(second(tag));
        }
        assert_eq!(bridge.total_samples(), (HOLD_LIMIT_SECS + 5) * RATE);
        assert_eq!(bridge.held_samples(), HOLD_LIMIT_SECS * RATE);

        let mut leg = live_leg(&bridge);
        // The five oldest seconds were dropped, so the leg starts at 5 s and
        // its first chunk is the one captured there.
        assert_eq!(leg.time_offset_ms, 5_000);
        let tags = drain(&mut leg.rx);
        assert_eq!(tags.len(), HOLD_LIMIT_SECS as usize);
        assert_eq!(tags[0], 5);
        // Billing counts only what reached the leg, not what overflowed.
        assert_eq!(bridge.delivered_samples(), HOLD_LIMIT_SECS * RATE);
    }

    #[test]
    fn a_dead_leg_makes_the_next_send_hold_instead_of_losing_the_chunk() {
        let bridge = SttBridge::default();
        let first = live_leg(&bridge);
        bridge.send(second(1));
        // The leg died: its receiver is gone, but nobody has called hold().
        drop(first);
        bridge.send(second(2));
        assert_eq!(bridge.held_samples(), RATE);

        let mut next = live_leg(&bridge);
        assert_eq!(next.time_offset_ms, 1_000);
        assert_eq!(drain(&mut next.rx), vec![2]);
        // The chunk that bounced off the dead leg was not billed twice.
        assert_eq!(bridge.delivered_samples(), 2 * RATE);
    }

    #[test]
    fn a_probing_leg_is_fed_and_its_audio_is_also_held() {
        let bridge = SttBridge::default();
        let mut leg = bridge.attach().unwrap();
        bridge.send(second(1));
        bridge.send(second(2));
        // The leg gets the audio now, so its handshake can be followed by
        // transcription without a gap…
        assert_eq!(drain(&mut leg.rx), vec![1, 2]);
        // …but until it proves it is up, a copy stays held, unbilled.
        assert_eq!(bridge.held_samples(), 2 * RATE);
        assert_eq!(bridge.delivered_samples(), 0);
    }

    #[test]
    fn confirm_drops_the_held_copies_and_bills_the_probe_once() {
        let bridge = SttBridge::default();
        bridge.send(second(1)); // held before the first leg
        let mut leg = bridge.attach().unwrap();
        bridge.send(second(2));
        bridge.confirm();
        assert_eq!(bridge.held_samples(), 0);
        bridge.send(second(3));
        assert_eq!(drain(&mut leg.rx), vec![1, 2, 3]);
        // Flushed + probed + live, each counted exactly once.
        assert_eq!(bridge.delivered_samples(), 3 * RATE);
        // A stray second confirm changes nothing.
        bridge.confirm();
        assert_eq!(bridge.delivered_samples(), 3 * RATE);
    }

    #[test]
    fn a_leg_dying_mid_probe_hands_its_audio_to_the_next_leg() {
        let bridge = SttBridge::default();
        let first = live_leg(&bridge);
        for _ in 0..10 {
            bridge.send(second(1));
        }
        // The first leg dropped; a held second, then a redial that never
        // completes its handshake while 4 more seconds go into its channel.
        bridge.hold();
        drop(first);
        bridge.send(second(2));
        let probe = bridge.attach().unwrap();
        assert_eq!(probe.time_offset_ms, 10_000);
        for tag in 3..7 {
            bridge.send(second(tag));
        }
        drop(probe); // handshake failed: the channel dies with the leg
        bridge.hold();
        bridge.send(second(7));

        // The next leg gets everything the failed probe swallowed, from the
        // first sample it was fed — not from the live position (15 s).
        let mut next = live_leg(&bridge);
        assert_eq!(next.time_offset_ms, 10_000);
        assert_eq!(drain(&mut next.rx), vec![2, 3, 4, 5, 6, 7]);
        // The failed probe billed nothing; the first and the next leg did.
        assert_eq!(bridge.delivered_samples(), 16 * RATE);
    }

    #[test]
    fn a_probe_bouncing_on_send_keeps_the_chunk_held_once() {
        let bridge = SttBridge::default();
        let probe = bridge.attach().unwrap();
        bridge.send(second(1));
        drop(probe);
        bridge.send(second(2)); // bounces: detached on the spot
        assert_eq!(bridge.held_samples(), 2 * RATE);
        let mut next = bridge.attach().unwrap();
        assert_eq!(next.time_offset_ms, 0);
        assert_eq!(drain(&mut next.rx), vec![1, 2]);
    }

    #[test]
    fn a_confirm_after_close_still_bills_the_flushing_leg() {
        // Stop landed mid-handshake; the leg then came up and transcribes
        // what it was fed before its input closed.
        let bridge = SttBridge::default();
        let mut leg = bridge.attach().unwrap();
        bridge.send(second(1));
        bridge.close();
        bridge.confirm();
        assert_eq!(drain(&mut leg.rx), vec![1]);
        assert_eq!(bridge.delivered_samples(), RATE);
    }

    #[test]
    fn discard_keeps_the_clock_but_holds_nothing() {
        let bridge = SttBridge::default();
        bridge.send(second(1));
        bridge.discard();
        bridge.send(second(2));
        assert_eq!(bridge.held_samples(), 0);
        assert_eq!(bridge.total_samples(), 2 * RATE);
    }

    #[tokio::test]
    async fn close_ends_the_leg_input_and_refuses_new_legs() {
        let bridge = SttBridge::default();
        let mut leg = live_leg(&bridge);
        bridge.send(second(1));
        bridge.close();
        // The queued chunk still drains, then the input reports closed — the
        // provider's normal final flush.
        assert_eq!(leg.rx.recv().await, Some(second(1)));
        assert_eq!(leg.rx.recv().await, None);
        assert!(bridge.attach().is_none());
        // Already closed: resolves at once.
        bridge.closed().await;
    }

    #[tokio::test]
    async fn closed_wakes_a_waiter_parked_before_the_close() {
        let bridge = std::sync::Arc::new(SttBridge::default());
        let waiter = {
            let bridge = bridge.clone();
            tokio::spawn(async move { bridge.closed().await })
        };
        tokio::task::yield_now().await;
        bridge.close();
        tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
            .await
            .expect("closed() must wake on close()")
            .unwrap();
    }
}
