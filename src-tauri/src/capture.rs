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
use tokio::sync::mpsc::UnboundedReceiver;

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
    /// A live meeting. Preempts everything.
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

    /// Who currently owns the mic (`None` when idle).
    pub fn owner(&self) -> Option<MicUser> {
        self.0.lock().unwrap().as_ref().map(|a| a.user)
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
pub fn run_metered_session(
    app: &AppHandle,
    provider: SttProvider,
    config: TranscribeConfig,
    label: &'static str,
    rx: UnboundedReceiver<Vec<i16>>,
    recorder: Option<RecorderBuf>,
    error_event: &'static str,
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

        if let Err(e) =
            transcription::run_session(provider, app.clone(), config, label, count_rx).await
        {
            let msg = e.to_string();
            log::warn!("[stt:{label}] session ended: {msg}");
            // Surface the failure to the UI instead of silently leaving the
            // meeting in "recording" (or the dictation overlay listening) with
            // no transcript. Hosted mode hits this routinely (402 out of
            // credits / 401 expired session at connect); BYOK hits it on a bad
            // key. Classify so the frontend can show an actionable message.
            let code = if msg.contains("402") {
                "quota"
            } else if msg.contains("401") {
                "auth"
            } else {
                "connect"
            };
            let _ = app.emit(
                error_event,
                serde_json::json!({ "source": label, "code": code, "message": msg }),
            );
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
    })
}
