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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::audio::{microphone::Microphone, AudioSource};
use crate::transcription::{self, SttProvider, TranscribeConfig};

/// Shared state for the single in-flight voice-typing session. `running` gates
/// the mic capture thread; clearing it ends capture, which closes the STT WS.
#[derive(Default)]
pub struct VoiceTypingState {
    running: Arc<AtomicBool>,
    threads: Mutex<Vec<JoinHandle<()>>>,
}

/// Start a mic-only streaming transcription. Idempotent while already running.
#[tauri::command]
pub fn start_voice_typing(
    app: AppHandle,
    state: State<VoiceTypingState>,
    provider: String,
    api_key: String,
    model: Option<String>,
    language_hints: Option<Vec<String>>,
    input_device: Option<String>,
) -> Result<(), String> {
    let provider = SttProvider::from_id(&provider).map_err(|e| e.to_string())?;
    if api_key.trim().is_empty() {
        return Err("missing transcription API key".into());
    }
    if state.running.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let running = state.running.clone();
    let model = model
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| provider.default_model().to_string());
    let config = TranscribeConfig {
        api_key,
        model,
        language_hints: language_hints.unwrap_or_default(),
        diarization: false,
    };

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
    match (Microphone {
        device_name: input_device,
    })
    .start(tx, running.clone())
    {
        Ok(handle) => state.threads.lock().unwrap().push(handle),
        Err(e) => {
            state.running.store(false, Ordering::SeqCst);
            return Err(format!("microphone failed to start: {e}"));
        }
    }

    // Stream mic -> provider. Emits `transcript://segment` + `audio://level`
    // with source "voice-typing"; the overlay window listens for both. A sample
    // counter is interposed so we can bill the streamed audio under a distinct
    // `source: "voice-typing"` label (kept separate from meeting usage).
    tauri::async_runtime::spawn(async move {
        let (count_tx, count_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<i16>>();
        let counter = tauri::async_runtime::spawn(async move {
            let mut rx = rx;
            let mut samples: u64 = 0;
            while let Some(chunk) = rx.recv().await {
                samples += chunk.len() as u64;
                if count_tx.send(chunk).is_err() {
                    break;
                }
            }
            samples
        });

        if let Err(e) =
            transcription::run_session(provider, app.clone(), config, "voice-typing", count_rx).await
        {
            log::warn!("voice-typing: session ended: {e}");
        }

        let samples = counter.await.unwrap_or(0);
        let seconds = samples as f64 / crate::audio::TARGET_SAMPLE_RATE as f64;
        let _ = app.emit(
            "usage://stt",
            serde_json::json!({
                "provider": provider.id(),
                "source": "voice-typing",
                "seconds": seconds,
            }),
        );
    });
    Ok(())
}

/// Path to the voice-typing history file (one JSON object per line).
fn voice_history_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("voice_typing_history.jsonl"))
}

/// Append one history entry (a JSON line: `{ id, text, ts }`).
#[tauri::command]
pub fn append_voice_history(app: AppHandle, line: String) -> Result<(), String> {
    use std::io::Write;
    let path = voice_history_path(&app)?;
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
    match std::fs::read_to_string(voice_history_path(&app)?) {
        Ok(s) => Ok(s),
        Err(_) => Ok(String::new()),
    }
}

/// Overwrite the history file (used by delete-one / clear-all).
#[tauri::command]
pub fn write_voice_history(app: AppHandle, content: String) -> Result<(), String> {
    let path = voice_history_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Stop the session: clear `running` and join the mic thread (which drops its
/// PCM sender, closing the STT session cleanly).
#[tauri::command]
pub fn stop_voice_typing(state: State<VoiceTypingState>) {
    state.running.store(false, Ordering::SeqCst);
    let handles: Vec<JoinHandle<()>> = state.threads.lock().unwrap().drain(..).collect();
    for h in handles {
        let _ = h.join();
    }
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
        fn CGEventCreateKeyboardEvent(source: *const c_void, keycode: u16, keydown: bool)
            -> CGEventRef;
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
            let dict = CFDictionary::from_CFType_pairs(&[(
                key.as_CFType(),
                value.as_CFType(),
            )]);
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
