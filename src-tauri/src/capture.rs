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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use crate::audio::AudioSource;
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
    /// Live voice translation (mic → Gemini translate → output device). Its own
    /// exclusive full-mic use; preempts everything else.
    Translate,
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

/// Run a transcription session over `rx`, counting the audio streamed so the
/// frontend can bill it. Emits a `usage://stt` event when the session ends.
/// When `recorder` is `Some`, every chunk is also appended to it so the meeting
/// can be saved to history (only the designated session passes a recorder).
/// `error_event` is the event a failed session raises, payload
/// `{ source, code, message }`: meetings pass `meeting://error` (the meeting UI
/// tears down on it), voice typing passes `voicetyping://error` (the host
/// forwards it to the overlay's error state).
///
/// `error_mute`: session tasks outlive `stop_meeting` by up to the flush/abort
/// grace, and the meeting UI tears down on `meeting://error` unconditionally —
/// so a failure inside that window (it belongs to a meeting the user already
/// ended) would kill the NEXT meeting the user just started, or toast a
/// spurious failure for one that completed fine. `stop_meeting` sets the flag
/// when it releases its tasks; a muted failure is logged only. Voice typing
/// passes `None` — its stale-error guards are abort-on-restart plus the
/// host-side busy/generation checks.
///
/// `cutoff`: voice typing sets this on release (see `stop_voice_typing`) to HARD
/// CUT the audio the instant the key is let go — the counter stops forwarding
/// (and billing) new chunks and drops its sender, closing the STT input NOW so
/// only what was said before release is transcribed and flushed. Meetings pass
/// `None` (they stop by dropping the mic sender via the gate).
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
) -> tauri::async_runtime::JoinHandle<()> {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Interpose a sample counter between capture and the STT adapter: it
        // forwards every chunk untouched, then yields the total once the input
        // closes so we can bill the audio duration actually streamed.
        let (count_tx, count_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
        let counter = tauri::async_runtime::spawn(async move {
            let mut rx = rx;
            let mut samples: u64 = 0;
            while let Some(chunk) = rx.recv().await {
                // Voice-typing release: stop the instant the key is let go so no
                // audio captured after release is forwarded (or billed). Dropping
                // `count_tx` by leaving the loop closes the STT input now, which
                // triggers its final flush of only the pre-release speech.
                if cutoff.as_ref().is_some_and(|c| c.load(Ordering::SeqCst)) {
                    break;
                }
                samples += chunk.len() as u64;
                // Tee into the recording buffer (kept while the meeting is armed).
                if let Some(rec) = &recorder {
                    if let Some(buf) = rec.lock().unwrap().as_mut() {
                        buf.extend_from_slice(&chunk);
                    }
                }
                if count_tx.send(chunk).is_err() {
                    break;
                }
            }
            samples
        });

        // Hosted mode and BYOK fail for different reasons and need different
        // guidance, so classify against the mode (captured before `config` is
        // moved into the session).
        let hosted = config.relay_endpoint.is_some();
        if let Err(e) =
            transcription::run_session(provider, app.clone(), config, label, count_rx).await
        {
            let msg = e.to_string();
            log::warn!("[stt:{label}] session ended: {msg}");
            // Surface the failure to the UI instead of silently leaving the
            // meeting in "recording" (or the dictation overlay listening) with
            // no transcript. Classify so the frontend can show an actionable
            // message. Hosted mode routinely hits 402 (out of credits) / 401
            // (expired cloud session) — the fix is billing or re-login. BYOK
            // instead fails on a rejected vendor key (401/403/"unauthorized"),
            // where telling the user to "sign in" is wrong — the fix is the key
            // in Settings.
            let low = msg.to_lowercase();
            let bad_key = msg.contains("401")
                || msg.contains("403")
                || low.contains("unauthorized")
                || low.contains("api key");
            let code = if hosted && msg.contains("402") {
                "quota"
            } else if hosted && msg.contains("401") {
                "auth"
            } else if !hosted && bad_key {
                "key"
            } else {
                "connect"
            };
            if error_mute
                .as_ref()
                .is_some_and(|m| m.load(Ordering::SeqCst))
            {
                // The owning meeting was already stopped: the failure has no
                // actionable surface and the teardown it triggers would hit
                // whatever meeting is CURRENTLY running instead.
                log::info!("[stt:{label}] failure after stop — suppressing {error_event}");
            } else {
                let _ = app.emit(
                    error_event,
                    serde_json::json!({ "source": label, "code": code, "message": msg }),
                );
            }
        }

        let samples = counter.await.unwrap_or(0);
        let seconds = samples as f64 / crate::audio::TARGET_SAMPLE_RATE as f64;
        let _ = app.emit(
            "usage://stt",
            serde_json::json!({
                "provider": provider.id(),
                "source": label,
                "seconds": seconds,
            }),
        );
        // The session is fully over: the socket is closed and every final
        // token has been emitted. The voice-typing host finalizes (pastes) on
        // this signal instead of polling for the transcript to go quiet —
        // meetings have their own teardown and ignore it. Deliberately NOT
        // reached when the task is aborted (a superseded session must never
        // finalize its successor's overlay).
        let _ = app.emit("stt://closed", serde_json::json!({ "source": label }));
    })
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
