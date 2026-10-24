//! The live meeting: starting its captures and transcription sessions,
//! pausing it, and stopping (recording kept) or cancelling (discarded) it.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

use tokio::sync::mpsc::UnboundedReceiver;

use crate::audio::microphone::Microphone;
use crate::capture::{
    run_metered_session, spawn_capture, Begin, MeteredSession, MicCoordinator, MicTap, MicUser,
    RecorderBuf, Recording,
};
use crate::recording_journal::{self, JournalMeta, RecordingJournal};
use crate::transcription::{Entry, SessionRequest, SttProvider, TranscribeConfig};

/// Meeting-specific state held in Tauri's managed state. Who owns the mic (and
/// the capture threads/gate of the live session) lives in [`MicCoordinator`];
/// only what a meeting needs beyond its capture stays here.
#[derive(Default)]
pub struct MeetingState {
    /// Live transcription session tasks (the per-source provider WebSocket
    /// loops). Held so `stop_meeting` can `abort()` them — a direct cancel that
    /// closes the socket even if the capture→channel-close cascade stalls, instead
    /// of letting the session linger and keep emitting transcript after stop.
    tasks: Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
    /// This meeting's `meeting://error` mute (fresh per start, set on stop).
    /// Session tasks outlive `stop_meeting` by the flush/abort grace; a failure
    /// in that window must not tear down whatever meeting runs NEXT — see
    /// `run_metered_session`.
    error_mute: Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>>,
    /// Buffers the recorded audio of the in-progress live meeting (see RecorderBuf).
    recorder: RecorderBuf,
    /// Meeting pause (the titlebar ⏸): while true, captured PCM is dropped
    /// before the STT upload, the recording tee and the usage counter — nothing
    /// is transcribed, recorded or billed, but the capture + sockets stay open
    /// so resume is instant. Reset on every start.
    meeting_paused: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// The meeting being recorded: the id the frontend gave it (also the
    /// history entry's id and the journal's file name) and when it started.
    /// Every `meeting://recording-*` event carries them, so the frontend saves
    /// THAT meeting's snapshot even when another one has started meanwhile.
    current: Mutex<Option<JournalMeta>>,
    /// Meetings stopped but not yet handed to the frontend (encoding). Their
    /// journals must not be recovered as crashed meanwhile.
    stopping: Mutex<Vec<String>>,
}

/// Whether a live meeting is currently recording. The Settings UI uses this to
/// disable the mic test + device picker while recording (switching the input
/// mid-meeting can disrupt the meeting's capture).
#[tauri::command]
pub fn meeting_active(coord: State<MicCoordinator>) -> bool {
    coord.owner() == Some(MicUser::Meeting)
}

/// The meeting the backend is recording, if any: its id and start time. The
/// frontend asks before a start, so a recording this window lost track of is
/// stopped and saved first instead of silently absorbing the next meeting.
#[tauri::command]
pub fn active_meeting(
    state: State<MeetingState>,
    coord: State<MicCoordinator>,
) -> Option<JournalMeta> {
    if coord.owner() != Some(MicUser::Meeting) {
        return None;
    }
    state.current.lock().unwrap().clone()
}

/// The meeting's history entry is written (or it was deliberately not kept):
/// its crash journal has done its job.
#[tauri::command]
pub fn finish_meeting_journal(app: AppHandle, meeting_id: String) {
    if let Some(dir) = journal_dir(&app) {
        recording_journal::remove(&dir, &meeting_id);
    }
}

/// Journals of meetings that never reached history — the app crashed, was
/// quit or force-quit mid-meeting — repaired into recordings for the frontend
/// to save. The meeting still recording and any being stopped are skipped.
#[tauri::command]
pub fn recover_meeting_journals(
    app: AppHandle,
    state: State<MeetingState>,
    coord: State<MicCoordinator>,
) -> Vec<recording_journal::Recovered> {
    let Some(dir) = journal_dir(&app) else {
        return Vec::new();
    };
    let mut skip = state.stopping.lock().unwrap().clone();
    if coord.owner() == Some(MicUser::Meeting) {
        if let Some(m) = state.current.lock().unwrap().as_ref() {
            skip.push(m.meeting_id.clone());
        }
    }
    recording_journal::recover_all(&dir, &skip, crate::replay_audio::unique_recording_path)
}

fn journal_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    match app.path().app_data_dir() {
        Ok(d) => Some(recording_journal::journal_dir(&d)),
        Err(e) => {
            log::warn!("recording journal: no app data dir: {e}");
            None
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Pause / resume the live meeting (the titlebar ⏸/▶). While paused every
/// captured chunk is dropped before the recorder tee, the STT upload and the
/// usage counter (see `run_metered_session`), so nothing is transcribed,
/// recorded or billed — but the mic/system capture and the provider sockets
/// stay open (the adapters' keepalives carry them), making resume seamless:
/// same session, same speaker diarization, continuous timeline. Deliberately
/// does NOT emit `meeting://status` — the capture is still live, so surfaces
/// keyed on that event (the Settings mic lock) must keep treating the meeting
/// as active.
#[tauri::command]
pub fn set_meeting_paused(state: State<MeetingState>, paused: bool) {
    state
        .meeting_paused
        .store(paused, std::sync::atomic::Ordering::SeqCst);
    log::info!("meeting: paused={paused}");
}

/// Refuses a meeting start that cannot work, before `start_meeting` claims
/// the mic.
fn check_meeting_start(
    app: &AppHandle,
    provider: SttProvider,
    api_key: &str,
    relay_endpoint: Option<&str>,
    model: Option<&str>,
) -> Result<(), String> {
    SessionRequest::new(Some(provider), api_key, relay_endpoint, model)
        .validate(Entry::Live, |model| {
            crate::local_stt::ensure_installed(app, model)
        })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn start_meeting(
    app: AppHandle,
    state: State<MeetingState>,
    coord: State<MicCoordinator>,
    provider: String,
    api_key: String,
    model: Option<String>,
    language_hints: Option<Vec<String>>,
    diarization: Option<bool>,
    input_device: Option<String>,
    // Hosted "parley" mode: the cloud STT relay's `wss://` URL. When set,
    // `api_key` is the cloud Bearer token (not a vendor key) and the adapter
    // relays through this URL. Absent for BYOK providers.
    relay_url: Option<String>,
    // The phrase dictionary's phrases, biased into recognition by whichever
    // provider is selected (see `TranscribeConfig::vocabulary`). Optional so a
    // caller that predates the dictionary still works — absent = no biasing.
    vocabulary: Option<Vec<String>>,
    // The frontend's id for this meeting (its history entry's id). Echoed on
    // the recording events so the save can never pick up another meeting's
    // state; one is made up for a caller that sends none.
    meeting_id: Option<String>,
) -> Result<(), String> {
    let provider = SttProvider::from_id(&provider).map_err(|e| e.to_string())?;
    let relay_endpoint = relay_url.filter(|u| !u.trim().is_empty());
    check_meeting_start(
        &app,
        provider,
        &api_key,
        relay_endpoint.as_deref(),
        model.as_deref(),
    )?;
    // Claim the mic. A meeting outranks the Settings mic test and voice typing,
    // so the coordinator stops either one first (device released before our
    // capture opens); a second start while a meeting runs is an idempotent no-op.
    // The gate is per-session: stop_meeting clears exactly this session's
    // threads, and a detached/wedged thread from a prior session (holding its
    // own dead gate) can never be revived by a later start.
    let gate = match coord.begin(MicUser::Meeting) {
        Begin::Started(gate) => gate,
        Begin::AlreadyActive => {
            // The frontend thought nothing was recording. Worth a line: this
            // is the trace a lost meeting leaves (the window reloaded under a
            // running capture), and the recording it started keeps growing.
            log::warn!("meeting: start ignored, a meeting is already recording");
            return Ok(());
        }
        // Unreachable today (Meeting outranks everything), kept for safety.
        Begin::Busy(owner) => return Err(format!("microphone is in use by {owner:?}")),
    };
    let model = model
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| provider.default_model().to_string());
    let sessions = MeetingSessions {
        provider,
        // Honor the request only if the provider can actually diarize.
        diarization: diarization.unwrap_or(true) && provider.supports_diarization(),
        config: TranscribeConfig {
            api_key,
            model,
            language_hints: language_hints.unwrap_or_default(),
            diarization: false,
            relay_endpoint,
            vocabulary: vocabulary.unwrap_or_default(),
            // The first leg; run_metered_session numbers and offsets the redials.
            leg: 0,
            time_offset_ms: 0,
            level_events: true,
        },
        wiring: arm_meeting(&app, &state, meeting_id),
    };
    let tasks = start_meeting_captures(&app, &coord, &gate, input_device, &sessions);
    finish_meeting_start(&app, &state, &coord, tasks);
    Ok(())
}

/// What every session of one meeting shares: the provider, its config, and
/// the meeting's recording buffer, error mute and pause switch.
struct MeetingSessions {
    provider: SttProvider,
    /// Diarizing providers separate speakers themselves, so mic + system are
    /// mixed into ONE session (1x cost) and diarization labels speakers.
    /// Providers without diarization keep two sessions so "me"/"them" stays
    /// deterministic.
    diarization: bool,
    /// The first leg's config; `diarization` is filled in per session.
    config: TranscribeConfig,
    wiring: MeetingWiring,
}

/// The per-meeting state a session is wired to (see [`arm_meeting`]).
struct MeetingWiring {
    recorder: RecorderBuf,
    error_mute: std::sync::Arc<std::sync::atomic::AtomicBool>,
    paused: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl MeetingSessions {
    /// The session for capture `label`; `record` = it tees into the meeting's
    /// recording (only one session per meeting does).
    fn session(&self, label: &'static str, record: bool) -> MeteredSession {
        MeteredSession {
            provider: self.provider,
            config: TranscribeConfig {
                diarization: self.diarization,
                ..self.config.clone()
            },
            label,
            recorder: record.then(|| self.wiring.recorder.clone()),
            error_event: "meeting://error",
            error_mute: Some(self.wiring.error_mute.clone()),
            cutoff: None,
            paused: Some(self.wiring.paused.clone()),
            session: None,
            // Redial a dropped connection; the recording never stops for it.
            reconnect: true,
        }
    }
}

/// Reset the meeting state for a new meeting: arm a fresh recording buffer
/// (the designated session tees its PCM into it; stop_meeting encodes + clears
/// it), unpause, drop the (finished) session handles of a prior meeting, and
/// arm THIS meeting's error mute (unset). The previous meeting's sessions hold
/// the previous mute — already set by its stop.
fn arm_meeting(app: &AppHandle, state: &MeetingState, meeting_id: Option<String>) -> MeetingWiring {
    let meta = JournalMeta {
        meeting_id: meeting_id
            .filter(|id| recording_journal::valid_meeting_id(id))
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        started_at_ms: now_ms(),
    };
    // The crash-safe copy. Failing to open it costs only the crash safety:
    // the meeting records into RAM as it always has.
    let journal = journal_dir(app).and_then(|dir| match RecordingJournal::start(&dir, &meta) {
        Ok(j) => Some(j),
        Err(e) => {
            log::error!("recording journal: not started, this meeting is RAM-only: {e}");
            None
        }
    });
    *state.recorder.lock().unwrap() = Some(Recording::new(journal));
    *state.current.lock().unwrap() = Some(meta);
    // A new meeting always starts unpaused.
    state
        .meeting_paused
        .store(false, std::sync::atomic::Ordering::SeqCst);
    state.tasks.lock().unwrap().clear();
    let error_mute = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    *state.error_mute.lock().unwrap() = Some(error_mute.clone());
    MeetingWiring {
        recorder: state.recorder.clone(),
        error_mute,
        paused: state.meeting_paused.clone(),
    }
}

/// Start the meeting's captures and one transcription session per capture
/// that came up. Same shape on both desktop platforms; only the system-audio
/// source differs (macOS Core Audio process tap, Windows WASAPI loopback).
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn start_meeting_captures(
    app: &AppHandle,
    coord: &MicCoordinator,
    gate: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    input_device: Option<String>,
    sessions: &MeetingSessions,
) -> Vec<tauri::async_runtime::JoinHandle<()>> {
    let mic = Microphone {
        device_name: input_device,
    };
    #[cfg(target_os = "macos")]
    let sys = crate::audio::system_macos::SystemAudio { app: app.clone() };
    #[cfg(target_os = "windows")]
    let sys = crate::audio::system_windows::SystemAudio { app: app.clone() };
    // Shared far-end state: the system-audio tap feeds it, the mic prosody
    // tap reads it to reject the counterpart's voice bleeding through the
    // speakers into the mic (pace/intonation must score "me" only).
    let far = std::sync::Arc::new(crate::audio::prosody::FarEndState::new());
    let captures = MeetingCaptures {
        app,
        coord,
        gate,
        far,
    };
    if sessions.diarization {
        captures.start_mixed(mic, sys, sessions)
    } else {
        captures.start_split(mic, sys, sessions)
    }
}

/// Any other target has no system-audio source: mic only.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn start_meeting_captures(
    app: &AppHandle,
    coord: &MicCoordinator,
    gate: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    input_device: Option<String>,
    sessions: &MeetingSessions,
) -> Vec<tauri::async_runtime::JoinHandle<()>> {
    let mic = Microphone {
        device_name: input_device,
    };
    // The mic is the only source here, so a failure to open it is a failure
    // to record — no second stream can carry the meeting. The shared
    // no-capture tail (`finish_meeting_start`) releases the claim and raises
    // the error; `spawn_capture` has already logged the device's own reason.
    let Ok(rx) = spawn_capture(coord, MicUser::Meeting, mic, gate.clone(), "me") else {
        return Vec::new();
    };
    // No system capture on this platform → no far-end reference to gate on.
    let rx = spawn_mic_prosody_tap(app, rx, None);
    vec![run_metered_session(app, rx, sessions.session("me", true))]
}

/// The two desktop captures of one meeting.
#[cfg(any(target_os = "macos", target_os = "windows"))]
struct MeetingCaptures<'a> {
    app: &'a AppHandle,
    coord: &'a MicCoordinator,
    gate: &'a std::sync::Arc<std::sync::atomic::AtomicBool>,
    far: std::sync::Arc<crate::audio::prosody::FarEndState>,
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl MeetingCaptures<'_> {
    /// The mic capture behind its prosody tap, or `None` if it failed to start.
    fn mic(&self, mic: Microphone) -> Option<UnboundedReceiver<Vec<i16>>> {
        spawn_capture(self.coord, MicUser::Meeting, mic, self.gate.clone(), "me")
            .ok()
            .map(|rx| spawn_mic_prosody_tap(self.app, rx, Some(self.far.clone())))
    }

    /// The system-audio capture behind its far-end tap, or `None`.
    fn system<S: crate::audio::AudioSource>(&self, sys: S) -> Option<UnboundedReceiver<Vec<i16>>> {
        spawn_capture(self.coord, MicUser::Meeting, sys, self.gate.clone(), "them")
            .ok()
            .map(|rx| spawn_farend_tap(rx, self.far.clone()))
    }

    /// Diarizing provider: mix both sides into one recorded session. The
    /// prosody analyzer taps the PRE-MIX mic for delivery coaching (issue #22):
    /// it must see raw mic, never the mixed/diarized stream. If one capture
    /// failed, transcribe + record whichever started.
    fn start_mixed<S: crate::audio::AudioSource>(
        &self,
        mic: Microphone,
        sys: S,
        sessions: &MeetingSessions,
    ) -> Vec<tauri::async_runtime::JoinHandle<()>> {
        let rx_me = self.mic(mic);
        let rx_them = self.system(sys);
        log::info!(
            "meeting: capture started (mic: {}, system: {})",
            rx_me.is_some(),
            rx_them.is_some()
        );
        let (label, rx) = match (rx_me, rx_them) {
            (Some(a), Some(b)) => {
                let (tx_mix, rx_mix) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
                tauri::async_runtime::spawn(crate::audio::mixer::mix_streams(
                    self.app.clone(),
                    a,
                    b,
                    tx_mix,
                ));
                // Record the mixed stream → the saved file holds both sides.
                ("mix", rx_mix)
            }
            (Some(a), None) => ("me", a),
            (None, Some(b)) => ("them", b),
            // No capture at all: handled by the shared no-capture tail
            // (`finish_meeting_start`), the one place that knows what a
            // source-less meeting owes the user.
            (None, None) => return Vec::new(),
        };
        vec![run_metered_session(
            self.app,
            rx,
            sessions.session(label, true),
        )]
    }

    /// No diarization → two sessions. Record the mic only (mixing two
    /// un-aligned streams into one file would garble it).
    fn start_split<S: crate::audio::AudioSource>(
        &self,
        mic: Microphone,
        sys: S,
        sessions: &MeetingSessions,
    ) -> Vec<tauri::async_runtime::JoinHandle<()>> {
        let mut tasks = Vec::new();
        if let Some(rx) = self.mic(mic) {
            tasks.push(run_metered_session(
                self.app,
                rx,
                sessions.session("me", true),
            ));
        }
        if let Some(rx) = self.system(sys) {
            tasks.push(run_metered_session(
                self.app,
                rx,
                sessions.session("them", false),
            ));
        }
        tasks
    }
}

/// Adopt the meeting's session tasks and announce the result. Every capture
/// that came up owns exactly one transcription session task, so no tasks
/// means nothing at all is recording. Announcing "recording" anyway is how a
/// Windows user with the microphone denied got a LIVE badge over a whole
/// silent meeting, and how Settings stayed mic-locked until the frontend
/// happened to react.
fn finish_meeting_start(
    app: &AppHandle,
    state: &MeetingState,
    coord: &MicCoordinator,
    tasks: Vec<tauri::async_runtime::JoinHandle<()>>,
) {
    let mut adopted = state.tasks.lock().unwrap();
    adopted.extend(tasks);
    if !adopted.is_empty() {
        drop(adopted);
        let _ = app.emit("meeting://status", "recording");
        return;
    }
    drop(adopted);
    // Release the mic claim too: nothing is capturing, so voice typing /
    // the mic test shouldn't stay locked out until the frontend reacts to
    // the error (its stop_meeting is a no-op by then).
    coord.stop(MicUser::Meeting);
    log::error!("meeting: no audio source could be started");
    let _ = app.emit(
        "meeting://error",
        serde_json::json!({
            "source": "meeting",
            "code": "capture",
            "message": "no audio source could be started",
        }),
    );
}

/// Shared meeting teardown: mute this session's error surface, release the
/// transcription tasks (with the flush/abort grace) and stop the capture.
/// Returns the recording (and which meeting it is) for the caller to either
/// encode (stop) or discard (cancel).
fn teardown_meeting(
    app: &AppHandle,
    state: &State<MeetingState>,
    coord: &State<MicCoordinator>,
) -> Option<(Recording, Option<JournalMeta>)> {
    // Direct-cancel safety net for the transcription sessions. Stopping the
    // capture below starts the graceful capture→channel-close cascade, which
    // closes the socket and emits final usage. The abort is ONLY a backstop for a
    // socket that never closes (a stalled provider/network): wait a generous grace
    // so even a slow finalize completes first — aborting an already-finished task
    // is a no-op, and after stop no new audio flows, so the extra idle wait
    // produces no new transcript. (A short grace would cut a slow finalize and
    // lose the last segment; the usage event survives an abort, see
    // capture.rs `UsageReport`.)
    // From this point the meeting is over: a failure inside the flush/abort
    // grace below belongs to THIS (ended) meeting, and raising meeting://error
    // for it would tear down whatever meeting the user starts next (or toast a
    // spurious failure). Mute FIRST — before anything below can make a session
    // fail — then release the tasks; run_metered_session logs instead.
    if let Some(mute) = state.error_mute.lock().unwrap().as_ref() {
        mute.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    let tasks: Vec<tauri::async_runtime::JoinHandle<()>> =
        state.tasks.lock().unwrap().drain(..).collect();
    if !tasks.is_empty() {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(8000)).await;
            for t in tasks {
                t.abort();
            }
        });
    }

    // NOTE: a stop/cancel while paused leaves `meeting_paused` set on purpose —
    // chunks still draining through the flush grace belong to the paused span
    // and must stay dropped. The next start re-arms the flag.
    // Clear this session's gate and join its capture threads (bounded grace) so
    // each releases its device — dropping its PCM sender, which ends the STT
    // session via channel close. See MicCoordinator for the gate/detach story.
    coord.stop(MicUser::Meeting);
    let _ = app.emit("meeting://status", "stopped");
    let recording = state.recorder.lock().unwrap().take()?;
    Some((recording, state.current.lock().unwrap().clone()))
}

/// Cut a recording down to its first `keep_ms` (16 kHz mono). `None`, or a
/// length past the end, keeps all of it.
fn keep_leading(mut pcm: Vec<i16>, keep_ms: Option<u64>) -> Vec<i16> {
    if let Some(ms) = keep_ms {
        let keep = (ms * crate::audio::TARGET_SAMPLE_RATE as u64 / 1000) as usize;
        if keep < pcm.len() {
            log::info!(
                "recording: trimming trailing silence ({} ms → {} ms)",
                pcm.len() as u64 * 1000 / crate::audio::TARGET_SAMPLE_RATE as u64,
                ms
            );
            pcm.truncate(keep);
        }
    }
    pcm
}

/// End the live meeting and save its recording. `keep_ms` cuts the recording
/// to its first `keep_ms`: the silence guard passes it when a meeting is ended
/// because nobody has spoken for a long time, so the saved file stops shortly
/// after the last words instead of carrying the quiet room that followed.
#[tauri::command]
pub fn stop_meeting(
    app: AppHandle,
    state: State<MeetingState>,
    coord: State<MicCoordinator>,
    keep_ms: Option<u64>,
) -> Result<(), String> {
    let Some((recording, meta)) = teardown_meeting(&app, &state, &coord) else {
        // Nothing was recording (a repeated stop). Still release the spinner.
        let _ = app.emit("meeting://recording-discarded", serde_json::json!({}));
        return Ok(());
    };
    let ids = meta
        .as_ref()
        .map(|m| serde_json::json!({ "meetingId": m.meeting_id, "startedAtMs": m.started_at_ms }));
    let stopping_id = meta.as_ref().map(|m| m.meeting_id.clone());
    if let Some(id) = &stopping_id {
        state.stopping.lock().unwrap().push(id.clone());
    }
    let dir = journal_dir(&app);

    // Encode the captured audio off-thread and tell the frontend where it landed
    // (which then writes the history entry). Skip very short / empty recordings —
    // but ALWAYS emit a terminal signal (saved OR discarded), because the frontend
    // holds a "finalizing" spinner from the moment End is pressed and only clears
    // it on one of these events; a silent exit would hang that spinner forever.
    let app = app.clone();
    std::thread::spawn(move || {
        let ids = ids.unwrap_or_else(|| serde_json::json!({}));
        finish_stopped(&app, recording, keep_ms, dir.as_deref(), ids);
        if let Some(id) = &stopping_id {
            app.state::<MeetingState>()
                .stopping
                .lock()
                .unwrap()
                .retain(|s| s != id);
        }
    });
    Ok(())
}

/// The stop's off-thread half: close the journal, encode the RAM recording
/// (falling back to the journal), and send the terminal event.
fn finish_stopped(
    app: &AppHandle,
    recording: Recording,
    keep_ms: Option<u64>,
    dir: Option<&std::path::Path>,
    mut payload: serde_json::Value,
) {
    let Recording { pcm, journal } = recording;
    let journal_id = journal.as_ref().map(|j| j.id().to_string());
    // Everything captured is on disk before anything else can go wrong.
    if let Some(j) = journal {
        j.close();
    }
    let journal_at = dir.zip(journal_id.as_deref());
    let outcome = encode_stopped(keep_leading(pcm, keep_ms), || {
        journal_at.and_then(|(dir, id)| recover_from_journal(dir, id))
    });
    match outcome {
        Stopped::Saved(out, duration_ms) => {
            payload["path"] = out.to_string_lossy().into();
            payload["durationMs"] = duration_ms.into();
            // The journal stays until the frontend has written the entry
            // (`finish_meeting_journal`): a crash in between recovers it.
            let _ = app.emit("meeting://recording-saved", payload);
        }
        Stopped::TooShort => {
            if let Some((dir, id)) = journal_at {
                recording_journal::remove(dir, id);
            }
            let _ = app.emit("meeting://recording-discarded", payload);
        }
        // Kept on disk: the next launch tries to recover it.
        Stopped::Failed => {
            let _ = app.emit("meeting://recording-discarded", payload);
        }
    }
}

/// The RAM encode failed: the journal holds the same audio.
fn recover_from_journal(dir: &std::path::Path, id: &str) -> Option<(std::path::PathBuf, u64)> {
    let out = crate::replay_audio::unique_recording_path();
    match recording_journal::repair(&recording_journal::audio_path(dir, id), &out) {
        Ok(ms) if ms > 0 => {
            log::warn!("recording: saved from the journal instead ({ms} ms)");
            Some((out, ms))
        }
        _ => None,
    }
}

/// What became of a stopped meeting's audio.
enum Stopped {
    Saved(std::path::PathBuf, u64),
    TooShort,
    Failed,
}

/// Encode a stopped meeting's PCM to a fresh temp recording; `fallback` is
/// tried when the encode fails.
fn encode_stopped(
    pcm: Vec<i16>,
    fallback: impl FnOnce() -> Option<(std::path::PathBuf, u64)>,
) -> Stopped {
    let rate = crate::audio::TARGET_SAMPLE_RATE as usize;
    if pcm.len() < rate * 2 {
        log::info!("recording: too short to save ({} samples)", pcm.len());
        return Stopped::TooShort;
    }
    let duration_ms = (pcm.len() as u64 * 1000) / rate as u64;
    let out = crate::replay_audio::unique_recording_path();
    match crate::replay_audio::encode_opus_ogg(&pcm, &out) {
        Ok(()) => {
            log::info!(
                "recording: saved {} ({} ms)",
                out.to_string_lossy(),
                duration_ms
            );
            Stopped::Saved(out, duration_ms)
        }
        Err(e) => {
            log::error!("recording: encode failed: {e}");
            match fallback() {
                Some((out, ms)) => Stopped::Saved(out, ms),
                None => Stopped::Failed,
            }
        }
    }
}

/// Cancel the live meeting: identical teardown to [`stop_meeting`], but the
/// captured audio is DISCARDED instead of encoded — no `meeting://recording-saved`
/// follows, so nothing is saved to history and no analysis runs. The frontend
/// resets its own transcript/session state alongside this call.
#[tauri::command]
pub fn cancel_meeting(
    app: AppHandle,
    state: State<MeetingState>,
    coord: State<MicCoordinator>,
) -> Result<(), String> {
    match teardown_meeting(&app, &state, &coord) {
        Some((Recording { pcm, journal }, _)) => {
            log::info!("meeting: cancelled, discarding {} samples", pcm.len());
            if let Some(j) = journal {
                let id = j.id().to_string();
                j.close();
                if let Some(dir) = journal_dir(&app) {
                    recording_journal::remove(&dir, &id);
                }
            }
        }
        None => log::info!("meeting: cancelled (no recording buffered)"),
    }
    Ok(())
}

/// Tee the mic ("me") PCM through a [`ProsodyAnalyzer`](crate::audio::prosody::ProsodyAnalyzer)
/// for live delivery coaching, forwarding every chunk untouched downstream.
/// Mirrors the sample `counter` in [`run_metered_session`]: one extra `Vec` move
/// per chunk, no measurable STT impact.
///
/// This is the single mic tap point and it sits BEFORE the mixer, so with
/// diarization on we analyze raw mic — never the mixed/diarized stream (the
/// issue #22 hard constraint: delivery is scored on "me" only). `far` is the
/// counterpart's shared acoustic state (from [`spawn_farend_tap`]) used to
/// reject the far voice leaking through the SPEAKERS into the mic — without it,
/// a speakers-only setup scores the other side's pace/intonation as the user's.
fn spawn_mic_prosody_tap(
    app: &AppHandle,
    mut rx: UnboundedReceiver<Vec<i16>>,
    far: Option<std::sync::Arc<crate::audio::prosody::FarEndState>>,
) -> UnboundedReceiver<Vec<i16>> {
    let (tx, out_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
    let app = app.clone();
    // Also the feed point for the voice-typing mic tee (see MicTap): while a
    // dictation session is subscribed, every raw-mic chunk is cloned to it.
    let tap = app.state::<MicTap>().inner().clone();
    tap.source_started();
    tauri::async_runtime::spawn(async move {
        let mut analyzer = crate::audio::prosody::ProsodyAnalyzer::new(app, "me", far);
        while let Some(chunk) = rx.recv().await {
            analyzer.push(&chunk);
            tap.forward(&chunk);
            if tx.send(chunk).is_err() {
                break;
            }
        }
        tap.source_ended();
    });
    out_rx
}

/// Tee the system-audio ("them") PCM through a
/// [`FarEndAnalyzer`](crate::audio::prosody::FarEndAnalyzer) that feeds the
/// shared far-end state for speaker-bleed rejection, forwarding every chunk
/// untouched downstream. Counterpart of [`spawn_mic_prosody_tap`].
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn spawn_farend_tap(
    mut rx: UnboundedReceiver<Vec<i16>>,
    far: std::sync::Arc<crate::audio::prosody::FarEndState>,
) -> UnboundedReceiver<Vec<i16>> {
    let (tx, out_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
    tauri::async_runtime::spawn(async move {
        let mut analyzer = crate::audio::prosody::FarEndAnalyzer::new(far);
        while let Some(chunk) = rx.recv().await {
            analyzer.push(&chunk);
            if tx.send(chunk).is_err() {
                break;
            }
        }
    });
    out_rx
}

#[cfg(test)]
mod tests {
    use super::{encode_stopped, keep_leading, Stopped};

    #[test]
    fn a_stop_too_short_to_keep_is_not_encoded() {
        let out = encode_stopped(vec![0; 16_000], || panic!("no fallback for a blip"));
        assert!(matches!(out, Stopped::TooShort));
    }

    #[test]
    fn a_normal_stop_encodes_the_ram_recording() {
        let pcm: Vec<i16> = (0..48_000).map(|i| ((i % 64) * 200) as i16).collect();
        match encode_stopped(pcm, || panic!("the encode worked")) {
            Stopped::Saved(path, ms) => {
                assert_eq!(ms, 3_000);
                assert_eq!(&std::fs::read(&path).unwrap()[..4], b"OggS");
                let _ = std::fs::remove_file(path);
            }
            _ => panic!("expected a saved recording"),
        }
    }

    #[test]
    fn keep_leading_cuts_the_tail_at_the_requested_length() {
        // 3 s at 16 kHz, cut to the first 1.5 s.
        let pcm: Vec<i16> = (0..48_000).map(|i| (i % 100) as i16).collect();
        let kept = keep_leading(pcm.clone(), Some(1_500));
        assert_eq!(kept.len(), 24_000);
        assert_eq!(kept[..], pcm[..24_000]);
    }

    #[test]
    fn keep_leading_keeps_everything_without_a_cut_or_past_the_end() {
        let pcm = vec![1i16; 16_000];
        assert_eq!(keep_leading(pcm.clone(), None).len(), 16_000);
        assert_eq!(keep_leading(pcm.clone(), Some(5_000)).len(), 16_000);
    }
}
