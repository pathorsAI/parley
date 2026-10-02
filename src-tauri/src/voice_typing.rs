//! Voice typing: a lightweight push-to-talk dictation session that reuses the
//! meeting transcription stack (microphone -> one STT provider) but with none of
//! the meeting overhead (no diarization, no system-audio capture, no recording).
//!
//! It emits the same `transcript://segment` and `audio://level` events as a
//! meeting, tagged `source: "voice-typing"`, which the floating overlay window
//! renders. On release, the host copies the final text to the clipboard through
//! the OS (the webview can't, because Parley isn't the focused app) and — when
//! the user enabled it — synthesizes the paste chord into the frontmost app:
//! ⌘V on macOS, which needs Accessibility, or Ctrl+V on Windows, which needs no
//! permission but is refused by UIPI when the target window runs elevated.

// The `objc` 0.2 macros emit `cfg(cargo-clippy)` checks newer compilers warn on.
#![allow(unexpected_cfgs)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::audio::microphone::Microphone;
use crate::capture::{run_metered_session, spawn_capture, Begin, MicCoordinator, MicTap, MicUser};
use crate::commands::{read_config_file, write_config_file};
use crate::transcription::common::VOICE_TYPING_SOURCE;
use crate::transcription::{SttProvider, TranscribeConfig};

/// Grace for the post-release final flush, counted from the cut, before a
/// lingering session task is force-aborted (mirrors `stop_meeting`'s backstop).
/// It only cuts genuine zombies: the host stops waiting CLOSE_WAIT_MAX_MS
/// (6 s) after the release, and a healthy session that is merely never told
/// the stream is over ends itself first, DRAIN_READ_GRACE (7 s) after its
/// input drains — which, unlike this abort, still bills the audio and fires
/// `stt://closed`.
const FLUSH_ABORT_GRACE: Duration = Duration::from_secs(8);

/// Audio kept after key-up before the hard cut. People let go during the last
/// syllable's decay, and the recognizer needs a little trailing context to
/// close the last word — without it the word was dropped or misheard. Short of
/// a conversational turn gap, so a remark to someone after the release mostly
/// stays out. `Duration::ZERO` restores #128's exact-key-up cut.
const RELEASE_TAIL: Duration = Duration::from_millis(250);

/// Extra grace on top of the hosted single-session cap before the backend
/// force-stops the mic. The frontend caps and stops the session at exactly the
/// limit; this watchdog only fires when the webview never did (hung/crashed),
/// so it must not race the normal frontend stop.
const CAP_BACKEND_GRACE: Duration = Duration::from_secs(20);

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
}

/// How long the next start waits for the previous task to finish the poll it
/// was aborted in. A poll is one frame parse or one emit, so this only cuts a
/// task stuck in a bug; its stragglers carry the old session id and are dropped.
const RETIRE_GRACE: Duration = Duration::from_millis(300);

impl VoiceTypingState {
    /// Retire the previous task, then `announce` the next session id and
    /// return it. tokio's `abort()` lets a poll that is already running
    /// finish, so the task is awaited: anything it emits precedes the
    /// announcement.
    async fn open_session(&self, announce: impl FnOnce(u64)) -> u64 {
        let (session, previous) = {
            let mut vt = self.0.lock().unwrap();
            vt.session += 1;
            // The handles belong to the session being retired; until `adopt`
            // installs the new one's, a stop must find nothing to cut.
            vt.cutoff = None;
            vt.mic_gate = None;
            (vt.session, vt.task.take())
        };
        if let Some(task) = previous {
            task.abort();
            if tokio::time::timeout(RETIRE_GRACE, task).await.is_err() {
                log::warn!(
                    "voice-typing: session {} did not stop within {RETIRE_GRACE:?}",
                    session - 1
                );
            }
        }
        announce(session);
        session
    }

    fn adopt(
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
    fn is_capturing(&self, session: u64) -> bool {
        let vt = self.0.lock().unwrap();
        vt.session == session
            && vt
                .cutoff
                .as_ref()
                .is_some_and(|c| !c.load(Ordering::SeqCst))
    }

    /// The current session's id with its cutoff and mic gate, read under one
    /// lock so whatever cuts with them cuts that session and no other.
    fn handles(&self) -> (u64, Option<Arc<AtomicBool>>, Option<Arc<AtomicBool>>) {
        let vt = self.0.lock().unwrap();
        (vt.session, vt.cutoff.clone(), vt.mic_gate.clone())
    }

    fn abort_if_current(&self, session: u64) {
        let vt = self.0.lock().unwrap();
        if vt.session == session {
            if let Some(task) = vt.task.as_ref() {
                task.abort();
            }
        }
    }
}

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
/// overlay/clipboard commands, which do, stay synchronous.
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
    if api_key.trim().is_empty() {
        return Err("missing transcription API key".into());
    }
    let relay_endpoint = relay_url.filter(|u| !u.trim().is_empty());
    // Same guard as start_meeting: the hosted token only works via the relay.
    if provider == SttProvider::Parley && relay_endpoint.is_none() {
        return Err("hosted transcription requires the cloud relay URL".into());
    }
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
    };
    // Per-session cutoff: `stop_voice_typing` flips it to end the stream
    // RELEASE_TAIL after the key is released, before the mic thread even
    // notices the gate.
    let cutoff = Arc::new(AtomicBool::new(false));
    let task = run_metered_session(
        &app,
        provider,
        config,
        VOICE_TYPING_SOURCE,
        rx,
        None,
        "voicetyping://error",
        None,
        Some(cutoff.clone()),
        // Dictation is not pausable — and must keep working even while a live
        // meeting (whose mic it taps) is paused.
        None,
        Some(session),
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

/// Cut a session's audio: set its cutoff (the counter stops forwarding, which
/// closes the STT input and starts the final flush) and stop the capture it
/// opened — that capture only, by gate identity, so a cut that lands after a
/// quick re-press cannot stop the new dictation's mic. Returns whether a
/// capture was stopped. Blocking: stopping joins the capture threads with a
/// grace of up to 1.5 s, so async callers run it on the blocking pool.
fn cut_now(
    coord: &MicCoordinator,
    cutoff: Option<&Arc<AtomicBool>>,
    gate: Option<&Arc<AtomicBool>>,
) -> bool {
    if let Some(c) = cutoff {
        c.store(true, Ordering::SeqCst);
    }
    gate.is_some_and(|g| coord.stop_if(MicUser::VoiceTyping, g))
}

/// Name of the voice-typing history file (one JSON object per line) in the app
/// config dir.
const HISTORY_FILE: &str = "voice_typing_history.jsonl";

/// Append one history entry (a JSON line: `{ id, text, ts }`).
#[tauri::command]
pub fn append_voice_history(app: AppHandle, line: String) -> Result<(), String> {
    use std::io::Write;
    let path = crate::commands::app_config_file(&app, HISTORY_FILE)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())
}

/// Read the whole history file (empty string if none yet). The frontend parses
/// the JSONL and owns filtering for delete/clear (which write the file back).
#[tauri::command]
pub fn read_voice_history(app: AppHandle) -> Result<String, String> {
    read_config_file(&app, HISTORY_FILE)
}

/// Overwrite the history file (used by delete-one / clear-all).
#[tauri::command]
pub fn write_voice_history(app: AppHandle, content: String) -> Result<(), String> {
    write_config_file(&app, HISTORY_FILE, &content)
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
/// session task parked on its read half. DRAIN_READ_GRACE ends a healthy one
/// first; for anything else mirror `stop_meeting`'s direct-cancel safety net
/// and abort the task once the flush window has long passed. Guarded by the
/// session id so a backstop from THIS session can never abort a newer one
/// started during the grace.
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

/// Copy text to the system clipboard via the native pasteboard. Needed because
/// the webview's `navigator.clipboard` is blocked while Parley isn't focused.
#[tauri::command]
pub fn copy_to_clipboard(text: String) -> Result<(), String> {
    imp::copy_to_clipboard(&text)
}

/// Outcome of an auto-paste: whether the keystroke went out, and WHO it went to.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteResult {
    /// False when the keystroke could not be posted: on macOS because
    /// Accessibility isn't granted, on Windows because UIPI refused the
    /// injection (the target window belongs to an elevated process).
    pasted: bool,
    /// Identifier of the app that was frontmost at paste time, sampled BEFORE
    /// the paste chord so it names the app that actually received the text.
    /// The name is macOS's: there it is the bundle identifier (e.g.
    /// "com.apple.Notes"). Windows has no such thing, so it carries the
    /// foreground process's executable file name instead (e.g. "notepad.exe"),
    /// which is the closest stable per-app key available without permissions.
    /// `None` when there is no frontmost app, when it has no bundle id (some
    /// helper processes), when the process can't be opened (Windows: a target
    /// at a higher integrity level), or on a platform with neither.
    app_bundle_id: Option<String>,
}

/// Paste into the frontmost app by simulating ⌘V. Requires Accessibility.
/// Reports whether the keystroke was posted (never, when untrusted) and which
/// app received it — the dictionary's correction watcher needs to know which
/// app's field it is about to observe.
#[tauri::command]
pub fn paste_to_frontmost() -> PasteResult {
    // Sample the frontmost app FIRST: posting ⌘V can move focus (a paste that
    // opens a sheet, an app that activates on input), so reading it afterward
    // could name the wrong app.
    let app_bundle_id = imp::frontmost_bundle_id();
    PasteResult {
        pasted: imp::paste_to_frontmost(),
        app_bundle_id,
    }
}

/// Whether the app is trusted for Accessibility (needed for auto-paste).
/// When `prompt` is true, macOS shows the "grant Accessibility" dialog.
#[tauri::command]
pub fn accessibility_status(prompt: bool) -> bool {
    imp::accessibility_trusted(prompt)
}

/// Crate-internal Accessibility check (never prompts), used by hotkey.rs: an
/// ACTIVE CGEventTap runs under Accessibility even when Input Monitoring is
/// missing, so the push-to-talk tap consults both permissions. ax_observe reads
/// it for the same permission.
///
/// macOS-only, and deliberately so: both callers are the macOS event tap and
/// the macOS AX tree. It must NOT be reused as a general "may we auto-paste"
/// test, because off macOS `accessibility_trusted` answers a different question
/// — on Windows it returns true meaning "no permission is required", which says
/// nothing about whether a CGEventTap-shaped trigger could work.
#[cfg(target_os = "macos")]
pub(crate) fn is_accessibility_trusted() -> bool {
    imp::accessibility_trusted(false)
}

/// Pid of the frontmost app (the one voice typing pastes into), used by
/// ax_observe to scope its queries to that app. On macOS it comes from
/// NSWorkspace, not AX — works even when the target's accessibility tree is
/// still switched off.
///
/// On Windows it is the process owning the foreground window, which the UI
/// Automation watcher compares against the focused element's process id.
/// Compiled only where correction watching exists — a stub elsewhere would be a
/// dead-code warning with nothing to call it.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn frontmost_app_pid() -> Option<i32> {
    imp::frontmost_pid()
}

/// Show the overlay above ALL apps without activating Parley or stealing focus.
/// Driving visibility natively avoids Tauri's `show()`, which can bring Parley
/// to the front — and the front is exactly where it must not go, because the
/// user is dictating into another app's text field and the caret has to stay
/// there. macOS gets `orderFrontRegardless` + a floating level + all-spaces /
/// full-screen collection behaviour; Windows gets a non-activating topmost
/// `SetWindowPos` (see each platform's `imp::present_overlay`).
#[tauri::command]
pub fn present_voice_overlay(app: AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        if let Some(win) = app.get_webview_window("voice-typing") {
            if let Ok(ns) = win.ns_window() {
                imp::present_overlay(ns);
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(win) = app.get_webview_window("voice-typing") {
            if let Ok(hwnd) = win.hwnd() {
                imp::present_overlay(hwnd);
            }
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = app;
}

/// Keep a visible overlay in front of the user as they swipe between Spaces
/// (macOS Spaces; a no-op elsewhere). Installed once at setup.
pub fn install_space_observer(app: AppHandle) {
    #[cfg(target_os = "macos")]
    imp::install_space_observer(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Hide the overlay (`orderOut:` on macOS, `SW_HIDE` on Windows), the
/// counterpart to `present_voice_overlay`.
#[tauri::command]
pub fn dismiss_voice_overlay(app: AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        if let Some(win) = app.get_webview_window("voice-typing") {
            if let Ok(ns) = win.ns_window() {
                imp::dismiss_overlay(ns);
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(win) = app.get_webview_window("voice-typing") {
            if let Ok(hwnd) = win.hwnd() {
                imp::dismiss_overlay(hwnd);
            }
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = app;
}

#[cfg(target_os = "macos")]
mod imp {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;
    use objc::runtime::{Class, Object};
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::c_void;

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}

    // libobjc — reassign an instance's class (used to turn the wry NSWindow into
    // a non-activating NSPanel so it can float over full-screen Spaces).
    extern "C" {
        fn object_setClass(obj: *mut Object, cls: *const Class) -> *const Class;
    }

    type CGEventRef = *const c_void;
    type CFDictionaryRef = *const c_void;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventCreateKeyboardEvent(
            source: *const c_void,
            keycode: u16,
            keydown: bool,
        ) -> CGEventRef;
        fn CGEventSetFlags(event: CGEventRef, flags: u64);
        fn CGEventPost(tap: u32, event: CGEventRef);
        fn CGEventSourceFlagsState(state_id: i32) -> u64;
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
        static kAXTrustedCheckOptionPrompt: *const c_void;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
    }

    const KVK_ANSI_V: u16 = 9;
    const FLAG_COMMAND: u64 = 0x0010_0000; // kCGEventFlagMaskCommand
    const HID_EVENT_TAP: u32 = 0; // kCGHIDEventTap
    const HID_SYSTEM_STATE: i32 = 1; // kCGEventSourceStateHIDSystemState
    /// Shift, Control, Option, Command and fn (kCGEventFlagMask*).
    const MODIFIER_FLAGS: u64 = 0x0002_0000 | 0x0004_0000 | 0x0008_0000 | 0x0010_0000 | 0x0080_0000;

    /// NSPasteboard generalPasteboard -> clearContents -> setString:forType:.
    /// CFString is toll-free bridged to NSString, so we pass it straight through.
    pub fn copy_to_clipboard(text: &str) -> Result<(), String> {
        unsafe {
            let pb: *mut Object = msg_send![class!(NSPasteboard), generalPasteboard];
            if pb.is_null() {
                return Err("no general pasteboard".into());
            }
            let _: i64 = msg_send![pb, clearContents];
            let value = CFString::new(text);
            let value_obj = value.as_concrete_TypeRef() as *const Object;
            // NSPasteboardTypeString's UTI; avoids linking the extern NSString const.
            let ty = CFString::new("public.utf8-plain-text");
            let ty_obj = ty.as_concrete_TypeRef() as *const Object;
            let ok: bool = msg_send![pb, setString: value_obj forType: ty_obj];
            if ok {
                Ok(())
            } else {
                Err("pasteboard rejected string".into())
            }
        }
    }

    /// Bundle identifier of the frontmost application, via
    /// `NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier`.
    /// `None` when nothing is frontmost or the app has no bundle id (which some
    /// helper/agent processes genuinely don't). Needs no permission — unlike the
    /// AX APIs, NSWorkspace's app list is not TCC-gated.
    pub fn frontmost_bundle_id() -> Option<String> {
        unsafe {
            let workspace: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
            if workspace.is_null() {
                return None;
            }
            let app: *mut Object = msg_send![workspace, frontmostApplication];
            if app.is_null() {
                return None;
            }
            // NSString is toll-free bridged to CFString, so we can read it
            // through core-foundation instead of hand-rolling UTF-8 extraction.
            let bundle_id: *const Object = msg_send![app, bundleIdentifier];
            if bundle_id.is_null() {
                return None;
            }
            // `bundleIdentifier` is a +0 (autoreleased) getter, so take a get-rule
            // reference — wrapping it under the create rule would over-release.
            let s = CFString::wrap_under_get_rule(bundle_id as _);
            Some(s.to_string())
        }
    }

    /// `NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier` —
    /// same no-permission-needed source as `frontmost_bundle_id`.
    pub fn frontmost_pid() -> Option<i32> {
        unsafe {
            let workspace: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
            if workspace.is_null() {
                return None;
            }
            let app: *mut Object = msg_send![workspace, frontmostApplication];
            if app.is_null() {
                return None;
            }
            let pid: i32 = msg_send![app, processIdentifier];
            (pid > 0).then_some(pid)
        }
    }

    pub fn paste_to_frontmost() -> bool {
        if !accessibility_trusted(false) {
            return false;
        }
        unsafe {
            // A quick re-press pastes the previous dictation while the trigger
            // (⌥Space, or a held right-modifier) is still physically down.
            // Windows lifts held modifiers before its Ctrl+V; here only the
            // Command flag is set on the posted events, and whether the window
            // server folds a held ⌥ into them is unverified. Logged only when
            // something is held, so an ordinary paste stays quiet.
            let held = CGEventSourceFlagsState(HID_SYSTEM_STATE) & MODIFIER_FLAGS;
            if held != 0 {
                log::info!("voice-typing: pasting with modifiers held (flags {held:#x})");
            }
            let down = CGEventCreateKeyboardEvent(std::ptr::null(), KVK_ANSI_V, true);
            let up = CGEventCreateKeyboardEvent(std::ptr::null(), KVK_ANSI_V, false);
            if down.is_null() || up.is_null() {
                return false;
            }
            CGEventSetFlags(down, FLAG_COMMAND);
            CGEventSetFlags(up, FLAG_COMMAND);
            CGEventPost(HID_EVENT_TAP, down);
            CGEventPost(HID_EVENT_TAP, up);
            CFRelease(down);
            CFRelease(up);
            true
        }
    }

    /// NSScreenSaverWindowLevel — high enough to float above native full-screen
    /// apps (a popup-menu level is not).
    const OVERLAY_WINDOW_LEVEL: isize = 1000;
    /// canJoinAllSpaces (1<<0) | stationary (1<<4) | ignoresCycle (1<<6) |
    /// fullScreenAuxiliary (1<<8): show on whatever Space is active, including
    /// over a full-screen app, without joining window cycling.
    const OVERLAY_COLLECTION_BEHAVIOR: usize = (1 << 0) | (1 << 4) | (1 << 6) | (1 << 8);
    /// NSWindowStyleMaskNonactivatingPanel — the panel shows without activating
    /// Parley or stealing focus.
    const NONACTIVATING_PANEL: usize = 1 << 7;

    pub fn present_overlay(ns_window: *mut std::ffi::c_void) {
        unsafe {
            let w = ns_window as *mut Object;
            // A plain NSWindow gets isolated to its own Space and can't float over
            // another app's full-screen Space. Turning it into a non-activating
            // NSPanel (+ fullScreenAuxiliary) is the native pattern for overlays.
            // Keyed off the window's own class — a process-wide one-shot flag
            // would skip the conversion forever if the overlay window is ever
            // destroyed and recreated.
            let is_panel: bool = msg_send![w, isKindOfClass: class!(NSPanel)];
            if !is_panel {
                object_setClass(w, class!(NSPanel) as *const Class);
                let style: usize = msg_send![w, styleMask];
                let _: () = msg_send![w, setStyleMask: style | NONACTIVATING_PANEL];
                // Only take key status when a view genuinely needs it — none
                // here does, and the panel is borderless, so it never asks.
                let _: () = msg_send![w, setBecomesKeyOnlyIfNeeded: true];
                // Once per window: a recreated overlay starts as a TaoWindow
                // again and comes back through this branch.
                prevent_activation(w);
                let _: () = msg_send![w, setFloatingPanel: true];
                let _: () = msg_send![w, setHidesOnDeactivate: false];
            }
            let _: () = msg_send![w, setCollectionBehavior: OVERLAY_COLLECTION_BEHAVIOR];
            let _: () = msg_send![w, setLevel: OVERLAY_WINDOW_LEVEL];
            let _: () = msg_send![w, orderFrontRegardless];
            // canJoinAllSpaces alone isn't enough over a long-running session:
            // see spaces::rejoin_all for why the flag and the window server's
            // actual placement drift apart.
            spaces::rejoin_all(w);
        }
        log::info!("voice-typing: overlay presented (panel)");
    }

    /// `-setStyleMask:` never propagates NSWindowStyleMaskNonactivatingPanel to
    /// the activation flag AppKit sets only in NSPanel's own init (Wine's
    /// cocoa_window.m documents the same bug), so a mouse-down on this converted
    /// panel activated Parley: the menu bar switched, the main window came
    /// forward, and the ⌘V that followed the release landed in Parley instead
    /// of the field the user was dictating into. `_setPreventsActivation:` is
    /// the private funnel the native init uses. It is idempotent and later
    /// style-mask changes do not reset it. Guarded like the CGS calls in
    /// `spaces`: a future macOS without it logs a warning instead of crashing.
    /// The read-back puts the outcome in parley.log, so a report of "clicking
    /// the overlay brings Parley up" can be checked against it.
    unsafe fn prevent_activation(w: *mut Object) {
        let responds: bool = msg_send![w, respondsToSelector: sel!(_setPreventsActivation:)];
        if !responds {
            log::warn!(
                "voice-typing: _setPreventsActivation: unavailable; overlay clicks may activate Parley"
            );
            return;
        }
        let _: () = msg_send![w, _setPreventsActivation: true];
        let can_read: bool = msg_send![w, respondsToSelector: sel!(_preventsActivation)];
        if can_read {
            let on: bool = msg_send![w, _preventsActivation];
            log::info!("voice-typing: overlay panel preventsActivation={on}");
        }
    }

    /// Re-home the overlay whenever the active Space changes (a trackpad swipe,
    /// Ctrl+←/→, Mission Control) while it is on screen. The present-time
    /// rejoin covers every Space that existed when the dictation began; this
    /// covers the rest, e.g. an app entering full screen mid-dictation, so
    /// swiping to any Space mid-sentence keeps the overlay in front of the user.
    pub fn install_space_observer(app: tauri::AppHandle) {
        use block2::RcBlock;
        use tauri::Manager;
        unsafe {
            let ws: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
            let nc: *mut Object = msg_send![ws, notificationCenter];
            let queue: *mut Object = msg_send![class!(NSOperationQueue), mainQueue];
            let block = RcBlock::<dyn Fn(*mut c_void)>::new(move |_note| {
                let Some(win) = app.get_webview_window("voice-typing") else {
                    return;
                };
                let Ok(ns) = win.ns_window() else {
                    return;
                };
                let w = ns as *mut Object;
                let visible: bool = msg_send![w, isVisible];
                if !visible {
                    return; // idle — the next present rejoins anyway
                }
                spaces::rejoin_all(w);
                let _: () = msg_send![w, orderFrontRegardless];
            });
            let name = CFString::new("NSWorkspaceActiveSpaceDidChangeNotification");
            let name_obj = name.as_concrete_TypeRef() as *const Object;
            let nil: *mut Object = std::ptr::null_mut();
            let _observer: *mut Object = msg_send![nc, addObserverForName: name_obj object: nil queue: queue usingBlock: &*block];
            // Never removed — the center keeps the observer + block alive for
            // the app's lifetime; forget our handle so it isn't dropped under it.
            std::mem::forget(block);
        }
    }

    /// Keeping the overlay a member of every Space.
    ///
    /// `canJoinAllSpaces` is supposed to make the window server show the
    /// overlay on every Space. It does when the flag is first applied, but in a
    /// long-running session the window server's actual placement drifts away
    /// from it: a Parley that had been up for days had its overlay attached to
    /// just the desktop Space and the one full-screen Space it was last shown
    /// on, while the flag still read canJoinAllSpaces. Swiping to any other
    /// full-screen app then left the overlay behind on Parley's Space. Nothing
    /// public repairs that in place — re-applying the same collection
    /// behaviour, clearing and re-setting it, round-tripping it through
    /// moveToActiveSpace, re-ordering the window or changing its level all
    /// leave the placement as it is — and recreating the window mid-dictation
    /// would lose the transcript the overlay has already rendered.
    ///
    /// So we reconcile the placement directly: ask the window server which
    /// Spaces exist and which ones the overlay is on, and add it to the rest.
    /// These are SkyLight's private CGS calls (the same ones window managers
    /// use), so they are looked up at runtime with `dlsym` rather than linked:
    /// if a future macOS drops or renames one, the lookup fails and this
    /// becomes a no-op, rather than dyld refusing to launch the app over a
    /// missing symbol.
    mod spaces {
        use core_foundation::array::{CFArray, CFArrayRef};
        use core_foundation::base::{CFType, TCFType};
        use core_foundation::dictionary::CFDictionary;
        use core_foundation::number::CFNumber;
        use core_foundation::string::CFString;
        use objc::runtime::Object;
        use objc::{msg_send, sel, sel_impl};
        use std::collections::BTreeSet;
        use std::ffi::{c_char, c_void};
        use std::sync::OnceLock;

        extern "C" {
            fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
        }
        /// `RTLD_DEFAULT` on Darwin: search every image already loaded (AppKit
        /// pulls in SkyLight, which exports the CGS symbols).
        const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;
        /// kCGSAllSpacesMask — user, full-screen and system Spaces alike.
        const ALL_SPACES_MASK: i32 = 0x7;

        type MainConnectionFn = unsafe extern "C" fn() -> i32;
        type CopyManagedDisplaySpacesFn = unsafe extern "C" fn(i32) -> CFArrayRef;
        type CopySpacesForWindowsFn = unsafe extern "C" fn(i32, i32, CFArrayRef) -> CFArrayRef;
        type AddWindowsToSpacesFn = unsafe extern "C" fn(i32, CFArrayRef, CFArrayRef);

        struct Api {
            main_connection: MainConnectionFn,
            copy_managed_display_spaces: CopyManagedDisplaySpacesFn,
            copy_spaces_for_windows: CopySpacesForWindowsFn,
            add_windows_to_spaces: AddWindowsToSpacesFn,
        }

        fn api() -> Option<&'static Api> {
            static API: OnceLock<Option<Api>> = OnceLock::new();
            API.get_or_init(|| unsafe {
                let sym = |name: &[u8]| dlsym(RTLD_DEFAULT, name.as_ptr() as *const c_char);
                let main = sym(b"CGSMainConnectionID\0");
                let managed = sym(b"CGSCopyManagedDisplaySpaces\0");
                let for_windows = sym(b"CGSCopySpacesForWindows\0");
                let add = sym(b"CGSAddWindowsToSpaces\0");
                if [main, managed, for_windows, add].iter().any(|p| p.is_null()) {
                    log::warn!("voice-typing: CGS Spaces API unavailable; overlay Space repair disabled");
                    return None;
                }
                Some(Api {
                    main_connection: std::mem::transmute::<*mut c_void, MainConnectionFn>(main),
                    copy_managed_display_spaces: std::mem::transmute::<
                        *mut c_void,
                        CopyManagedDisplaySpacesFn,
                    >(managed),
                    copy_spaces_for_windows: std::mem::transmute::<
                        *mut c_void,
                        CopySpacesForWindowsFn,
                    >(for_windows),
                    add_windows_to_spaces: std::mem::transmute::<*mut c_void, AddWindowsToSpacesFn>(
                        add,
                    ),
                })
            })
            .as_ref()
        }

        /// Items of a CF array we got under the create rule, as owned CFTypes.
        unsafe fn items(raw: CFArrayRef) -> Vec<CFType> {
            if raw.is_null() {
                return Vec::new();
            }
            let arr: CFArray<*const c_void> = CFArray::wrap_under_create_rule(raw);
            arr.iter().map(|p| CFType::wrap_under_get_rule(*p)).collect()
        }

        /// `dict[key]` for an untyped CF dictionary.
        fn value(dict: &CFType, key: &CFString) -> Option<CFType> {
            let dict = dict.downcast::<CFDictionary>()?;
            let v = dict.find(key.as_CFTypeRef())?;
            Some(unsafe { CFType::wrap_under_get_rule(*v) })
        }

        fn as_i64(v: &CFType) -> Option<i64> {
            v.downcast::<CFNumber>()?.to_i64()
        }

        /// Every Space the window server manages, across all displays
        /// (`[{ "Spaces": [{ "ManagedSpaceID": n, … }], … }]`).
        unsafe fn all_space_ids(api: &Api, cid: i32) -> BTreeSet<i64> {
            let spaces_key = CFString::from_static_string("Spaces");
            let id_key = CFString::from_static_string("ManagedSpaceID");
            let mut ids = BTreeSet::new();
            for display in items((api.copy_managed_display_spaces)(cid)) {
                let Some(spaces) = value(&display, &spaces_key) else {
                    continue;
                };
                let Some(spaces) = spaces.downcast::<CFArray>() else {
                    continue;
                };
                for space in spaces.iter() {
                    let space = CFType::wrap_under_get_rule(*space);
                    if let Some(id) = value(&space, &id_key).as_ref().and_then(as_i64) {
                        ids.insert(id);
                    }
                }
            }
            ids
        }

        /// Add the window to any Space it's missing from. Cheap when nothing is
        /// missing (two window-server queries), so it can run on every present.
        pub unsafe fn rejoin_all(w: *mut Object) {
            let Some(api) = api() else {
                return;
            };
            let wid: i64 = msg_send![w, windowNumber];
            if wid <= 0 {
                return; // no window-server window yet
            }
            let cid = (api.main_connection)();
            let all = all_space_ids(api, cid);
            if all.is_empty() {
                return;
            }
            let wids = CFArray::from_CFTypes(&[CFNumber::from(wid)]);
            let on: BTreeSet<i64> = items((api.copy_spaces_for_windows)(
                cid,
                ALL_SPACES_MASK,
                wids.as_concrete_TypeRef(),
            ))
            .iter()
            .filter_map(as_i64)
            .collect();
            let missing: Vec<CFNumber> = all.difference(&on).map(|&id| CFNumber::from(id)).collect();
            if missing.is_empty() {
                return;
            }
            log::info!(
                "voice-typing: overlay was on {} of {} Spaces; rejoining the other {}",
                on.len(),
                all.len(),
                missing.len()
            );
            let missing = CFArray::from_CFTypes(&missing);
            (api.add_windows_to_spaces)(cid, wids.as_concrete_TypeRef(), missing.as_concrete_TypeRef());
        }
    }

    pub fn dismiss_overlay(ns_window: *mut std::ffi::c_void) {
        unsafe {
            let w = ns_window as *mut Object;
            let nil: *mut Object = std::ptr::null_mut();
            let _: () = msg_send![w, orderOut: nil];
        }
    }

    pub fn accessibility_trusted(prompt: bool) -> bool {
        unsafe {
            if !prompt {
                let dict: CFDictionaryRef = std::ptr::null();
                return AXIsProcessTrustedWithOptions(dict);
            }
            // Build { kAXTrustedCheckOptionPrompt: true } so macOS shows the dialog.
            use core_foundation::boolean::CFBoolean;
            use core_foundation::dictionary::CFDictionary;
            let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt as _);
            let value = CFBoolean::true_value();
            let dict = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), value.as_CFType())]);
            AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef() as CFDictionaryRef)
        }
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, GlobalFree, HANDLE, HWND};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
        KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN,
        VK_SHIFT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowLongPtrW, GetWindowThreadProcessId, SetWindowLongPtrW,
        SetWindowPos, ShowWindow, GWL_EXSTYLE, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE, SWP_SHOWWINDOW, SW_HIDE, SW_SHOWNA, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    /// `CF_UNICODETEXT`, spelled out rather than imported from
    /// `Win32::System::Ole` so one 16-bit constant doesn't drag the whole OLE
    /// feature (and its compile time) into the build.
    const CF_UNICODETEXT: u32 = 13;

    /// `OpenClipboard` does not queue: it fails outright while another process
    /// holds the clipboard, and something briefly does all the time (the app
    /// the user just copied from, a clipboard manager sampling the change).
    /// A dictation ends with a copy that MUST land — the clipboard is the only
    /// copy of what the user just said — so a lost race is retried rather than
    /// reported.
    const CLIPBOARD_OPEN_ATTEMPTS: u32 = 5;
    const CLIPBOARD_OPEN_RETRY: std::time::Duration = std::time::Duration::from_millis(20);

    /// Virtual key for "V". Win32 declares no `VK_V`: the letter keys' virtual
    /// codes are just their ASCII uppercase values.
    const VK_V: VIRTUAL_KEY = VIRTUAL_KEY(0x56);

    /// The high bit of `GetAsyncKeyState`'s result means "physically down right
    /// now". The low bit is the unrelated "was pressed since the last call"
    /// flag, which we must not confuse for a held key.
    const KEY_DOWN_MASK: u16 = 0x8000;

    /// Publish `text` on the clipboard as `CF_UNICODETEXT`.
    ///
    /// The Win32 clipboard is a process-wide lock, not an object: between the
    /// `OpenClipboard` and the `CloseClipboard` below, no other process on the
    /// desktop can copy or paste. Every exit path therefore has to close it.
    pub fn copy_to_clipboard(text: &str) -> Result<(), String> {
        // CF_UNICODETEXT is a NUL-terminated wide string: consumers read up to
        // the terminator, not to the allocation's length, so the terminator is
        // part of the payload rather than an afterthought.
        let mut utf16: Vec<u16> = text.encode_utf16().collect();
        utf16.push(0);

        open_clipboard()?;
        let result = write_unicode_text(&utf16);
        // SAFETY: `open_clipboard` returned Ok, so this thread owns the
        // clipboard, and this is the single matching close on every path out.
        unsafe {
            let _ = CloseClipboard();
        }
        result
    }

    /// Take the clipboard, retrying briefly while another process holds it (see
    /// [`CLIPBOARD_OPEN_ATTEMPTS`]). Passing no owner window is deliberate: we
    /// have no HWND worth associating and want no clipboard notifications.
    fn open_clipboard() -> Result<(), String> {
        let mut last = String::new();
        for attempt in 0..CLIPBOARD_OPEN_ATTEMPTS {
            // SAFETY: takes nothing from us and owns nothing of ours; the only
            // state it changes is the global clipboard lock, released by the
            // `CloseClipboard` in `copy_to_clipboard`.
            match unsafe { OpenClipboard(None) } {
                Ok(()) => return Ok(()),
                Err(e) => {
                    last = e.to_string();
                    if attempt + 1 < CLIPBOARD_OPEN_ATTEMPTS {
                        std::thread::sleep(CLIPBOARD_OPEN_RETRY);
                    }
                }
            }
        }
        Err(format!("clipboard is held by another process: {last}"))
    }

    /// Write an already NUL-terminated UTF-16 string to the open clipboard.
    ///
    /// The ownership rule this function exists to get right: on SUCCESS
    /// `SetClipboardData` takes the memory block and the OS frees it later, so
    /// freeing it here would leave every subsequent paste reading freed memory.
    /// On FAILURE the transfer never happened and the block is still ours, so
    /// NOT freeing it leaks a global allocation on every dictation.
    fn write_unicode_text(utf16: &[u16]) -> Result<(), String> {
        // SAFETY: the clipboard is open on this thread. `EmptyClipboard` frees
        // only handles the clipboard already owns; ours isn't published yet.
        unsafe { EmptyClipboard() }.map_err(|e| format!("EmptyClipboard failed: {e}"))?;

        let bytes = std::mem::size_of_val(utf16);
        // GMEM_MOVEABLE is required, not preferred: `SetClipboardData` rejects
        // fixed memory, because the OS takes ownership and may relocate it.
        // SAFETY: a plain allocation request; the returned handle is either
        // handed to the OS below or freed on each failure path.
        let hglobal =
            unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes) }.map_err(|e| format!("GlobalAlloc failed: {e}"))?;

        // SAFETY: `hglobal` is a live moveable block of exactly `bytes` bytes
        // that we just allocated and to which nobody else holds a pointer, so
        // locking it and writing `utf16` into it cannot overlap another object
        // or overrun the allocation.
        unsafe {
            let dst = GlobalLock(hglobal);
            if dst.is_null() {
                let _ = GlobalFree(Some(hglobal));
                return Err("GlobalLock failed".into());
            }
            std::ptr::copy_nonoverlapping(utf16.as_ptr(), dst.cast::<u16>(), utf16.len());
            // `GlobalUnlock` returns FALSE *on success* when the lock count
            // reaches zero (with a last-error of NO_ERROR), so the `windows`
            // wrapper hands back an Err on the normal path. Nothing to check.
            let _ = GlobalUnlock(hglobal);
        }

        // SAFETY: the clipboard is open on this thread and `hglobal` is a valid
        // moveable block holding a NUL-terminated UTF-16 string, which is what
        // CF_UNICODETEXT promises its readers.
        match unsafe { SetClipboardData(CF_UNICODETEXT, Some(HANDLE(hglobal.0))) } {
            // Ownership has moved to the OS — do NOT free.
            Ok(_) => Ok(()),
            Err(e) => {
                // The transfer did not happen, so the block is still ours.
                // SAFETY: `SetClipboardData` failed, so the OS did not take
                // `hglobal`, and nothing else holds it. (`GlobalFree` reports
                // success by returning NULL, which the `windows` wrapper maps
                // to Err, so its result is not worth inspecting either.)
                unsafe {
                    let _ = GlobalFree(Some(hglobal));
                }
                Err(format!("SetClipboardData failed: {e}"))
            }
        }
    }

    /// One keyboard `INPUT` record for `SendInput`.
    fn key_event(vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    /// Paste into the foreground window by synthesizing Ctrl+V. Needs no
    /// permission (see [`accessibility_trusted`]); returns false only when the
    /// OS refused the injection.
    pub fn paste_to_frontmost() -> bool {
        let mut events: Vec<INPUT> = Vec::new();

        // Push-to-talk normally ends with the trigger's own modifiers STILL
        // physically held: the user lets go of Ctrl+Alt+Space a beat after the
        // release that starts this paste. Modifier state is global, so a Ctrl+V
        // injected underneath a held Alt or Shift is not delivered as Ctrl+V at
        // all — the target sees Ctrl+Alt+V or Ctrl+Shift+V, which pastes
        // nothing and may fire some unrelated command in that app. Injecting a
        // key-UP for each modifier that is actually down clears the state
        // first; the user's own physical release afterwards is then a harmless
        // second key-up. Ctrl is deliberately absent from this list: it is part
        // of the chord we are about to send.
        for vk in [VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN] {
            // SAFETY: `GetAsyncKeyState` only reads global keyboard state.
            let state = unsafe { GetAsyncKeyState(vk.0 as i32) };
            if (state as u16) & KEY_DOWN_MASK != 0 {
                events.push(key_event(vk, KEYEVENTF_KEYUP));
            }
        }

        events.push(key_event(VK_CONTROL, KEYBD_EVENT_FLAGS(0)));
        events.push(key_event(VK_V, KEYBD_EVENT_FLAGS(0)));
        events.push(key_event(VK_V, KEYEVENTF_KEYUP));
        events.push(key_event(VK_CONTROL, KEYEVENTF_KEYUP));

        // SAFETY: `events` is a live slice of fully-initialised INPUT values and
        // the size we pass is the matching element size, which is the whole of
        // SendInput's contract (a wrong size is how this call gets misused).
        let sent = unsafe { SendInput(&events, std::mem::size_of::<INPUT>() as i32) };
        if sent as usize != events.len() {
            // `SendInput` reports how many events it actually injected and stops
            // at the first one that is blocked. In practice "blocked" means
            // UIPI: the foreground window belongs to a process running at a
            // higher integrity level (anything started with "Run as
            // administrator"), and a non-elevated Parley is simply not allowed
            // to send it input. UIPI refuses the whole call rather than part of
            // it, so the usual reading of this branch is `sent == 0` and the
            // target is not left holding a half-pressed chord. A partial count
            // would mean something else ate the tail (a filter driver, a
            // low-level hook), and re-injecting a Ctrl key-up to tidy up would
            // travel the same blocked path — so we log what we saw rather than
            // pretend to repair it. Either way the caller falls back to
            // clipboard-only: the text is already on the clipboard, the user
            // just presses Ctrl+V.
            log::warn!(
                "voice-typing: SendInput injected {sent}/{} events; the foreground window is probably elevated (UIPI)",
                events.len()
            );
            return false;
        }
        true
    }

    /// Process id owning the foreground window. `None` when nothing is
    /// foreground (a locked desktop, or a switch in flight).
    fn foreground_pid() -> Option<u32> {
        // SAFETY: reads global window-manager state; returns a null HWND rather
        // than failing when no window is foreground.
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_invalid() {
            return None;
        }
        let mut pid: u32 = 0;
        // SAFETY: `pid` is a live local and the call writes exactly one u32 to
        // it. We want the process, not the thread id it returns.
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32)) };
        (pid != 0).then_some(pid)
    }

    /// The foreground process id in the shape UI Automation reports
    /// (`CurrentProcessId` is an `i32`), for the correction watcher.
    pub fn frontmost_pid() -> Option<i32> {
        foreground_pid().and_then(|pid| i32::try_from(pid).ok())
    }

    /// File name of the foreground window's executable, e.g. "notepad.exe".
    ///
    /// Windows has no bundle identifier, so this fills the `app_bundle_id` slot
    /// with the closest stable per-app key that costs no permission. `None`
    /// when nothing is foreground (a locked desktop, or a switch in flight) or
    /// when the process can't be opened — for a target at a higher integrity
    /// level that refusal is the normal answer, not a malfunction.
    pub fn frontmost_bundle_id() -> Option<String> {
        let pid = foreground_pid()?;
        // PROCESS_QUERY_LIMITED_INFORMATION is the weakest right that answers
        // this question, and the only one granted across integrity levels.
        // SAFETY: opens a process by pid; the handle is closed on every path
        // below, because one leaked per dictation would pin another process's
        // kernel object for as long as Parley runs.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;

        // MAX_PATH is NOT the bound here: `QueryFullProcessImageNameW` can
        // return an extended-length path of up to ~32k wide characters, and a
        // short buffer fails the call outright rather than truncating.
        let mut buf = vec![0u16; 32768];
        let mut len = buf.len() as u32;
        // SAFETY: `handle` is a live process handle, and `buf` / `len` describe
        // the same buffer — the call fills it and writes back the length used.
        let queried = unsafe {
            QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len)
        };
        // SAFETY: `handle` came from `OpenProcess` above and is closed once,
        // before the result is interpreted so no early return can skip it.
        unsafe {
            let _ = CloseHandle(handle);
        }
        queried.ok()?;

        let path = String::from_utf16_lossy(&buf[..len as usize]);
        // Only the file name: the full path is noise for the caller and would
        // put the user's directory layout into the dictation history.
        path.rsplit(['\\', '/'])
            .next()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    }

    /// Windows has no permission gate for synthesizing input: any process may
    /// `SendInput` to a window at its own or a lower integrity level, so the
    /// honest answer to "may we auto-paste" is yes, and the settings UI has no
    /// permission to send the user chasing.
    ///
    /// The one case that IS refused — an elevated foreground window, blocked by
    /// UIPI — is not a permission anyone can grant and can't be known before
    /// the attempt, so [`paste_to_frontmost`] reports it per paste instead.
    pub fn accessibility_trusted(_prompt: bool) -> bool {
        true
    }

    /// Show the overlay above everything else WITHOUT taking focus.
    ///
    /// Not stealing focus is the entire requirement: the user is dictating into
    /// another app's text field, and a window that activates on show moves the
    /// caret out of it — the Ctrl+V that follows would then paste into Parley's
    /// own overlay instead of the document. Three things enforce that, and all
    /// three are applied here rather than at creation because Tauri's window
    /// builder exposes none of them:
    ///
    ///   - `WS_EX_NOACTIVATE` — the window cannot become the active window.
    ///   - `WS_EX_TOOLWINDOW` — it stays out of Alt+Tab and the taskbar.
    ///   - `SetWindowPos(HWND_TOPMOST, …, SWP_NOACTIVATE)` — floats it above
    ///     other windows. Tauri's `alwaysOnTop` is deliberately NOT used for
    ///     this: its implementation activates the window, which is the one
    ///     thing we are avoiding.
    ///
    /// Never call one of tao's window-flag setters on this window at runtime —
    /// `setFocusable`, `setAlwaysOnTop`, `setResizable`, `setIgnoreCursorEvents`
    /// and the like. The window is created hidden and shown natively here, so
    /// tao's own VISIBLE flag stays false, and any setter whose change is not
    /// empty runs tao's `apply_diff`: that calls `ShowWindow(SW_HIDE)` (the
    /// overlay vanishes mid-dictation) and rewrites GWL_EXSTYLE wholesale from
    /// tao's flags, which model neither WS_EX_TOOLWINDOW nor, for a window
    /// created focusable, WS_EX_NOACTIVATE. Creation-time options are fine —
    /// overlay.ts sets `focusable: false`, so tao applies WS_EX_NOACTIVATE
    /// from the start and keeps it through its own style recomputes.
    pub fn present_overlay(hwnd: HWND) {
        // SAFETY: `hwnd` is the live overlay window and these commands run on
        // the thread that owns it (Tauri dispatches synchronous commands on the
        // main thread), so the style read-modify-write below cannot race
        // another thread's write, and every call touches only this window.
        unsafe {
            // Read-modify-write, never a bare assignment: wry sets its own
            // extended styles on this window and clobbering them breaks the
            // webview.
            let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            let wanted = current | WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0;
            if wanted != current {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, wanted as _);
            }
            // SW_SHOWNA is "show, no activate" — SW_SHOW would activate.
            let _ = ShowWindow(hwnd, SW_SHOWNA);
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
            );
        }
        log::info!("voice-typing: overlay presented (topmost, non-activating)");
    }

    /// Hide the overlay. `SW_HIDE` never changes activation, so the app the
    /// user was dictating into keeps focus on the way out too.
    pub fn dismiss_overlay(hwnd: HWND) {
        // SAFETY: `hwnd` is the live overlay window, owned by this thread;
        // ShowWindow only changes that one window's visibility.
        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    pub fn copy_to_clipboard(_text: &str) -> Result<(), String> {
        Err("clipboard only implemented on macOS and Windows".into())
    }
    pub fn paste_to_frontmost() -> bool {
        false
    }
    pub fn frontmost_bundle_id() -> Option<String> {
        None
    }
    pub fn accessibility_trusted(_prompt: bool) -> bool {
        false
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
