//! Onboarding's microphone check: a short transcription of the user reading a
//! self-introduction. Unlike the Settings mic test (a level meter only), it
//! runs the configured STT provider end to end, so the wizard proves that the
//! whole capture → transcription path works before the first meeting, and the
//! transcript seeds the user's speaker background.
//!
//! Its events are stamped with source [`MIC_CHECK_SOURCE`]: `transcript://segment`
//! for the text (the meeting store ignores this source), `audio://level` for
//! the meter, and `miccheck://error` when the session fails. It holds the mic
//! as the lowest-priority user (`MicUser::MicTest`), so a meeting or a
//! dictation preempts it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, State};

use crate::audio::microphone::Microphone;
use crate::capture::{
    run_metered_session, spawn_capture, Begin, MeteredSession, MicCoordinator, MicUser,
};
use crate::transcription::common::{CONNECT_TIMEOUT, DRAIN_READ_GRACE};
use crate::transcription::{Entry, SessionRequest, SttProvider, TranscribeConfig};

/// The source label on every event the check emits.
pub const MIC_CHECK_SOURCE: &str = "mic-check";
const ERROR_EVENT: &str = "miccheck://error";
/// Audio kept after Stop so the recognizer can close the last word.
const STOP_TAIL: Duration = Duration::from_millis(250);
/// How long a stopped session may flush before it is aborted.
const FLUSH_ABORT_GRACE: Duration =
    Duration::from_secs(CONNECT_TIMEOUT.as_secs() + DRAIN_READ_GRACE.as_secs() + 1);
/// A self-introduction takes seconds. If the webview never stops the check
/// (closed, hung), the mic and the (possibly paid) stream end here anyway.
const MAX_CHECK: Duration = Duration::from_secs(45);

/// The one running check, if any.
#[derive(Default)]
pub struct MicCheckState(Mutex<MicCheckInner>);

#[derive(Default)]
struct MicCheckInner {
    /// Bumped on every start, so a late stop or watchdog only ends its own run.
    generation: u64,
    running: Option<Running>,
}

struct Running {
    generation: u64,
    task: tauri::async_runtime::JoinHandle<()>,
    cutoff: Arc<AtomicBool>,
    gate: Arc<AtomicBool>,
}

/// Start the check on `input_device` with the given STT provider. A check
/// already running is replaced.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_mic_check(
    app: AppHandle,
    coord: State<'_, MicCoordinator>,
    state: State<'_, MicCheckState>,
    provider: String,
    api_key: String,
    model: Option<String>,
    language_hints: Option<Vec<String>>,
    input_device: Option<String>,
    relay_url: Option<String>,
    vocabulary: Option<Vec<String>>,
) -> Result<(), String> {
    let provider = SttProvider::from_id(&provider).map_err(|e| e.to_string())?;
    let relay_endpoint = relay_url.filter(|u| !u.trim().is_empty());
    SessionRequest::new(
        Some(provider),
        &api_key,
        relay_endpoint.as_deref(),
        model.as_deref(),
    )
    .validate(Entry::Live, |model| {
        crate::local_stt::ensure_installed(&app, model)
    })?;

    if let Some(old) = take_running(&state, None) {
        stop_running(&app, &coord, old, Duration::ZERO);
    }
    // The Settings level preview shares this claim; the check takes it over.
    coord.stop(MicUser::MicTest);
    let gate = match coord.begin(MicUser::MicTest) {
        Begin::Started(gate) => gate,
        Begin::AlreadyActive | Begin::Busy(_) => {
            return Err("the microphone is in use by a meeting or dictation".into())
        }
    };
    let rx = match spawn_capture(
        &coord,
        MicUser::MicTest,
        Microphone {
            device_name: input_device,
        },
        gate.clone(),
        MIC_CHECK_SOURCE,
    ) {
        Ok(rx) => rx,
        Err(e) => {
            coord.stop(MicUser::MicTest);
            return Err(format!("microphone failed to start: {e}"));
        }
    };

    let model = model
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| provider.default_model().to_string());
    let cutoff = Arc::new(AtomicBool::new(false));
    let task = run_metered_session(
        &app,
        rx,
        MeteredSession {
            provider,
            config: TranscribeConfig {
                api_key,
                model,
                language_hints: language_hints.unwrap_or_default(),
                diarization: false,
                relay_endpoint,
                vocabulary: vocabulary.unwrap_or_default(),
                leg: 0,
                time_offset_ms: 0,
                level_events: true,
            },
            label: MIC_CHECK_SOURCE,
            recorder: None,
            error_event: ERROR_EVENT,
            error_mute: None,
            cutoff: Some(cutoff.clone()),
            paused: None,
            session: None,
            reconnect: false,
        },
    );

    let generation = {
        let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
        inner.generation += 1;
        let generation = inner.generation;
        inner.running = Some(Running {
            generation,
            task,
            cutoff,
            gate,
        });
        generation
    };

    let watchdog = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(MAX_CHECK).await;
        use tauri::Manager;
        let state = watchdog.state::<MicCheckState>();
        if let Some(run) = take_running(&state, Some(generation)) {
            log::info!("mic-check: stopped by the {}s cap", MAX_CHECK.as_secs());
            stop_running(
                &watchdog,
                &watchdog.state::<MicCoordinator>(),
                run,
                Duration::ZERO,
            );
        }
    });
    Ok(())
}

/// Stop the check, keeping a short tail so the last word is transcribed. The
/// session flushes its final segments, then ends with `stt://closed`.
#[tauri::command]
pub fn stop_mic_check(
    app: AppHandle,
    coord: State<'_, MicCoordinator>,
    state: State<'_, MicCheckState>,
) {
    if let Some(run) = take_running(&state, None) {
        stop_running(&app, &coord, run, STOP_TAIL);
    }
}

/// The running check, removed from the state; with `only`, only that run.
fn take_running(state: &MicCheckState, only: Option<u64>) -> Option<Running> {
    let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
    match (&inner.running, only) {
        (Some(run), Some(g)) if run.generation != g => None,
        _ => inner.running.take(),
    }
}

/// Cut the audio after `tail`, release the mic, and abort the session if it
/// hasn't flushed within the grace.
fn stop_running(app: &AppHandle, coord: &MicCoordinator, run: Running, tail: Duration) {
    if tail.is_zero() {
        cut(coord, &run);
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if !tail.is_zero() {
            tokio::time::sleep(tail).await;
            use tauri::Manager;
            cut(&app.state::<MicCoordinator>(), &run);
        }
        tokio::time::sleep(FLUSH_ABORT_GRACE).await;
        run.task.abort();
    });
}

fn cut(coord: &MicCoordinator, run: &Running) {
    run.cutoff.store(true, Ordering::SeqCst);
    coord.stop_if(MicUser::MicTest, &run.gate);
}
