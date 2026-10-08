//! Shared microphone-capture plumbing for every audio consumer: the live
//! meeting, the Settings mic test, and voice typing.
//!
//! [`MicCoordinator`] is the single source of truth for "who owns the mic".
//! On macOS a second concurrent input stream can make CoreAudio renegotiate
//! the device and silently kill the first capture, so at most ONE pipeline may
//! record at a time. Every start command claims the mic here (a higher-priority
//! user preempts a lower one; a repeated start is an idempotent no-op) and
//! every stop releases it — replacing the pairwise flag checks that used to be
//! scattered across the start/stop commands.
//!
//! A claim owns a [`CaptureSession`]: a fresh per-session gate its capture
//! threads watch, plus their join handles. The gate is never shared across
//! sessions, so a detached/wedged thread from an old session can't be revived
//! by a later start flipping a shared flag back to true. Stop clears the gate
//! and joins the threads with a bounded grace so a stuck CoreAudio teardown
//! can't hang the stop command itself.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use crate::audio::AudioSource;
use crate::transcription::bridge::SttBridge;
use crate::transcription::common::{LevelMeter, LEVEL_EVENT, TRANSCRIPTION_STATE_EVENT};
use crate::transcription::reconnect::ReconnectPolicy;
use crate::transcription::{self, SttProvider, TranscribeConfig};

/// Grace given to capture threads to release their device on stop. Threads
/// self-exit within ~100 ms of the gate clearing; anything slower is treated
/// as wedged and detached (harmless — it holds this session's now-dead gate).
const STOP_GRACE: Duration = Duration::from_millis(1500);

/// The pipelines that can own the microphone. Declaration order is priority
/// order (via `PartialOrd`): a later variant preempts an earlier one's capture,
/// an earlier variant's start yields to a later owner.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum MicUser {
    /// Settings mic-level preview. Yields to everything.
    MicTest,
    /// Push-to-talk dictation. Preempts the mic test; yields to a meeting.
    VoiceTyping,
    /// A live meeting. Preempts the mic test and dictation.
    Meeting,
}

/// One running capture: the per-session gate plus the capture threads
/// watching it.
struct CaptureSession {
    gate: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
}

impl CaptureSession {
    /// Clear the gate and join every capture thread, bounded by [`STOP_GRACE`].
    /// Joining lets each thread release its device (dropping its PCM sender,
    /// which ends the STT session via channel close). A thread that overstays
    /// is detached rather than hanging the caller.
    fn stop(&mut self) {
        self.gate.store(false, Ordering::SeqCst);
        let deadline = Instant::now() + STOP_GRACE;
        for h in self.threads.drain(..) {
            while !h.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            if h.is_finished() {
                let _ = h.join();
            } else {
                log::warn!("mic: capture thread didn't exit within grace; detaching");
            }
        }
    }
}

struct Active {
    user: MicUser,
    session: CaptureSession,
}

/// Managed-state arbiter guaranteeing at most one live capture session.
#[derive(Default)]
pub struct MicCoordinator(Mutex<Option<Active>>);

/// Outcome of [`MicCoordinator::begin`].
pub enum Begin {
    /// The mic is claimed; hand this gate to every capture thread of the new
    /// session (via [`spawn_capture`]).
    Started(Arc<AtomicBool>),
    /// `user` already owns the mic — treat the start as an idempotent no-op.
    AlreadyActive,
    /// A higher-priority pipeline owns the mic; the start must not open a
    /// competing stream.
    Busy(MicUser),
}

impl MicCoordinator {
    /// Claim the mic for `user` and arm a fresh per-session gate. A
    /// lower-priority owner is stopped first (gate cleared + threads joined) so
    /// its device is released before the new session opens it.
    pub fn begin(&self, user: MicUser) -> Begin {
        let mut active = self.0.lock().unwrap();
        match active.as_mut() {
            Some(a) if a.user == user => return Begin::AlreadyActive,
            Some(a) if a.user > user => return Begin::Busy(a.user),
            Some(a) => {
                log::info!("mic: {:?} preempts {:?}", user, a.user);
                a.session.stop();
            }
            None => {}
        }
        let gate = Arc::new(AtomicBool::new(true));
        *active = Some(Active {
            user,
            session: CaptureSession {
                gate: gate.clone(),
                threads: Vec::new(),
            },
        });
        Begin::Started(gate)
    }

    /// Register a capture thread with `user`'s active session. If `user` lost
    /// the mic between starting the thread and registering it, the thread is
    /// detached — its gate is already cleared, so it exits on its own.
    fn add_thread(&self, user: MicUser, handle: JoinHandle<()>) {
        let mut active = self.0.lock().unwrap();
        match active.as_mut() {
            Some(a) if a.user == user => a.session.threads.push(handle),
            _ => log::warn!("mic: {user:?} lost the mic before its capture registered; detaching"),
        }
    }

    /// Stop `user`'s session (clear its gate, join its threads with a bounded
    /// grace) and free the mic. No-op when `user` doesn't own the mic, so a
    /// preempted session's late stop can't clobber the new owner.
    pub fn stop(&self, user: MicUser) {
        let mut active = self.0.lock().unwrap();
        if matches!(active.as_ref(), Some(a) if a.user == user) {
            if let Some(mut a) = active.take() {
                a.session.stop();
            }
        }
    }

    /// Stop `user`'s session only while it is still the capture `gate` armed
    /// (the gate [`Begin::Started`] handed out). A late stop — a release's tail
    /// cut, a watchdog — can therefore never kill a NEWER capture of the same
    /// user that started in the meantime, which a check-then-[`stop`](Self::stop)
    /// by user could. Returns whether it stopped anything.
    pub fn stop_if(&self, user: MicUser, gate: &Arc<AtomicBool>) -> bool {
        let mut active = self.0.lock().unwrap();
        if !matches!(active.as_ref(), Some(a) if a.user == user && Arc::ptr_eq(&a.session.gate, gate))
        {
            return false;
        }
        if let Some(mut a) = active.take() {
            a.session.stop();
        }
        true
    }

    /// Who currently owns the mic (`None` when idle).
    pub fn owner(&self) -> Option<MicUser> {
        self.0.lock().unwrap().as_ref().map(|a| a.user)
    }
}

/// Live tee of the meeting's raw microphone PCM, so voice typing can dictate
/// DURING a meeting. The meeting owns the one CoreAudio input stream (see
/// [`MicCoordinator`] — a second concurrent stream could kill its capture), so
/// dictation can't open its own; instead the meeting's mic pipeline
/// (`spawn_mic_prosody_tap`) forwards a clone of every chunk to the subscriber
/// registered here, and the dictation session reads that.
#[derive(Clone, Default)]
pub struct MicTap(Arc<Mutex<MicTapInner>>);

#[derive(Default)]
struct MicTapInner {
    /// The live dictation session's input. Dropped when a send fails (the
    /// session ended) or the last source ends, which closes the session's
    /// channel — the graceful STT-flush path.
    subscriber: Option<UnboundedSender<Vec<i16>>>,
    /// Live meeting mic pipelines currently forwarding (0 or 1 in practice).
    sources: u32,
}

impl MicTap {
    /// A meeting mic pipeline came up and will forward chunks.
    pub fn source_started(&self) {
        self.0.lock().unwrap().sources += 1;
    }

    /// A meeting mic pipeline ended. When it was the last one, drop the
    /// subscriber so a tapped dictation's input closes now (flushing its final
    /// tokens) instead of parking silently on a channel nobody feeds.
    pub fn source_ended(&self) {
        let mut inner = self.0.lock().unwrap();
        inner.sources = inner.sources.saturating_sub(1);
        if inner.sources == 0 {
            inner.subscriber = None;
        }
    }

    /// Register the dictation session's sender: a clone of every meeting mic
    /// chunk goes to it from now on. Replaces any previous subscriber (whose
    /// channel thereby closes — a superseded session must stop receiving).
    /// Errors when no meeting mic pipeline is live to feed it (the meeting
    /// claimed the mic but its capture failed to start).
    pub fn subscribe(&self, tx: UnboundedSender<Vec<i16>>) -> Result<(), String> {
        let mut inner = self.0.lock().unwrap();
        if inner.sources == 0 {
            return Err("the meeting's microphone is not capturing".into());
        }
        inner.subscriber = Some(tx);
        Ok(())
    }

    /// Forward one meeting mic chunk to the subscriber, if any. A failed send
    /// means the dictation session is gone — unregister it.
    pub fn forward(&self, chunk: &[i16]) {
        let mut inner = self.0.lock().unwrap();
        if let Some(sub) = inner.subscriber.as_ref() {
            if sub.send(chunk.to_vec()).is_err() {
                inner.subscriber = None;
            }
        }
    }
}

/// Start one capture backend on its own thread, registering the thread with
/// `user`'s active session so stop/preemption joins it. Returns the PCM
/// receiver, or the error message if the device failed to start.
pub fn spawn_capture<S: AudioSource>(
    coord: &MicCoordinator,
    user: MicUser,
    source: S,
    gate: Arc<AtomicBool>,
    label: &'static str,
) -> Result<UnboundedReceiver<Vec<i16>>, String> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
    match source.start(tx, gate) {
        Ok(handle) => {
            coord.add_thread(user, handle);
            Ok(rx)
        }
        Err(e) => {
            log::error!("[{label}] capture failed to start: {e}");
            Err(e.to_string())
        }
    }
}

/// Accumulates the live meeting's recorded PCM (16 kHz mono i16) so it can be
/// encoded to Ogg/Opus on stop and saved into the local history. `None` between
/// meetings; armed (`Some(empty)`) by `start_meeting` and drained by
/// `stop_meeting`.
pub type RecorderBuf = Arc<Mutex<Option<Vec<i16>>>>;

/// Where the meter hands each chunk after teeing it into the recording.
trait ChunkSink {
    /// Pass one chunk on. `false` means downstream is gone for good and the
    /// meter should stop.
    fn deliver(&mut self, chunk: Vec<i16>) -> bool;
    /// The meter is done: no more chunks will come.
    fn finish(&mut self) {}
}

/// Single-shot sessions (voice typing): the adapter's own input. When the
/// adapter is gone there is nothing left to feed, so the meter stops — and
/// for dictation that is exactly right, the session is over.
impl ChunkSink for UnboundedSender<Vec<i16>> {
    fn deliver(&mut self, chunk: Vec<i16>) -> bool {
        self.send(chunk).is_ok()
    }
}

/// Reconnecting sessions (meetings): the bridge never refuses a chunk — with
/// no leg attached it holds it for the next one — so the meter keeps draining
/// the capture, and keeps recording, until the capture itself ends. Finishing
/// closes the bridge, which drains the current leg's input (the provider's
/// final flush) and wakes a reconnect loop sleeping on its backoff.
struct BridgeSink {
    bridge: Arc<SttBridge>,
    /// The session's `audio://level`, metered here — on every chunk, as it is
    /// captured — instead of in the adapters, whose meters `run_legs` mutes
    /// (`TranscribeConfig::level_events`). An adapter only sees audio once a
    /// leg is reading: between legs and through a handshake the titlebar
    /// meter would go flat, reading as a dead microphone at exactly the moment
    /// the recording is fine and only the network is not, and after a
    /// reconnect it would replay the whole hold buffer as a burst. This is the
    /// live mic level, which is what the titlebar means. `None` in tests (a
    /// `LevelMeter` needs an `AppHandle`).
    level: Option<LevelMeter>,
}

impl ChunkSink for BridgeSink {
    fn deliver(&mut self, chunk: Vec<i16>) -> bool {
        if let Some(level) = self.level.as_mut() {
            level.push(&chunk);
        }
        self.bridge.send(chunk);
        true
    }

    fn finish(&mut self) {
        self.bridge.close();
    }
}

/// The sample counter interposed between capture and the STT adapter: forwards
/// every chunk untouched, tees into the recording buffer, and counts the
/// samples it forwards into `streamed` as it goes — live, so the session's
/// [`UsageReport`] can bill what was streamed even when the session task is
/// aborted before this returns. Returns the total once the input closes. See
/// [`run_metered_session`] for what `recorder` / `cutoff` / `paused` mean;
/// split out as a free async fn so the cutoff policy below is testable without
/// an `AppHandle`.
///
/// How long it runs is the sink's call: a single-shot sink stops it when the
/// adapter is gone, while a meeting's bridge never does — the meter (and the
/// recording tee) then runs until `rx` closes, i.e. until `stop_meeting`
/// clears the capture gate. Transcription dying must never stop the capture
/// behind it (pathorsAI/parley#570).
async fn meter_chunks<S: ChunkSink>(
    mut rx: UnboundedReceiver<Vec<i16>>,
    mut sink: S,
    recorder: Option<RecorderBuf>,
    cutoff: Option<Arc<AtomicBool>>,
    paused: Option<Arc<AtomicBool>>,
    streamed: Arc<AtomicU64>,
) -> u64 {
    // Chunks still queued when the cutoff fired. `None` until then; `Some(n)`
    // means "forward n more, they predate the release", and `Some(0)` ends it.
    let mut backlog: Option<usize> = None;
    while let Some(chunk) = rx.recv().await {
        // Voice-typing release: stop forwarding (and billing) audio captured
        // after the key is let go. But the cutoff flips while chunks recorded
        // BEFORE it are still sitting in this channel, and dropping those
        // truncated the last words of a dictation — worst exactly when the
        // runtime was busy enough for a backlog to build. So snapshot the queue
        // depth the instant the cutoff is observed and forward that much more:
        // everything already queued is pre-release speech, everything arriving
        // afterwards is not. Draining to empty instead would race the mic
        // thread, which keeps capturing until it sees the cleared gate (~100 ms
        // later) — that is the audio we do want to drop.
        if backlog.is_none() && cutoff.as_ref().is_some_and(|c| c.load(Ordering::SeqCst)) {
            backlog = Some(rx.len());
        }
        if paused.as_ref().is_some_and(|p| p.load(Ordering::SeqCst)) {
            continue;
        }
        streamed.fetch_add(chunk.len() as u64, Ordering::SeqCst);
        // Tee into the recording buffer (kept while the meeting is armed).
        if let Some(rec) = &recorder {
            if let Some(buf) = rec.lock().unwrap().as_mut() {
                buf.extend_from_slice(&chunk);
            }
        }
        if !sink.deliver(chunk) {
            break;
        }
        // Past the cutoff this chunk was one of the queued ones. Leaving the
        // loop finishes (and drops) the sink, which closes the STT input,
        // triggering its final flush of only the pre-release speech.
        match backlog {
            Some(0) => break,
            Some(n) => backlog = Some(n - 1),
            None => {}
        }
    }
    sink.finish();
    streamed.load(Ordering::SeqCst)
}

/// Sends a session's `usage://stt` exactly once, however the session ends:
/// from [`UsageReport::send`] on the normal path, or from `Drop` when the
/// session task is aborted first. Both abort backstops (`stop_voice_typing`'s
/// FLUSH_ABORT_GRACE, `teardown_meeting`'s) count from the cut, while a
/// session's own DRAIN_READ_GRACE counts from the drain, which cannot come
/// before its socket has connected: a meeting stream over a slow connect that
/// never answers the finalize, or any session stuck past its own bounds, is
/// aborted before it ends itself, and used to take its usage line with it.
/// `stt://closed` stays off the abort path on purpose (see
/// [`run_metered_session`]).
///
/// `samples` reads the billable total at report time: the meter's live count
/// for a single-shot session, the bridge's delivered count for a meeting.
struct UsageReport<S: Fn() -> u64, F: FnOnce(u64)> {
    samples: S,
    report: Option<F>,
}

impl<S: Fn() -> u64, F: FnOnce(u64)> UsageReport<S, F> {
    fn new(samples: S, report: F) -> Self {
        Self {
            samples,
            report: Some(report),
        }
    }

    /// Report the samples streamed so far; a no-op after the first call.
    fn send(&mut self) {
        if let Some(report) = self.report.take() {
            report((self.samples)());
        }
    }
}

impl<S: Fn() -> u64, F: FnOnce(u64)> Drop for UsageReport<S, F> {
    fn drop(&mut self) {
        self.send();
    }
}

/// Run a transcription session over `rx`, counting the audio streamed so the
/// frontend can bill it. Emits a `usage://stt` event when the session ends.
/// When `recorder` is `Some`, every chunk is also appended to it so the meeting
/// can be saved to history (only the designated session passes a recorder).
/// `error_event` is the event a failed session raises, payload
/// `{ source, code, message }`: meetings pass `meeting://error` (the meeting UI
/// tears down on it), voice typing passes `voicetyping://error` (the host
/// forwards it to the overlay's error state).
///
/// `reconnect`: meetings pass `true`. The meter then feeds an [`SttBridge`]
/// instead of the adapter directly, so the capture and the recording keep
/// running no matter what happens to transcription, and the session runs as
/// a chain of legs (see `run_legs`): a connection failure ("connect") no
/// longer raises `error_event` at all — the session holds the audio, emits
/// `meeting://transcription` `{ source, state: "reconnecting", attempt }`,
/// backs off along [`ReconnectPolicy::MEETING`] and redials, and the new leg
/// announces `{ source, state: "live", leg }` once its handshake completes.
/// Only a failure a redial cannot fix (`quota` / `auth` / `key`) still raises
/// `error_event`, and it ends transcription without ending the recording.
/// Voice typing passes `false` and keeps the single-shot behaviour: one
/// session, and any failure raises `error_event`.
///
/// `error_mute`: session tasks outlive `stop_meeting` by up to the flush/abort
/// grace, and the meeting UI tears down on `meeting://error` unconditionally —
/// so a failure inside that window (it belongs to a meeting the user already
/// ended) would kill the NEXT meeting the user just started, or toast a
/// spurious failure for one that completed fine. `stop_meeting` sets the flag
/// when it releases its tasks; a muted failure is logged only (and a muted
/// reconnecting session stops redialling). Voice typing passes `None` — its
/// stale-error guards are abort-on-restart plus the host-side busy/generation
/// checks.
///
/// `cutoff`: voice typing sets this on release (see `stop_voice_typing`) to HARD
/// CUT the audio `RELEASE_TAIL` after the key is let go (at once on the cap) —
/// the counter stops forwarding (and billing) new chunks and drops its sender,
/// closing the STT input NOW so only what was said up to the release, plus the
/// short tail that lets the recognizer close the last word, is transcribed and
/// flushed. Meetings pass `None` (they stop by dropping the mic sender via the
/// gate).
///
/// `paused`: the meeting's pause switch (see `set_meeting_paused`). While set,
/// chunks are DROPPED here — not counted (billed), not recorded, not forwarded
/// to the STT adapter. The socket survives on the adapters' audio-independent
/// keepalives, and since providers timestamp by received-audio time, the
/// transcript timeline stays aligned with the pause-compacted recording.
/// Voice typing passes `None`.
///
/// `session`: the voice-typing session id, stamped on every event the task
/// emits (see `transcription::common::SESSION`). Meetings pass `None`.
///
/// Either way the task ends with `usage://stt` (the audio actually handed to
/// the provider — for a reconnecting session, every leg's share, excluding
/// held audio that overflowed or was never delivered) and `stt://closed`.
#[allow(clippy::too_many_arguments)]
pub fn run_metered_session(
    app: &AppHandle,
    provider: SttProvider,
    config: TranscribeConfig,
    label: &'static str,
    rx: UnboundedReceiver<Vec<i16>>,
    recorder: Option<RecorderBuf>,
    error_event: &'static str,
    error_mute: Option<Arc<AtomicBool>>,
    cutoff: Option<Arc<AtomicBool>>,
    paused: Option<Arc<AtomicBool>>,
    session: Option<u64>,
    reconnect: bool,
) -> tauri::async_runtime::JoinHandle<()> {
    let app = app.clone();
    tauri::async_runtime::spawn(transcription::common::SESSION.scope(session, async move {
        let failure = Failure {
            app: &app,
            label,
            error_event,
            error_mute: error_mute.as_ref(),
            session,
            // Hosted mode and BYOK fail for different reasons and need
            // different guidance, so classify against the mode (captured
            // before `config` is moved into the session).
            hosted: config.relay_endpoint.is_some(),
        };
        // Bills the audio duration actually streamed — also when this task is
        // aborted (the report goes out as it is dropped; see UsageReport).
        let emit_usage = {
            let app = app.clone();
            move |samples: u64| {
                let seconds = samples as f64 / crate::audio::TARGET_SAMPLE_RATE as f64;
                let _ = app.emit(
                    "usage://stt",
                    serde_json::json!({
                        "provider": provider.id(),
                        "source": label,
                        "seconds": seconds,
                    }),
                );
            }
        };
        let streamed = Arc::new(AtomicU64::new(0));
        if reconnect {
            // The meter feeds the bridge; the legs come and go behind it. Bill
            // what the bridge actually handed to a leg.
            let bridge = Arc::new(SttBridge::default());
            let mut usage = UsageReport::new(
                {
                    let bridge = bridge.clone();
                    move || bridge.delivered_samples()
                },
                emit_usage,
            );
            let sink = BridgeSink {
                bridge: bridge.clone(),
                level: Some(LevelMeter::new(app.clone(), label, LEVEL_EVENT)),
            };
            let counter = tauri::async_runtime::spawn(meter_chunks(
                rx, sink, recorder, cutoff, paused, streamed,
            ));
            run_legs(&app, provider, config, label, &bridge, &failure).await;
            // The count is final once the meter has returned.
            let _ = counter.await;
            usage.send();
        } else {
            // Interpose a sample counter between capture and the STT adapter:
            // it forwards every chunk untouched and counts it as it goes.
            let mut usage = UsageReport::new(
                {
                    let streamed = streamed.clone();
                    move || streamed.load(Ordering::SeqCst)
                },
                emit_usage,
            );
            let (count_tx, count_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
            let counter = tauri::async_runtime::spawn(meter_chunks(
                rx, count_tx, recorder, cutoff, paused, streamed,
            ));
            if let Err(e) =
                transcription::run_session(provider, app.clone(), config, label, count_rx).await
            {
                let msg = e.to_string();
                log::warn!("[stt:{label}] session ended: {msg}");
                failure.report(failure.classify(&msg), &msg);
            }
            // The count is final once the meter has returned.
            let _ = counter.await;
            usage.send();
        }

        // The session is over and every token it will ever produce has been
        // emitted: the provider answered the closing finalize (Soniox's
        // `<fin>`), closed the socket, or failed — or, after a normal stop,
        // DRAIN_READ_GRACE ran out on a provider that did neither. The
        // voice-typing host delivers on this signal; meetings have their own
        // teardown and ignore it. Deliberately NOT reached when the task is
        // aborted (a superseded session must never finalize its successor's
        // overlay), so the host still caps its own wait — unlike the usage
        // report above, which `usage` still sends as the task is dropped.
        let _ = app.emit(
            "stt://closed",
            serde_json::json!({ "source": label, "session": session }),
        );
    }))
}

/// How a session surfaces a failure: its classification and the
/// `error_event` (subject to `error_mute`). Shared by the single-shot and
/// reconnecting paths so the codes the frontend branches on are decided in
/// one place.
struct Failure<'a> {
    app: &'a AppHandle,
    label: &'static str,
    error_event: &'static str,
    error_mute: Option<&'a Arc<AtomicBool>>,
    session: Option<u64>,
    hosted: bool,
}

impl Failure<'_> {
    /// Classify so the frontend can show an actionable message. Hosted mode
    /// routinely hits 402 (out of credits) / 401 (expired cloud session) — the
    /// fix is billing or re-login. BYOK instead fails on a rejected vendor key
    /// (401/403/"unauthorized"), where telling the user to "sign in" is wrong —
    /// the fix is the key in Settings. Everything else is "connect": the
    /// network or the provider, which a meeting retries.
    fn classify(&self, msg: &str) -> &'static str {
        let low = msg.to_lowercase();
        let bad_key = msg.contains("401")
            || msg.contains("403")
            || low.contains("unauthorized")
            || low.contains("api key");
        if self.hosted && msg.contains("402") {
            "quota"
        } else if self.hosted && msg.contains("401") {
            "auth"
        } else if !self.hosted && bad_key {
            "key"
        } else {
            "connect"
        }
    }

    fn muted(&self) -> bool {
        self.error_mute.is_some_and(|m| m.load(Ordering::SeqCst))
    }

    /// Surface the failure to the UI instead of silently leaving the meeting
    /// with no transcript (or the dictation overlay listening to nothing) —
    /// unless the owning meeting was already stopped: then the failure has no
    /// actionable surface, and the teardown it triggers would hit whatever
    /// meeting is CURRENTLY running instead.
    fn report(&self, code: &'static str, msg: &str) {
        let label = self.label;
        if self.muted() {
            log::info!(
                "[stt:{label}] failure after stop — suppressing {}",
                self.error_event
            );
            return;
        }
        let _ = self.app.emit(
            self.error_event,
            serde_json::json!({
                "source": label,
                "code": code,
                "message": msg,
                "session": self.session,
            }),
        );
    }
}

/// A meeting's transcription as a chain of legs behind `bridge`, redialling
/// after every connection failure until the capture ends. Returns once the
/// session is over for good: a leg drained normally (the meeting stopped), a
/// failure a redial cannot fix was reported, or the capture ended while the
/// session was between legs.
///
/// Mirrors the iOS `MeetingRecorder` reconnect path (`scheduleReconnect` /
/// `performReconnect`), minus its attempt ceiling — see [`ReconnectPolicy`].
async fn run_legs(
    app: &AppHandle,
    provider: SttProvider,
    config: TranscribeConfig,
    label: &'static str,
    bridge: &Arc<SttBridge>,
    failure: &Failure<'_>,
) {
    let policy = ReconnectPolicy::MEETING;
    let mut leg: u32 = 0;
    let mut attempt: u32 = 0;
    loop {
        // The bridge decides the offset, because the bridge is what knows
        // where in the recording the audio it holds was actually spoken. `None`
        // = the capture ended while we were between legs: nothing to redial for.
        let Some(attached) = bridge.attach() else {
            log::info!("[stt:{label}] capture ended before leg {leg} could start");
            return;
        };
        let leg_config = TranscribeConfig {
            leg,
            time_offset_ms: attached.time_offset_ms,
            // The bridge meters the level (see `BridgeSink`).
            level_events: false,
            ..config.clone()
        };
        if leg > 0 {
            log::info!(
                "[stt:{label}] leg {leg} dialling, offset {} ms",
                attached.time_offset_ms
            );
        }
        let started = std::time::Instant::now();
        // Scoped so the adapter's `note_connected` can confirm this leg to the
        // bridge — until then the bridge keeps copies of what it feeds it.
        let result = transcription::common::BRIDGE
            .scope(
                Some(bridge.clone()),
                transcription::run_session(provider, app.clone(), leg_config, label, attached.rx),
            )
            .await;
        let Err(e) = result else {
            // The leg drained its input: the bridge closed it because the
            // capture ended. A normal stop, final tokens flushed.
            return;
        };
        let lived = started.elapsed();
        let msg = e.to_string();
        let code = failure.classify(&msg);
        if code != "connect" {
            // Quota, an expired session, a rejected key: the next handshake
            // would be refused the same way. Say so once and stop holding
            // audio nobody will read — the recording carries on regardless.
            log::warn!("[stt:{label}] leg {leg} ended ({code}), not redialling: {msg}");
            bridge.discard();
            failure.report(code, &msg);
            return;
        }
        if bridge.is_closed() || failure.muted() {
            // The meeting is stopping, and this is just its socket going down
            // with it (or dying inside the flush grace). Nothing to redial for.
            log::info!("[stt:{label}] leg {leg} ended after stop: {msg}");
            return;
        }

        // Keep the words spoken from here on for the next leg.
        bridge.hold();
        attempt = policy.next_attempt(attempt, lived);
        let delay = policy.delay(attempt);
        log::warn!(
            "[stt:{label}] leg {leg} dropped after {:.1}s: {msg} — redial #{attempt} in {}s",
            lived.as_secs_f64(),
            delay.as_secs()
        );
        let _ = app.emit(
            TRANSCRIPTION_STATE_EVENT,
            serde_json::json!({ "source": label, "state": "reconnecting", "attempt": attempt }),
        );
        // Stopping the meeting must not wait out a backoff.
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = bridge.closed() => {
                log::info!("[stt:{label}] capture ended during reconnect backoff");
                return;
            }
        }
        leg += 1;
    }
}

#[cfg(test)]
mod mic_tap_tests {
    use super::MicTap;

    #[test]
    fn subscribe_requires_a_live_source() {
        let tap = MicTap::default();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        assert!(tap.subscribe(tx).is_err());
    }

    #[test]
    fn forwards_chunks_to_the_subscriber() {
        let tap = MicTap::default();
        tap.source_started();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        tap.subscribe(tx).unwrap();
        tap.forward(&[1, 2, 3]);
        assert_eq!(rx.try_recv().unwrap(), vec![1, 2, 3]);
    }

    #[test]
    fn dropped_receiver_unregisters_on_next_forward() {
        let tap = MicTap::default();
        tap.source_started();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
        tap.subscribe(tx).unwrap();
        drop(rx);
        tap.forward(&[1]); // failed send clears the slot
        assert!(tap.0.lock().unwrap().subscriber.is_none());
    }

    #[test]
    fn last_source_ending_closes_the_subscriber() {
        let tap = MicTap::default();
        tap.source_started();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
        tap.subscribe(tx).unwrap();
        tap.source_ended();
        // The sender was dropped, so the dictation session's input is closed.
        assert!(matches!(
            rx.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected)
        ));
    }

    #[test]
    fn resubscribing_closes_the_previous_subscriber() {
        let tap = MicTap::default();
        tap.source_started();
        let (tx1, mut rx1) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
        let (tx2, mut rx2) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
        tap.subscribe(tx1).unwrap();
        tap.subscribe(tx2).unwrap();
        tap.forward(&[7]);
        assert!(matches!(
            rx1.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected)
        ));
        assert_eq!(rx2.try_recv().unwrap(), vec![7]);
    }
}

#[cfg(test)]
mod coordinator_tests {
    use super::{Begin, MicCoordinator, MicUser};
    use std::sync::atomic::Ordering;

    fn started(coord: &MicCoordinator) -> std::sync::Arc<std::sync::atomic::AtomicBool> {
        match coord.begin(MicUser::VoiceTyping) {
            Begin::Started(gate) => gate,
            _ => panic!("expected a fresh capture"),
        }
    }

    /// A release's late cut must not kill the capture a quick re-press opened.
    #[test]
    fn stop_if_leaves_a_newer_capture_of_the_same_user_alone() {
        let coord = MicCoordinator::default();
        let old = started(&coord);
        coord.stop(MicUser::VoiceTyping); // the re-press's start
        let new = started(&coord);

        assert!(!coord.stop_if(MicUser::VoiceTyping, &old));
        assert_eq!(coord.owner(), Some(MicUser::VoiceTyping));
        assert!(new.load(Ordering::SeqCst));

        assert!(coord.stop_if(MicUser::VoiceTyping, &new));
        assert_eq!(coord.owner(), None);
        assert!(!new.load(Ordering::SeqCst));
    }

    #[test]
    fn stop_if_leaves_another_user_alone() {
        let coord = MicCoordinator::default();
        let gate = started(&coord);
        assert!(!coord.stop_if(MicUser::Meeting, &gate));
        assert_eq!(coord.owner(), Some(MicUser::VoiceTyping));
    }
}

#[cfg(test)]
mod meter_tests {
    use super::{meter_chunks, BridgeSink, RecorderBuf, UsageReport};
    use crate::transcription::bridge::SttBridge;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    /// Feed `chunks` (one i16 each, so a chunk's value identifies it), with the
    /// cutoff already armed as `cutoff` says, and collect what reaches the STT
    /// adapter. Everything is queued BEFORE the meter runs, which is the case
    /// this cares about: a backlog that built up while the task was starved.
    async fn run(chunks: &[i16], cutoff: Option<Arc<AtomicBool>>) -> (Vec<i16>, u64) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
        let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
        for c in chunks {
            tx.send(vec![*c]).unwrap();
        }
        drop(tx); // capture ended: the meter runs to the end of the queue
        let samples = meter_chunks(rx, out_tx, None, cutoff, None, Arc::default()).await;
        let mut got = Vec::new();
        while let Ok(chunk) = out_rx.try_recv() {
            got.push(chunk[0]);
        }
        (got, samples)
    }

    #[tokio::test]
    async fn forwards_and_counts_everything_without_a_cutoff() {
        let (got, samples) = run(&[1, 2, 3], None).await;
        assert_eq!(got, vec![1, 2, 3]);
        assert_eq!(samples, 3);
    }

    #[tokio::test]
    async fn a_cutoff_still_delivers_audio_captured_before_the_release() {
        // The regression: releasing the key used to drop the whole queue, so a
        // dictation lost its last words whenever chunks had piled up.
        let cutoff = Arc::new(AtomicBool::new(true));
        let (got, samples) = run(&[1, 2, 3, 4], Some(cutoff)).await;
        assert_eq!(got, vec![1, 2, 3, 4]);
        assert_eq!(samples, 4);
    }

    /// The cut still ENDS the stream: the meter stops at the pre-release
    /// backlog instead of following a mic that keeps capturing for the few ms
    /// before it notices the cleared gate. Proven by leaving the capture side
    /// open — a meter that didn't stop would park on `recv` forever — and by
    /// sending more audio once it has returned.
    #[tokio::test]
    async fn a_cutoff_ends_the_stream_at_the_pre_release_backlog() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
        let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
        tx.send(vec![1]).unwrap();
        tx.send(vec![2]).unwrap();
        let cutoff = Arc::new(AtomicBool::new(true)); // key released, 2 chunks queued
        let samples = meter_chunks(rx, out_tx, None, Some(cutoff), None, Arc::default()).await;
        // It returned rather than parking on a still-open capture side, and the
        // input is closed — post-release audio the mic emits while its thread
        // winds down has nowhere to go.
        assert!(tx.send(vec![8]).is_err());
        let mut got = Vec::new();
        while let Ok(chunk) = out_rx.try_recv() {
            got.push(chunk[0]);
        }
        assert_eq!(got, vec![1, 2]);
        assert_eq!(samples, 2);
    }

    /// The core of pathorsAI/parley#570: transcription dying must not stop the
    /// meter, or the capture behind it (and the recording) stops too. With a
    /// meeting's bridge as the sink, the meter keeps draining and recording
    /// after the leg's receiver is gone, and the audio waits for the next leg.
    #[tokio::test]
    async fn a_meeting_keeps_recording_after_its_transcription_leg_dies() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
        let recorder: RecorderBuf = Arc::new(Mutex::new(Some(Vec::new())));
        let bridge = Arc::new(SttBridge::default());
        let leg = bridge.attach().unwrap();
        drop(leg); // the provider socket died; its input is gone
        for c in [1, 2, 3] {
            tx.send(vec![c]).unwrap();
        }
        let sink = BridgeSink {
            bridge: bridge.clone(),
            level: None,
        };
        let meter = tokio::spawn(meter_chunks(
            rx,
            sink,
            Some(recorder.clone()),
            None,
            None,
            Arc::default(),
        ));
        // Still running: the capture side is open, so the meter is parked on
        // it rather than having given up with the leg.
        tokio::task::yield_now().await;
        assert!(!meter.is_finished());
        tx.send(vec![4]).unwrap();
        // The next leg gets everything since the old one died, in order.
        let mut next = bridge.attach().unwrap();
        tokio::task::yield_now().await;
        tx.send(vec![5]).unwrap();
        drop(tx); // stop_meeting cleared the gate
        let samples = meter.await.unwrap();
        assert_eq!(samples, 5);
        assert_eq!(
            recorder.lock().unwrap().as_ref().unwrap(),
            &vec![1, 2, 3, 4, 5]
        );
        let mut got = Vec::new();
        while let Some(chunk) = next.rx.recv().await {
            got.push(chunk[0]);
        }
        // The capture ending closed the bridge, which ended the leg's input.
        assert_eq!(got, vec![1, 2, 3, 4, 5]);
        assert!(bridge.is_closed());
    }

    #[tokio::test]
    async fn a_paused_meeting_drops_chunks_without_ending_the_session() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
        let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
        let paused = Arc::new(AtomicBool::new(true));
        tx.send(vec![1]).unwrap();
        tx.send(vec![2]).unwrap();
        drop(tx);
        let samples = meter_chunks(rx, out_tx, None, None, Some(paused), Arc::default()).await;
        assert!(out_rx.try_recv().is_err());
        assert_eq!(samples, 0);
    }

    #[test]
    fn the_usage_report_goes_out_once() {
        let reported = Arc::new(Mutex::new(Vec::new()));
        let sink = reported.clone();
        let mut usage = UsageReport::new(|| 480, move |n| sink.lock().unwrap().push(n));
        usage.send();
        usage.send();
        drop(usage);
        assert_eq!(*reported.lock().unwrap(), vec![480]);
    }

    /// The regression: an abort backstop can fire before the session ends
    /// itself (a slow relay connect pushes its drain grace past the abort),
    /// and the aborted task used to take its usage line with it. What the
    /// meter streamed is still reported, once, as the task drops.
    #[tokio::test]
    async fn an_aborted_session_still_reports_what_it_streamed() {
        let streamed = Arc::new(AtomicU64::new(0));
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
        let (out_tx, _out_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
        tx.send(vec![0; 160]).unwrap();
        tx.send(vec![0; 160]).unwrap();
        drop(tx);
        meter_chunks(rx, out_tx, None, None, None, streamed.clone()).await;

        let reported = Arc::new(Mutex::new(Vec::new()));
        let sink = reported.clone();
        let mut usage = UsageReport::new(
            move || streamed.load(Ordering::SeqCst),
            move |n| sink.lock().unwrap().push(n),
        );
        let session = tokio::spawn(async move {
            // A read half that never answers the finalize.
            std::future::pending::<()>().await;
            usage.send();
        });
        tokio::task::yield_now().await;
        session.abort();
        assert!(session.await.unwrap_err().is_cancelled());
        assert_eq!(*reported.lock().unwrap(), vec![320]);
    }
}
