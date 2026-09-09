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

use tauri::{AppHandle, Manager, State};

use crate::audio::microphone::Microphone;
use crate::capture::{run_metered_session, spawn_capture, Begin, MicCoordinator, MicTap, MicUser};
use crate::commands::{read_config_file, write_config_file};
use crate::transcription::{SttProvider, TranscribeConfig};

/// Grace for the post-release final flush before a lingering session task is
/// force-aborted (mirrors `stop_meeting`'s backstop). The frontend waits at
/// most ~3 s for the flush, so 8 s cuts only genuine zombies.
const FLUSH_ABORT_GRACE: std::time::Duration = std::time::Duration::from_secs(8);

/// Extra grace on top of the hosted single-session cap before the backend
/// force-stops the mic. The frontend caps and stops the session at exactly the
/// limit; this watchdog only fires when the webview never did (hung/crashed),
/// so it must not race the normal frontend stop.
const CAP_BACKEND_GRACE: std::time::Duration = std::time::Duration::from_secs(20);

/// Singleton guard for the voice-typing STT session task. [`MicCoordinator`]
/// already guarantees at most one CAPTURE, but the session task it feeds (the
/// provider WebSocket) used to be fire-and-forget: after release it lingers to
/// flush the final tokens, and a server that never closes leaves it parked
/// forever with an open socket. Each new press then opened ANOTHER socket
/// while the old session kept emitting into the same `voice-typing-{n}` /
/// `voice-typing-tail` segment-id namespace — the overlay showed both
/// sessions' tokens interleaved (transcript "stacking"). This state pins the
/// one live task so a new start aborts the old socket first and a stop bounds
/// its flush.
#[derive(Default)]
pub struct VoiceTypingState(Arc<Mutex<VtInner>>);

#[derive(Default)]
struct VtInner {
    /// Bumped on every start; stale backstops/starts compare against it so
    /// they can never abort a NEWER session than the one they belong to.
    seq: u64,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    /// The current session's audio cutoff. `stop_voice_typing` sets it to hard
    /// cut the stream on release so nothing said after the key is let go is
    /// transcribed (see `run_metered_session`). Replaced each start.
    cutoff: Option<Arc<AtomicBool>>,
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
    // claim left by a desynced frontend (no-op when idle), and abort the
    // previous session task outright — if it is still flushing, its late
    // tokens would interleave with the new session's in the overlay, and its
    // socket must close before we open the next one. Aborting a finished task
    // is a no-op. Trade-off: aborting a mid-flush session also drops its
    // `usage://stt` emit, undercounting the local cost display for that
    // session's last seconds — acceptable (relay billing is server-side, and
    // the alternative is the transcript stacking this fixes).
    coord.stop(MicUser::VoiceTyping);
    let my_seq = {
        let mut vt = state.0.lock().unwrap();
        vt.seq += 1;
        if let Some(task) = vt.task.take() {
            task.abort();
        }
        vt.seq
    };
    let Some(rx) = acquire_mic(&coord, &tap, input_device)? else {
        // Unreachable in practice: the host serializes press/release, so no
        // second voice-typing start can land between the stop above and this
        // begin. Kept for safety.
        return Ok(());
    };
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
    // Per-session cutoff: `stop_voice_typing` flips it to end the stream the
    // moment the key is released, before the mic thread even notices the gate.
    let cutoff = Arc::new(AtomicBool::new(false));
    let task = run_metered_session(
        &app,
        provider,
        config,
        "voice-typing",
        rx,
        None,
        "voicetyping://error",
        None,
        Some(cutoff.clone()),
        // Dictation is not pausable — and must keep working even while a live
        // meeting (whose mic it taps) is paused.
        None,
    );
    // Pin the session task so the next start (or stop's backstop) can abort
    // it. If a newer start won the race while we were spawning, ours is the
    // stale one — kill our own task instead of clobbering the newer handle
    // (the newer start already stopped our capture and owns the mic claim).
    let mut vt = state.0.lock().unwrap();
    if vt.seq == my_seq {
        vt.task = Some(task);
        vt.cutoff = Some(cutoff);
    } else {
        task.abort();
    }
    drop(vt);

    // Backend safety net for the hosted single-session cap: if the frontend
    // never stops this session (webview hung/crashed), tear the mic down after
    // the cap + grace so the paid relay stops streaming. Guarded by `seq` so it
    // can never stop a newer session started in the meantime. No-op if that
    // session already ended (mic not owned, task already taken).
    if let Some(secs) = max_duration_secs.filter(|s| *s > 0) {
        arm_cap_watchdog(&app, state.0.clone(), my_seq, secs);
    }
    Ok(())
}

/// Take the microphone for a dictation session: our own capture normally, or a
/// tee of the meeting's raw mic when a meeting owns the one input stream.
/// `Ok(None)` means voice typing already holds the mic and the start is a no-op.
fn acquire_mic(
    coord: &MicCoordinator,
    tap: &MicTap,
    input_device: Option<String>,
) -> Result<Option<tokio::sync::mpsc::UnboundedReceiver<Vec<i16>>>, String> {
    match coord.begin(MicUser::VoiceTyping) {
        Begin::Started(gate) => {
            let mic = Microphone {
                device_name: input_device,
            };
            match spawn_capture(coord, MicUser::VoiceTyping, mic, gate, "voice-typing") {
                Ok(rx) => Ok(Some(rx)),
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
            Ok(Some(rx))
        }
        Begin::Busy(owner) => Err(format!("microphone is in use by {owner:?}")),
    }
}

/// Force-stop the mic once the hosted per-dictation cap (+ grace) has passed,
/// unless the session identified by `my_seq` already ended or was superseded.
fn arm_cap_watchdog(app: &AppHandle, inner: Arc<Mutex<VtInner>>, my_seq: u64, secs: u64) {
    let app = app.clone();
    let deadline = std::time::Duration::from_secs(secs) + CAP_BACKEND_GRACE;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(deadline).await;
        let still_current = { inner.lock().unwrap().seq == my_seq };
        if !still_current {
            return;
        }
        log::warn!("voice-typing: hosted session exceeded {secs}s cap; backend safety-stop");
        app.state::<MicCoordinator>().stop(MicUser::VoiceTyping);
        let mut vt = inner.lock().unwrap();
        if vt.seq == my_seq {
            if let Some(task) = vt.task.take() {
                task.abort();
            }
        }
    });
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

/// Stop the session: clear its gate and join the mic thread with a bounded
/// grace (which drops its PCM sender, closing the STT session cleanly — the
/// graceful path that lets the provider flush its final tokens). No-op if
/// voice typing doesn't own the mic.
///
/// Backstop: a provider/relay that never closes the socket would leave the
/// session task parked on its read half forever. Mirror `stop_meeting`'s
/// direct-cancel safety net — abort the task once the flush window has long
/// passed. Guarded by `seq` so a backstop from THIS session can never abort a
/// newer one started during the grace.
///
/// `async` for the same reason as [`start_voice_typing`], with one extra: the
/// `coord.stop` below joins the capture threads with a bounded grace, and doing
/// that on the main thread hitched every window on every key release.
#[tauri::command]
pub async fn stop_voice_typing(
    coord: State<'_, MicCoordinator>,
    state: State<'_, VoiceTypingState>,
) -> Result<(), String> {
    // Hard cut FIRST: stop forwarding audio to the STT session immediately so
    // nothing captured after release is transcribed, and its input closes now
    // for a prompt final flush — set before `coord.stop` so forwarding ceases
    // without waiting for the mic thread to observe the cleared gate.
    if let Some(cutoff) = state.0.lock().unwrap().cutoff.as_ref() {
        cutoff.store(true, Ordering::SeqCst);
    }
    coord.stop(MicUser::VoiceTyping);
    let my_seq = state.0.lock().unwrap().seq;
    let inner = state.0.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FLUSH_ABORT_GRACE).await;
        let mut vt = inner.lock().unwrap();
        if vt.seq == my_seq {
            if let Some(task) = vt.task.take() {
                task.abort();
            }
        }
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
/// ax_observe to scope its queries to that app. NSWorkspace, not AX — works
/// even when the target's accessibility tree is still switched off.
///
/// macOS-only, like its one caller: correction watching is built on the macOS
/// AX tree and has no counterpart elsewhere. There used to be an `Option::None`
/// stub for other platforms, but with nothing off macOS calling it, it was only
/// a dead-code warning waiting for the Windows CI job to deny warnings.
#[cfg(target_os = "macos")]
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
                let _: () = msg_send![w, setFloatingPanel: true];
                let _: () = msg_send![w, setHidesOnDeactivate: false];
            }
            let _: () = msg_send![w, setCollectionBehavior: OVERLAY_COLLECTION_BEHAVIOR];
            let _: () = msg_send![w, setLevel: OVERLAY_WINDOW_LEVEL];
            let _: () = msg_send![w, orderFrontRegardless];
        }
        log::info!("voice-typing: overlay presented (panel)");
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

    /// File name of the foreground window's executable, e.g. "notepad.exe".
    ///
    /// Windows has no bundle identifier, so this fills the `app_bundle_id` slot
    /// with the closest stable per-app key that costs no permission. `None`
    /// when nothing is foreground (a locked desktop, or a switch in flight) or
    /// when the process can't be opened — for a target at a higher integrity
    /// level that refusal is the normal answer, not a malfunction.
    pub fn frontmost_bundle_id() -> Option<String> {
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
        if pid == 0 {
            return None;
        }
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
