//! Voice typing: a lightweight push-to-talk dictation session that reuses the
//! meeting transcription stack (microphone -> one STT provider) but with none of
//! the meeting overhead (no diarization, no system-audio capture, no recording).
//!
//! It emits the same `transcript://segment` and `audio://level` events as a
//! meeting, tagged `source: "voice-typing"`, which the floating overlay window
//! renders. On release, the host copies the final text to the clipboard via the
//! native pasteboard (the webview can't, because Parley isn't the focused app)
//! and — when the user enabled it — simulates Cmd+V to paste into the frontmost
//! app (needs Accessibility).

// The `objc` 0.2 macros emit `cfg(cargo-clippy)` checks newer compilers warn on.
#![allow(unexpected_cfgs)]

use tauri::{AppHandle, State};

use crate::audio::microphone::Microphone;
use crate::capture::{run_metered_session, spawn_capture, Begin, MicCoordinator, MicUser};
use crate::commands::{read_config_file, write_config_file};
use crate::transcription::{SttProvider, TranscribeConfig};

/// Start a mic-only streaming transcription. Idempotent while already running;
/// refused while a meeting owns the mic (a second input stream could kill the
/// meeting's capture — see [`MicCoordinator`]).
///
/// Streams mic -> provider, emitting `transcript://segment` + `audio://level`
/// with source "voice-typing"; the overlay window listens for both. The shared
/// metered session bills the streamed audio under the distinct
/// `source: "voice-typing"` label (kept separate from meeting usage). A failed
/// session raises `voicetyping://error`, which the overlay renders (voice
/// typing has no other error surface — see `run_metered_session`).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn start_voice_typing(
    app: AppHandle,
    coord: State<MicCoordinator>,
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
    let gate = match coord.begin(MicUser::VoiceTyping) {
        Begin::Started(gate) => gate,
        Begin::AlreadyActive => return Ok(()),
        Begin::Busy(_) => return Err("microphone is in use by the meeting".into()),
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
    };

    let mic = Microphone {
        device_name: input_device,
    };
    let rx = match spawn_capture(&coord, MicUser::VoiceTyping, mic, gate, "voice-typing") {
        Ok(rx) => rx,
        Err(e) => {
            coord.stop(MicUser::VoiceTyping);
            return Err(format!("microphone failed to start: {e}"));
        }
    };
    run_metered_session(
        &app,
        provider,
        config,
        "voice-typing",
        rx,
        None,
        "voicetyping://error",
    );
    Ok(())
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
/// grace (which drops its PCM sender, closing the STT session cleanly). No-op
/// if voice typing doesn't own the mic.
#[tauri::command]
pub fn stop_voice_typing(coord: State<MicCoordinator>) {
    coord.stop(MicUser::VoiceTyping);
}

/// Copy text to the system clipboard via the native pasteboard. Needed because
/// the webview's `navigator.clipboard` is blocked while Parley isn't focused.
#[tauri::command]
pub fn copy_to_clipboard(text: String) -> Result<(), String> {
    imp::copy_to_clipboard(&text)
}

/// Paste into the frontmost app by simulating ⌘V. Requires Accessibility.
/// Returns whether the keystroke was posted (false if not trusted).
#[tauri::command]
pub fn paste_to_frontmost() -> bool {
    imp::paste_to_frontmost()
}

/// Whether the app is trusted for Accessibility (needed for auto-paste).
/// When `prompt` is true, macOS shows the "grant Accessibility" dialog.
#[tauri::command]
pub fn accessibility_status(prompt: bool) -> bool {
    imp::accessibility_trusted(prompt)
}

/// Crate-internal Accessibility check (never prompts), used by hotkey.rs: an
/// ACTIVE CGEventTap runs under Accessibility even when Input Monitoring is
/// missing, so the push-to-talk tap consults both permissions.
pub(crate) fn is_accessibility_trusted() -> bool {
    imp::accessibility_trusted(false)
}

/// Show the overlay above ALL apps without activating Parley or stealing focus
/// (`orderFrontRegardless` + a floating level + all-spaces / full-screen
/// collection behaviour). Driving visibility natively avoids Tauri's `show()`,
/// which can bring Parley to the front.
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
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Hide the overlay (`orderOut:`), the counterpart to `present_voice_overlay`.
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
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(target_os = "macos")]
mod imp {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;
    use objc::runtime::{Class, Object};
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};

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

    /// One-shot: has the overlay window been turned into an NSPanel yet?
    static OVERLAY_IS_PANEL: AtomicBool = AtomicBool::new(false);

    pub fn present_overlay(ns_window: *mut std::ffi::c_void) {
        unsafe {
            let w = ns_window as *mut Object;
            // A plain NSWindow gets isolated to its own Space and can't float over
            // another app's full-screen Space. Turning it into a non-activating
            // NSPanel (+ fullScreenAuxiliary) is the native pattern for overlays.
            if !OVERLAY_IS_PANEL.swap(true, Ordering::SeqCst) {
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

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn copy_to_clipboard(_text: &str) -> Result<(), String> {
        Err("clipboard only implemented on macOS".into())
    }
    pub fn paste_to_frontmost() -> bool {
        false
    }
    pub fn accessibility_trusted(_prompt: bool) -> bool {
        false
    }
}
