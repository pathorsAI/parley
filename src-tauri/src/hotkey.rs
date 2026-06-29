//! Global push-to-talk key listener for voice typing.
//!
//! The push-to-talk key is user-selectable from a curated list:
//!   - `alt-space` (default) — Option+Space, handled by the cross-platform
//!     `tauri-plugin-global-shortcut` (registered in lib.rs). Needs no extra
//!     permission, so it's the out-of-the-box trigger.
//!   - `fn` / `right-option` / `right-command` / `right-control` — hold-friendly
//!     modifier keys handled by a macOS HID event tap (`kCGHIDEventTap`), which
//!     sees modifier transitions before AppKit monitors and lets us swallow the
//!     selected key so the OS / frontmost app doesn't also react to it.
//!
//! The picker is the single source of truth: exactly one trigger is live at a
//! time. Selecting `alt-space` registers the global shortcut and parks the HID
//! tap (it matches nothing); selecting a modifier unregisters the global
//! shortcut and arms the HID tap on that key.
//!
//! An HID keyboard tap requires Input Monitoring (TCC). Settings can request it
//! explicitly; the grant may take effect on the next run. Auto-paste separately
//! needs Accessibility — see voice_typing.rs.

#![allow(unexpected_cfgs)]

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

/// The Option+Space global shortcut handled by the global-shortcut plugin.
fn alt_space() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT), Code::Space)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyStatus {
    /// Input Monitoring granted (only relevant for the HID-tap modifier keys).
    authorized: bool,
    /// Whether the selected trigger is actually live.
    active: bool,
    /// The current selection id (`alt-space` / `fn` / `right-*`).
    shortcut: String,
}

/// Whether Input Monitoring is granted (needed to see the modifier keys globally).
#[tauri::command]
pub fn input_monitoring_status() -> bool {
    imp::listen_event_authorized()
}

/// Prompt for Input Monitoring. macOS shows the prompt once and reflects the
/// grant after a relaunch; returns the (possibly stale) current status.
#[tauri::command]
pub fn request_input_monitoring() -> bool {
    imp::request_listen_event()
}

/// Start the global modifier-key tap if it isn't running and the permission is
/// granted. Safe to call repeatedly. Returns whether the tap is active.
#[tauri::command]
pub fn ensure_fn_listener(app: AppHandle) -> bool {
    imp::ensure_started(app)
}

/// Apply the user's selected voice-typing shortcut. The picker is the single
/// source of truth, so this also (de)registers the Alt+Space global shortcut so
/// only one trigger is ever live. Returns the effective listener status.
#[tauri::command]
pub fn set_voice_typing_shortcut(app: AppHandle, shortcut: String) -> HotkeyStatus {
    let gs = app.global_shortcut();
    if shortcut == "alt-space" {
        // Park the HID tap (matches nothing) and (re)enable Option+Space.
        imp::set_shortcut("alt-space");
        let _ = gs.register(alt_space());
    } else {
        // A modifier key drives push-to-talk via the HID tap; drop Option+Space.
        let _ = gs.unregister(alt_space());
        imp::set_shortcut(&shortcut);
        imp::ensure_started(app.clone());
    }
    status()
}

/// Current listener status for Settings.
#[tauri::command]
pub fn voice_typing_hotkey_status() -> HotkeyStatus {
    status()
}

fn status() -> HotkeyStatus {
    let id = imp::shortcut_id();
    if id == "alt-space" {
        // Option+Space needs no permission and is live as soon as it's selected.
        HotkeyStatus {
            authorized: true,
            active: true,
            shortcut: id.to_string(),
        }
    } else {
        let authorized = imp::listen_event_authorized();
        HotkeyStatus {
            authorized,
            active: imp::is_started() && authorized,
            shortcut: id.to_string(),
        }
    }
}

/// Start the listener at app launch (no-op until the user grants Input
/// Monitoring; harmless under the default Alt+Space selection since the tap
/// then matches nothing).
pub fn init(app: AppHandle) {
    imp::ensure_started(app);
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU8, Ordering};

    use tauri::{AppHandle, Emitter};

    type CGEventTapProxy = *const c_void;
    type CGEventRef = *const c_void;
    type CFMachPortRef = *const c_void;
    type CFRunLoopSourceRef = *const c_void;
    type CFRunLoopRef = *const c_void;
    type CFStringRef = *const c_void;
    type CGEventType = u32;

    // kCGHIDEventTap: earliest point in the pipeline.
    const KCG_HID_EVENT_TAP: u32 = 0;
    // kCGHeadInsertEventTap.
    const KCG_HEAD_INSERT: u32 = 0;
    // Active tap (NOT listen-only) so we can SWALLOW the selected key and stop
    // the OS / frontmost app from also reacting to it (e.g. fn's "Press 🌐 to").
    const KCG_TAP_OPTION_DEFAULT: u32 = 0;
    const KCG_EVENT_FLAGS_CHANGED: CGEventType = 12;
    const KCG_KEYBOARD_EVENT_KEYCODE: u32 = 9; // CGEventField
    const FLAG_MASK_CONTROL: u64 = 0x0004_0000; // kCGEventFlagMaskControl
    const FLAG_MASK_ALTERNATE: u64 = 0x0008_0000; // kCGEventFlagMaskAlternate
    const FLAG_MASK_COMMAND: u64 = 0x0010_0000; // kCGEventFlagMaskCommand
    const FLAG_MASK_SECONDARY_FN: u64 = 0x0080_0000; // kCGEventFlagMaskSecondaryFn
    const KVK_FUNCTION: i64 = 63; // the fn/Globe key
    const KVK_RIGHT_COMMAND: i64 = 54;
    const KVK_RIGHT_OPTION: i64 = 61;
    const KVK_RIGHT_CONTROL: i64 = 62;
    const TAP_DISABLED_BY_TIMEOUT: CGEventType = 0xFFFF_FFFE;
    const TAP_DISABLED_BY_USER_INPUT: CGEventType = 0xFFFF_FFFF;

    // The HID tap parks on ALT_SPACE (matches nothing — Option+Space is handled
    // by the global-shortcut plugin instead).
    const SHORTCUT_ALT_SPACE: u8 = 0;
    const SHORTCUT_FN: u8 = 1;
    const SHORTCUT_RIGHT_OPTION: u8 = 2;
    const SHORTCUT_RIGHT_COMMAND: u8 = 3;
    const SHORTCUT_RIGHT_CONTROL: u8 = 4;

    type CGEventTapCallBack =
        extern "C" fn(CGEventTapProxy, CGEventType, CGEventRef, *mut c_void) -> CGEventRef;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventTapCreate(
            tap: u32,
            place: u32,
            options: u32,
            events_of_interest: u64,
            callback: CGEventTapCallBack,
            user_info: *mut c_void,
        ) -> CFMachPortRef;
        fn CGEventGetFlags(event: CGEventRef) -> u64;
        fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
        fn CGEventTapEnable(port: CFMachPortRef, enable: bool);
        fn CGPreflightListenEventAccess() -> bool;
        fn CGRequestListenEventAccess() -> bool;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFMachPortCreateRunLoopSource(
            allocator: *const c_void,
            port: CFMachPortRef,
            order: isize,
        ) -> CFRunLoopSourceRef;
        fn CFRunLoopGetCurrent() -> CFRunLoopRef;
        fn CFRunLoopAddSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFStringRef);
        fn CFRunLoopRun();
        static kCFRunLoopCommonModes: CFStringRef;
    }

    static KEY_DOWN: AtomicBool = AtomicBool::new(false);
    static STARTED: AtomicBool = AtomicBool::new(false);
    static SHORTCUT: AtomicU8 = AtomicU8::new(SHORTCUT_ALT_SPACE);
    /// The live tap port, so the callback can re-enable it when macOS disables it.
    static TAP_PORT: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

    pub fn listen_event_authorized() -> bool {
        unsafe { CGPreflightListenEventAccess() }
    }

    pub fn request_listen_event() -> bool {
        unsafe { CGRequestListenEventAccess() }
    }

    pub fn is_started() -> bool {
        STARTED.load(Ordering::SeqCst)
    }

    pub fn set_shortcut(id: &str) {
        let next = match id {
            "fn" => SHORTCUT_FN,
            "right-option" => SHORTCUT_RIGHT_OPTION,
            "right-command" => SHORTCUT_RIGHT_COMMAND,
            "right-control" => SHORTCUT_RIGHT_CONTROL,
            _ => SHORTCUT_ALT_SPACE,
        };
        SHORTCUT.store(next, Ordering::SeqCst);
        // Reset latched state so a key still held across a switch can't get stuck.
        KEY_DOWN.store(false, Ordering::SeqCst);
    }

    pub fn shortcut_id() -> &'static str {
        match SHORTCUT.load(Ordering::SeqCst) {
            SHORTCUT_FN => "fn",
            SHORTCUT_RIGHT_OPTION => "right-option",
            SHORTCUT_RIGHT_COMMAND => "right-command",
            SHORTCUT_RIGHT_CONTROL => "right-control",
            _ => "alt-space",
        }
    }

    /// Map a `flagsChanged` event to the down/up state of the *selected* key, or
    /// `None` if this event isn't the selected push-to-talk key.
    fn trigger_state(key_code: i64, flags: u64) -> Option<bool> {
        match SHORTCUT.load(Ordering::SeqCst) {
            SHORTCUT_FN if key_code == KVK_FUNCTION => Some((flags & FLAG_MASK_SECONDARY_FN) != 0),
            SHORTCUT_RIGHT_OPTION if key_code == KVK_RIGHT_OPTION => {
                Some((flags & FLAG_MASK_ALTERNATE) != 0)
            }
            SHORTCUT_RIGHT_COMMAND if key_code == KVK_RIGHT_COMMAND => {
                Some((flags & FLAG_MASK_COMMAND) != 0)
            }
            SHORTCUT_RIGHT_CONTROL if key_code == KVK_RIGHT_CONTROL => {
                Some((flags & FLAG_MASK_CONTROL) != 0)
            }
            // alt-space (or any non-matching key): the HID tap stays out of it.
            _ => None,
        }
    }

    extern "C" fn callback(
        _proxy: CGEventTapProxy,
        etype: CGEventType,
        event: CGEventRef,
        user: *mut c_void,
    ) -> CGEventRef {
        if etype == TAP_DISABLED_BY_TIMEOUT || etype == TAP_DISABLED_BY_USER_INPUT {
            let port = TAP_PORT.load(Ordering::SeqCst);
            if !port.is_null() {
                unsafe { CGEventTapEnable(port as CFMachPortRef, true) };
            }
            return event;
        }
        if etype == KCG_EVENT_FLAGS_CHANGED && !user.is_null() {
            let key_code =
                unsafe { CGEventGetIntegerValueField(event, KCG_KEYBOARD_EVENT_KEYCODE) };
            let flags = unsafe { CGEventGetFlags(event) };
            if let Some(now) = trigger_state(key_code, flags) {
                if KEY_DOWN.swap(now, Ordering::SeqCst) != now {
                    let app = unsafe { &*(user as *const AppHandle) };
                    log::info!(
                        "voice-typing: {} {}",
                        shortcut_id(),
                        if now { "down" } else { "up" }
                    );
                    let _ = app.emit("voicetyping://ptt", serde_json::json!({ "down": now }));
                }
                // Swallow the key so the OS / frontmost app doesn't also react
                // (e.g. fn's "Press 🌐 to" emoji / dictation / input-source).
                return std::ptr::null();
            }
        }
        event
    }

    pub fn ensure_started(app: AppHandle) -> bool {
        if STARTED.swap(true, Ordering::SeqCst) {
            return true;
        }
        let authorized = listen_event_authorized();
        if !authorized {
            // Don't prompt at launch — that's jarring. The user enables a
            // modifier key from Settings, which calls request_input_monitoring
            // (the prompt) explicitly.
            STARTED.store(false, Ordering::SeqCst);
            return false;
        }
        // Build the tap inside the thread — the raw CF/CG pointers aren't `Send`,
        // only the `AppHandle` (which is) crosses the boundary. The thread owns
        // the run loop for the app's lifetime.
        std::thread::spawn(move || unsafe {
            let user = Box::into_raw(Box::new(app)) as *mut c_void;
            let mask: u64 = 1 << KCG_EVENT_FLAGS_CHANGED;
            let port = CGEventTapCreate(
                KCG_HID_EVENT_TAP,
                KCG_HEAD_INSERT,
                KCG_TAP_OPTION_DEFAULT,
                mask,
                callback,
                user,
            );
            if port.is_null() {
                drop(Box::from_raw(user as *mut AppHandle));
                STARTED.store(false, Ordering::SeqCst);
                log::warn!("voice-typing: HID event tap not created (Input Monitoring missing?)");
                return;
            }
            TAP_PORT.store(port as *mut c_void, Ordering::SeqCst);
            let source = CFMachPortCreateRunLoopSource(std::ptr::null(), port, 0);
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
            CGEventTapEnable(port, true);
            log::info!("voice-typing: modifier-key HID tap started");
            CFRunLoopRun();
        });
        true
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use tauri::AppHandle;
    pub fn listen_event_authorized() -> bool {
        false
    }
    pub fn request_listen_event() -> bool {
        false
    }
    pub fn is_started() -> bool {
        false
    }
    pub fn set_shortcut(_id: &str) {}
    pub fn shortcut_id() -> &'static str {
        "alt-space"
    }
    pub fn ensure_started(_app: AppHandle) -> bool {
        false
    }
}
