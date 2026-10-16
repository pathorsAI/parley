//! The voice-typing session lifecycle: one live session task at a time, its
//! audio cutoff and capture gate, and the timing that bounds its flush.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::capture::{MicCoordinator, MicUser};

/// Grace for the post-release final flush, counted from the cut, before a
/// lingering session task is force-aborted (mirrors `stop_meeting`'s backstop).
/// It must not beat the session's own ending: the drain (the last audio sent,
/// then the finalize) cannot come before the socket has connected, which
/// CONNECT_TIMEOUT bounds from the start — so never later than the cut — and
/// the session then ends itself DRAIN_READ_GRACE after the drain at the
/// latest, `stt://closed` included. A short tap over a slow relay connect
/// (seen at 6.5 s) used to be aborted here, 8 s after the cut, with its
/// finalize still in flight: no `stt://closed`, and nothing pasted. This only
/// catches a task that is stuck past every one of its own bounds.
pub(super) const FLUSH_ABORT_GRACE: Duration = Duration::from_secs(
    crate::transcription::common::CONNECT_TIMEOUT.as_secs()
        + crate::transcription::common::DRAIN_READ_GRACE.as_secs()
        + 1,
);

/// Audio kept after key-up before the hard cut. People let go during the last
/// syllable's decay, and the recognizer needs a little trailing context to
/// close the last word — without it the word was dropped or misheard. Short of
/// a conversational turn gap, so a remark to someone after the release mostly
/// stays out. `Duration::ZERO` restores #128's exact-key-up cut.
pub(super) const RELEASE_TAIL: Duration = Duration::from_millis(250);

/// Extra grace on top of the hosted single-session cap before the backend
/// force-stops the mic. The frontend caps and stops the session at exactly the
/// limit; this watchdog only fires when the webview never did (hung/crashed),
/// so it must not race the normal frontend stop.
pub(super) const CAP_BACKEND_GRACE: Duration = Duration::from_secs(20);

/// The one live voice-typing session task: the next start retires it before
/// opening a new one, and a stop bounds its flush.
#[derive(Default, Clone)]
pub struct VoiceTypingState(Arc<Mutex<VtInner>>);

#[derive(Default)]
struct VtInner {
    session: u64,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    /// The current session's audio cutoff. `stop_voice_typing` sets it
    /// RELEASE_TAIL after key-up to hard cut the stream, so nothing said after
    /// that is transcribed (see `run_metered_session`). Replaced each start.
    cutoff: Option<Arc<AtomicBool>>,
    /// The gate of the capture this session opened (`Begin::Started`), so a
    /// stop can end exactly that capture and never a newer one (see
    /// `MicCoordinator::stop_if`). `None` while the session taps a meeting's
    /// mic: the meeting owns that capture, and the cutoff alone ends the tap.
    mic_gate: Option<Arc<AtomicBool>>,
    /// The host released the current session (`stop_voice_typing`): it is
    /// only finishing its flush now, so the next start lets it (see
    /// [`VoiceTypingState::open_session`]).
    released: bool,
}

/// How long the next start waits for the previous task to finish the poll it
/// was aborted in. A poll is one frame parse or one emit, so this only cuts a
/// task stuck in a bug; its stragglers carry the old session id and are dropped.
const RETIRE_GRACE: Duration = Duration::from_millis(300);

impl VoiceTypingState {
    /// Retire the previous task, then `announce` the next session id and
    /// return it.
    ///
    /// A previous session the host already released is left to finish its
    /// flush: a re-press (or a toggle tap) during the settle used to abort it
    /// here, and the recognizer's answer to the finalize — the end of the
    /// previous dictation — was lost. Its events carry its own session id, so
    /// the new overlay ignores them and the host routes them to the dictation
    /// they belong to; its capture is already cut (or stopped by the caller),
    /// and [`detach_flush`] bounds how long it may run.
    ///
    /// Any other previous task is aborted. tokio's `abort()` lets a poll that
    /// is already running finish, so the task is awaited: anything it emits
    /// precedes the announcement.
    pub(super) async fn open_session(&self, announce: impl FnOnce(u64)) -> u64 {
        let (session, previous, released) = {
            let mut vt = self.0.lock().unwrap();
            vt.session += 1;
            // The handles belong to the session being retired; until `adopt`
            // installs the new one's, a stop must find nothing to cut.
            vt.cutoff = None;
            vt.mic_gate = None;
            let released = std::mem::take(&mut vt.released);
            (vt.session, vt.task.take(), released)
        };
        if let Some(task) = previous {
            if released {
                detach_flush(session - 1, task, FLUSH_ABORT_GRACE);
            } else {
                task.abort();
                if tokio::time::timeout(RETIRE_GRACE, task).await.is_err() {
                    log::warn!(
                        "voice-typing: session {} did not stop within {RETIRE_GRACE:?}",
                        session - 1
                    );
                }
            }
        }
        announce(session);
        session
    }

    /// The host released `session`: from here it only finishes its flush.
    pub(super) fn mark_released(&self, session: u64) {
        let mut vt = self.0.lock().unwrap();
        if vt.session == session {
            vt.released = true;
        }
    }

    /// The current session id.
    fn current(&self) -> u64 {
        self.0.lock().unwrap().session
    }

    pub(super) fn adopt(
        &self,
        session: u64,
        task: tauri::async_runtime::JoinHandle<()>,
        cutoff: Arc<AtomicBool>,
        mic_gate: Option<Arc<AtomicBool>>,
    ) {
        let mut vt = self.0.lock().unwrap();
        if vt.session == session {
            vt.task = Some(task);
            vt.cutoff = Some(cutoff);
            vt.mic_gate = mic_gate;
        } else {
            task.abort();
        }
    }

    /// Whether `session` is current AND still capturing: its release has not
    /// cut it yet. A stopped session stays current until the next start, so
    /// `session == current` alone made the cap watchdog fire (and warn) ~10
    /// minutes after the last dictation of every burst.
    pub(super) fn is_capturing(&self, session: u64) -> bool {
        let vt = self.0.lock().unwrap();
        vt.session == session
            && vt
                .cutoff
                .as_ref()
                .is_some_and(|c| !c.load(Ordering::SeqCst))
    }

    /// The current session's id with its cutoff and mic gate, read under one
    /// lock so whatever cuts with them cuts that session and no other.
    pub(super) fn handles(&self) -> (u64, Option<Arc<AtomicBool>>, Option<Arc<AtomicBool>>) {
        let vt = self.0.lock().unwrap();
        (vt.session, vt.cutoff.clone(), vt.mic_gate.clone())
    }

    pub(super) fn abort_if_current(&self, session: u64) {
        let vt = self.0.lock().unwrap();
        if vt.session == session {
            if let Some(task) = vt.task.as_ref() {
                task.abort();
            }
        }
    }
}

/// Let a released session's task run on after a newer one started, so it can
/// deliver its final answer, but abort it once `grace` has passed: the
/// stop's own abort backstop only ever aborts the CURRENT session, which this
/// one no longer is. A session ends itself well before (CONNECT_TIMEOUT and
/// DRAIN_READ_GRACE bound it, see FLUSH_ABORT_GRACE).
fn detach_flush(session: u64, mut task: tauri::async_runtime::JoinHandle<()>, grace: Duration) {
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            _ = &mut task => {}
            _ = tokio::time::sleep(grace) => {
                log::warn!("voice-typing: released session {session} still running after {grace:?}; aborting it");
                task.abort();
            }
        }
    });
}

/// Held by a voice-typing session task (see `capture::run_metered_session`)
/// and dropped when the task ends, normally or aborted. Hands Esc back if the
/// host still has it claimed for this dictation a while later
/// (`hotkey::release_cancel_after_session`): a host that threw before its own
/// disarm, or a main webview that died, must not leave Esc swallowed in every
/// app.
pub(crate) struct SessionEndGuard {
    app: AppHandle,
    session: u64,
}

impl SessionEndGuard {
    pub(crate) fn new(app: &AppHandle, session: u64) -> Self {
        Self {
            app: app.clone(),
            session,
        }
    }
}

impl Drop for SessionEndGuard {
    fn drop(&mut self) {
        let session = self.session;
        crate::hotkey::release_cancel_after_session(&self.app, move |app| {
            // A newer press owns Esc from its start; leave its claim alone.
            app.try_state::<VoiceTypingState>()
                .is_some_and(|state| state.current() == session)
        });
    }
}

/// Cut a session's audio: set its cutoff (the counter stops forwarding, which
/// closes the STT input and starts the final flush) and stop the capture it
/// opened — that capture only, by gate identity, so a cut that lands after a
/// quick re-press cannot stop the new dictation's mic. Returns whether a
/// capture was stopped. Blocking: stopping joins the capture threads with a
/// grace of up to 1.5 s, so async callers run it on the blocking pool.
pub(super) fn cut_now(
    coord: &MicCoordinator,
    cutoff: Option<&Arc<AtomicBool>>,
    gate: Option<&Arc<AtomicBool>>,
) -> bool {
    if let Some(c) = cutoff {
        c.store(true, Ordering::SeqCst);
    }
    gate.is_some_and(|g| coord.stop_if(MicUser::VoiceTyping, g))
}

#[cfg(test)]
mod flush_abort_tests {
    use super::{FLUSH_ABORT_GRACE, RELEASE_TAIL};
    use crate::transcription::common::{CONNECT_TIMEOUT, DRAIN_READ_GRACE};

    /// The abort must only catch a task stuck past its own bounds: a short tap
    /// whose socket connects at the last moment still drains, waits out its
    /// read grace and fires `stt://closed` before this lands.
    #[test]
    fn the_abort_waits_out_a_late_connect_and_its_read_grace() {
        assert!(FLUSH_ABORT_GRACE > CONNECT_TIMEOUT + DRAIN_READ_GRACE);
        // Counted from the cut, which comes RELEASE_TAIL after the release.
        assert!(RELEASE_TAIL < FLUSH_ABORT_GRACE);
    }
}

#[cfg(test)]
mod session_gate_tests {
    use super::{cut_now, VoiceTypingState, RETIRE_GRACE};
    use crate::capture::{Begin, MicCoordinator, MicUser};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

    /// A session task whose every poll blocks for `poll` before it emits, so
    /// an abort that lands mid-poll cannot stop that emit. Resolves once the
    /// task is inside its first poll.
    async fn adopt_blocking_task(
        state: &VoiceTypingState,
        session: u64,
        poll: Duration,
        events: UnboundedSender<&'static str>,
    ) {
        let (entered_tx, mut entered_rx) = unbounded_channel::<()>();
        let task = tauri::async_runtime::spawn(async move {
            loop {
                let _ = entered_tx.send(());
                std::thread::sleep(poll);
                let _ = events.send("tail final");
                tokio::task::yield_now().await;
            }
        });
        state.adopt(session, task, Arc::new(AtomicBool::new(false)), None);
        entered_rx.recv().await;
    }

    async fn open_announced(
        state: &VoiceTypingState,
        events: UnboundedSender<&'static str>,
    ) -> u64 {
        state
            .open_session(|_| {
                let _ = events.send("reset");
            })
            .await
    }

    async fn settled(events: &mut UnboundedReceiver<&'static str>) -> Vec<&'static str> {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let mut seen = Vec::new();
        while let Ok(e) = events.try_recv() {
            seen.push(e);
        }
        seen
    }

    #[tokio::test]
    async fn the_reset_follows_everything_the_previous_task_emits() {
        let state = VoiceTypingState::default();
        let (events_tx, mut events) = unbounded_channel();
        let first = open_announced(&state, events_tx.clone()).await;
        adopt_blocking_task(&state, first, Duration::from_millis(30), events_tx.clone()).await;

        let second = open_announced(&state, events_tx).await;
        assert_eq!(second, first + 1);
        assert_eq!(
            settled(&mut events).await,
            vec!["reset", "tail final", "reset"]
        );
    }

    #[tokio::test]
    async fn a_backstop_abort_still_leaves_the_task_for_the_next_start_to_await() {
        let state = VoiceTypingState::default();
        let (events_tx, mut events) = unbounded_channel();
        let first = open_announced(&state, events_tx.clone()).await;
        adopt_blocking_task(&state, first, Duration::from_millis(30), events_tx.clone()).await;
        state.abort_if_current(first);

        open_announced(&state, events_tx).await;
        assert_eq!(settled(&mut events).await, vec!["reset", "tail final", "reset"]);
    }

    #[tokio::test]
    async fn a_task_stuck_in_a_poll_does_not_hold_up_the_next_start() {
        let state = VoiceTypingState::default();
        let (events_tx, mut events) = unbounded_channel();
        let first = open_announced(&state, events_tx.clone()).await;
        adopt_blocking_task(&state, first, RETIRE_GRACE * 5, events_tx.clone()).await;

        let started = Instant::now();
        open_announced(&state, events_tx).await;
        assert!(started.elapsed() < RETIRE_GRACE * 3, "took {:?}", started.elapsed());
        assert_eq!(settled(&mut events).await, vec!["reset", "reset"]);
    }

    /// The regression: a toggle tap during the settle started the next session,
    /// which aborted the released one before the recognizer's final answer
    /// came back. A released session now finishes its flush.
    #[tokio::test]
    async fn a_released_session_finishes_its_flush_after_the_next_start() {
        let state = VoiceTypingState::default();
        let (events_tx, mut events) = unbounded_channel();
        let first = open_announced(&state, events_tx.clone()).await;
        let flush_tx = events_tx.clone();
        let task = tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let _ = flush_tx.send("final answer");
        });
        state.adopt(first, task, Arc::new(AtomicBool::new(false)), None);
        state.mark_released(first);

        let started = Instant::now();
        let second = open_announced(&state, events_tx).await;
        assert_eq!(second, first + 1);
        // The new session did not wait for the old flush…
        assert!(started.elapsed() < Duration::from_millis(40));
        // …and the old flush still arrived.
        assert_eq!(settled(&mut events).await, vec!["reset", "reset", "final answer"]);
    }

    /// Detached, a released session is still bounded.
    #[tokio::test]
    async fn a_detached_flush_is_aborted_after_its_grace() {
        let (tx, mut rx) = unbounded_channel::<&'static str>();
        let task = tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let _ = tx.send("too late");
        });
        super::detach_flush(1, task, Duration::from_millis(20));
        tokio::time::sleep(Duration::from_millis(100)).await;
        // The sender went with the aborted task: nothing came, and nothing will.
        assert!(matches!(
            rx.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected)
        ));
    }

    /// A released mark belongs to its session only.
    #[tokio::test]
    async fn a_stale_release_does_not_mark_the_next_session() {
        let state = VoiceTypingState::default();
        let first = state.open_session(|_| {}).await;
        let second = state.open_session(|_| {}).await;
        state.mark_released(first);
        assert!(!state.0.lock().unwrap().released);
        state.mark_released(second);
        assert!(state.0.lock().unwrap().released);
    }

    /// Adopt an idle task for `session` with a fresh cutoff; returns the cutoff.
    fn adopt_idle(state: &VoiceTypingState, session: u64) -> Arc<AtomicBool> {
        let cutoff = Arc::new(AtomicBool::new(false));
        let task = tauri::async_runtime::spawn(async {});
        state.adopt(session, task, cutoff.clone(), None);
        cutoff
    }

    /// The cap watchdog's guard: a released (cut) session is over as far as
    /// the cap goes, even though it stays current until the next start.
    #[tokio::test]
    async fn is_capturing_ends_at_the_cut() {
        let state = VoiceTypingState::default();
        let session = state.open_session(|_| {}).await;
        assert!(!state.is_capturing(session), "nothing adopted yet");
        let cutoff = adopt_idle(&state, session);
        assert!(state.is_capturing(session));

        cutoff.store(true, Ordering::SeqCst);
        assert!(!state.is_capturing(session));
    }

    #[tokio::test]
    async fn is_capturing_ends_when_a_newer_session_starts() {
        let state = VoiceTypingState::default();
        let first = state.open_session(|_| {}).await;
        let first_cutoff = adopt_idle(&state, first);
        let second = state.open_session(|_| {}).await;
        // Never cut — a hung webview — yet no longer the watchdog's business.
        assert!(!first_cutoff.load(Ordering::SeqCst));
        assert!(!state.is_capturing(first));
        adopt_idle(&state, second);
        assert!(state.is_capturing(second));
        assert!(!state.is_capturing(first));
    }

    #[test]
    fn cut_now_sets_the_cutoff_and_stops_only_its_own_capture() {
        let coord = MicCoordinator::default();
        let Begin::Started(old_gate) = coord.begin(MicUser::VoiceTyping) else {
            panic!("expected a fresh capture");
        };
        let old_cutoff = Arc::new(AtomicBool::new(false));
        // A re-press during the release tail: its start released the old
        // capture and opened its own.
        coord.stop(MicUser::VoiceTyping);
        let Begin::Started(new_gate) = coord.begin(MicUser::VoiceTyping) else {
            panic!("expected a fresh capture");
        };

        assert!(!cut_now(&coord, Some(&old_cutoff), Some(&old_gate)));
        assert!(old_cutoff.load(Ordering::SeqCst));
        assert_eq!(coord.owner(), Some(MicUser::VoiceTyping));
        assert!(new_gate.load(Ordering::SeqCst));

        let new_cutoff = Arc::new(AtomicBool::new(false));
        assert!(cut_now(&coord, Some(&new_cutoff), Some(&new_gate)));
        assert!(new_cutoff.load(Ordering::SeqCst));
        assert_eq!(coord.owner(), None);

        // A meeting-tap session has no capture of its own: the cutoff is the cut.
        let tap_cutoff = Arc::new(AtomicBool::new(false));
        assert!(!cut_now(&coord, Some(&tap_cutoff), None));
        assert!(tap_cutoff.load(Ordering::SeqCst));
    }
}
