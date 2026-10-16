//! `start_voice_typing` / `stop_voice_typing`: opening a dictation session on
//! the microphone (or on a tee of a meeting's mic) and cutting it on release.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};

use super::session::{
    cut_now, VoiceTypingState, CAP_BACKEND_GRACE, FLUSH_ABORT_GRACE, RELEASE_TAIL,
};
use crate::audio::microphone::Microphone;
use crate::capture::{
    run_metered_session, spawn_capture, Begin, MeteredSession, MicCoordinator, MicTap, MicUser,
};
use crate::transcription::common::VOICE_TYPING_SOURCE;
use crate::transcription::{Entry, SessionRequest, SttProvider, TranscribeConfig};

/// Start a mic-only streaming transcription. Idempotent while already running.
/// While a MEETING owns the mic, the session taps the meeting's raw mic stream
/// instead of opening its own capture (a second input stream could kill the
/// meeting's capture — see [`MicCoordinator`] / [`MicTap`]), so dictation works
/// mid-meeting.
///
/// Streams mic -> provider, emitting `transcript://segment` + `audio://level`
/// with source "voice-typing"; the overlay window listens for both. The shared
/// metered session bills the streamed audio under the distinct
/// `source: "voice-typing"` label (kept separate from meeting usage). A failed
/// session raises `voicetyping://error`, which the overlay renders (voice
/// typing has no other error surface — see `run_metered_session`).
///
/// `async` so it runs on the async runtime, NOT the main thread: dictation must
/// stay usable while the app is busy with something else (saving, exporting,
/// transcribing an upload), and a sync command would simply queue behind
/// whatever main-thread work is in flight. Nothing here touches AppKit — the
/// overlay/clipboard commands, which do, stay synchronous on macOS.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn start_voice_typing(
    app: AppHandle,
    coord: State<'_, MicCoordinator>,
    tap: State<'_, MicTap>,
    state: State<'_, VoiceTypingState>,
    provider: String,
    api_key: String,
    model: Option<String>,
    language_hints: Option<Vec<String>>,
    input_device: Option<String>,
    // Hosted "parley" mode: the cloud STT relay's `wss://` URL. When set,
    // `api_key` is the cloud Bearer token (not a vendor key) and the adapter
    // relays through this URL. Absent for BYOK providers. Same contract as
    // `start_meeting`.
    relay_url: Option<String>,
    // Hosted "parley" mode only: the free plan's per-dictation cap, in seconds.
    // The frontend caps and stops the session at the limit; this arms a backend
    // watchdog that force-stops the mic if the webview never did, so the paid
    // relay can't stream forever. `None`/`0` (BYOK) = uncapped.
    max_duration_secs: Option<u64>,
    // The phrase dictionary's phrases, biased into recognition by the selected
    // provider (see `TranscribeConfig::vocabulary`). Optional so a caller that
    // predates the dictionary still works — absent = no biasing.
    vocabulary: Option<Vec<String>>,
) -> Result<(), String> {
    let provider = SttProvider::from_id(&provider).map_err(|e| e.to_string())?;
    let relay_endpoint = relay_url.filter(|u| !u.trim().is_empty());
    // The same checks as start_meeting: a key unless on-device, the relay for
    // the hosted token, and no dictation on a model that is not on disk.
    SessionRequest::new(
        Some(provider),
        &api_key,
        relay_endpoint.as_deref(),
        model.as_deref(),
    )
    .validate(Entry::Live, |model| {
        crate::local_stt::ensure_installed(&app, model)
    })?;
    // A press must always yield a FRESH session. Release any voice-typing mic
    // claim left by a desynced frontend (no-op when idle).
    coord.stop(MicUser::VoiceTyping);
    let session = state
        .open_session(|session| {
            let _ = app.emit(
                "voicetyping://session",
                serde_json::json!({ "phase": "start", "session": session }),
            );
        })
        .await;
    let opening = Instant::now();
    let Some((rx, mic_gate)) = acquire_mic(&coord, &tap, input_device)? else {
        // Unreachable in practice: the host serializes press/release, so no
        // second voice-typing start can land between the stop above and this
        // begin. Kept for safety.
        return Ok(());
    };
    // Everything said between the press and this point is lost (the capture
    // is not running yet), so it is worth knowing how long it takes: a
    // Bluetooth headset can need a second or more.
    let tapped = if mic_gate.is_none() {
        " (meeting tap)"
    } else {
        ""
    };
    log::info!(
        "voice-typing: mic open in {}ms{tapped}",
        opening.elapsed().as_millis()
    );
    let model = model
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| provider.default_model().to_string());
    let config = TranscribeConfig {
        api_key,
        model,
        language_hints: language_hints.unwrap_or_default(),
        diarization: false,
        relay_endpoint,
        vocabulary: vocabulary.unwrap_or_default(),
        // Dictation is one session, never a chain of reconnected legs.
        leg: 0,
        time_offset_ms: 0,
        level_events: true,
    };
    // Per-session cutoff: `stop_voice_typing` flips it to end the stream
    // RELEASE_TAIL after the key is released, before the mic thread even
    // notices the gate.
    let cutoff = Arc::new(AtomicBool::new(false));
    let task = run_metered_session(
        &app,
        rx,
        MeteredSession {
            provider,
            config,
            label: VOICE_TYPING_SOURCE,
            recorder: None,
            error_event: "voicetyping://error",
            error_mute: None,
            cutoff: Some(cutoff.clone()),
            // Dictation is not pausable — and must keep working even while a
            // live meeting (whose mic it taps) is paused.
            paused: None,
            session: Some(session),
            // Single-shot: a dropped connection ends the dictation with an
            // error the overlay shows, rather than redialling under someone
            // waiting.
            reconnect: false,
        },
    );
    state.adopt(session, task, cutoff, mic_gate);
    // The Windows tray's voice-typing item now reads "Stop" (no-op elsewhere).
    crate::tray::set_voice_typing_active(&app, true);

    // Backend safety net for the hosted single-session cap: if the frontend
    // never stops this session (webview hung/crashed), tear the mic down after
    // the cap + grace so the paid relay stops streaming.
    if let Some(secs) = max_duration_secs.filter(|s| *s > 0) {
        arm_cap_watchdog(&app, state.inner().clone(), session, secs);
    }
    Ok(())
}

/// The PCM a dictation session reads, with the gate of the capture it opened
/// (`None` when it taps a meeting's mic).
type MicInput = (
    tokio::sync::mpsc::UnboundedReceiver<Vec<i16>>,
    Option<Arc<AtomicBool>>,
);

/// Take the microphone for a dictation session: our own capture normally, or a
/// tee of the meeting's raw mic when a meeting owns the one input stream.
/// `Ok(None)` means voice typing already holds the mic and the start is a no-op.
fn acquire_mic(
    coord: &MicCoordinator,
    tap: &MicTap,
    input_device: Option<String>,
) -> Result<Option<MicInput>, String> {
    match coord.begin(MicUser::VoiceTyping) {
        Begin::Started(gate) => {
            let mic = Microphone {
                device_name: input_device,
            };
            match spawn_capture(
                coord,
                MicUser::VoiceTyping,
                mic,
                gate.clone(),
                "voice-typing",
            ) {
                Ok(rx) => Ok(Some((rx, Some(gate)))),
                Err(e) => {
                    coord.stop(MicUser::VoiceTyping);
                    Err(format!("microphone failed to start: {e}"))
                }
            }
        }
        Begin::AlreadyActive => Ok(None),
        // Dictating DURING a meeting: the meeting owns the one input stream,
        // so read a tee of its raw mic instead of opening a second capture.
        // Everything downstream (session, overlay, cutoff, paste) is
        // identical; teardown is self-cleaning — when this session's receiver
        // drops (release cutoff, abort, or new start), the tap unregisters on
        // its next failed send. The dictated speech naturally also lands in
        // the meeting transcript, like anything else said aloud.
        Begin::Busy(MicUser::Meeting) => {
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
            tap.subscribe(tx)?;
            Ok(Some((rx, None)))
        }
        Begin::Busy(owner) => Err(format!("microphone is in use by {owner:?}")),
    }
}

/// Force-stop the mic once the hosted per-dictation cap (+ grace) has passed,
/// unless the release already cut `session`, or it was superseded. A hung
/// webview, which never cuts, is still caught.
fn arm_cap_watchdog(app: &AppHandle, state: VoiceTypingState, session: u64, secs: u64) {
    let app = app.clone();
    let deadline = Duration::from_secs(secs) + CAP_BACKEND_GRACE;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(deadline).await;
        if !state.is_capturing(session) {
            return;
        }
        log::warn!("voice-typing: hosted session exceeded {secs}s cap; backend safety-stop");
        let (current, cutoff, gate) = state.handles();
        if current == session {
            let a = app.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                cut_now(&a.state::<MicCoordinator>(), cutoff.as_ref(), gate.as_ref())
            })
            .await;
        }
        state.abort_if_current(session);
    });
}

/// Stop the session: after RELEASE_TAIL (`tail`, the default) or at once
/// (`tail: false` — the hosted cap, which must not stream past its limit), set
/// the cutoff and stop the capture this session opened. The cutoff closes the
/// STT input, the graceful path that lets the provider flush its final tokens;
/// the host waits for that flush (`stt://closed`) before it pastes.
///
/// Returns immediately; the tail and the cut run in the background. A quick
/// re-press queues its start behind this command on the host, and holding it
/// for the tail would cost the NEXT dictation its first 250 ms. A start that
/// does land during the tail is safe: it releases this session's capture
/// itself, and the cut stops by capture identity (`MicCoordinator::stop_if`),
/// so it cannot stop the new one.
///
/// Backstop: a provider/relay that never ends the stream would leave the
/// session task parked on its read half. CONNECT_TIMEOUT and DRAIN_READ_GRACE
/// end it first (see FLUSH_ABORT_GRACE); for anything else mirror
/// `stop_meeting`'s direct-cancel safety net and abort the task once the flush
/// window has long passed. Guarded by the session id
/// so a backstop from THIS session can never abort a newer one started during
/// the grace.
///
/// `async` for the same reason as [`start_voice_typing`], and the capture stop
/// runs on the blocking pool: it joins the capture threads with a bounded
/// grace, which on the main thread hitched every window on every key release
/// and on an async worker could stall the task driving the flush's socket.
#[tauri::command]
pub async fn stop_voice_typing(
    app: AppHandle,
    state: State<'_, VoiceTypingState>,
    tail: Option<bool>,
) -> Result<(), String> {
    crate::tray::set_voice_typing_active(&app, false);
    let (session, cutoff, gate) = state.handles();
    state.mark_released(session);
    let state = state.inner().clone();
    let tail = if tail.unwrap_or(true) {
        RELEASE_TAIL
    } else {
        Duration::ZERO
    };
    tauri::async_runtime::spawn(async move {
        // A second stop (the cap racing a release) finds the cut already made
        // and must not add another tail.
        if !tail.is_zero() && cutoff.as_ref().is_some_and(|c| !c.load(Ordering::SeqCst)) {
            tokio::time::sleep(tail).await;
        }
        let a = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            cut_now(&a.state::<MicCoordinator>(), cutoff.as_ref(), gate.as_ref())
        })
        .await;
        tokio::time::sleep(FLUSH_ABORT_GRACE).await;
        state.abort_if_current(session);
    });
    Ok(())
}
