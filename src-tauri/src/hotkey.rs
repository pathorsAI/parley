//! Global push-to-talk key listener for voice typing.
//!
//! The default trigger is the macOS `fn` (Globe) key. Users can switch to a
//! right-side modifier when another app already owns Globe/fn, or record any
//! arbitrary key as a custom push-to-talk button. We tap at the HID level
//! (`kCGHIDEventTap`), which sees key transitions before AppKit monitors and
//! lets us swallow the selected push-to-talk key.
//!
//! An HID keyboard tap requires Input Monitoring (TCC). Settings/onboarding can
//! request it explicitly; the grant may take effect on the next run. Auto-paste
//! separately needs Accessibility — see voice_typing.rs.

#![allow(unexpected_cfgs)]

use serde::Serialize;
use tauri::AppHandle;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyStatus {
    authorized: bool,
    active: bool,
    shortcut: String,
}

/// Whether Input Monitoring is granted (needed to see the push-to-talk key globally).
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

/// Start the global push-to-talk tap if it isn't running and the permission is granted.
/// Safe to call repeatedly. Returns whether the tap is active.
#[tauri::command]
pub fn ensure_fn_listener(app: AppHandle) -> bool {
    imp::ensure_started(app)
}

/// Apply the user's selected voice-typing shortcut and ensure the global
/// listener is running. Returns the effective listener status.
#[tauri::command]
pub fn set_voice_typing_shortcut(app: AppHandle, shortcut: String) -> HotkeyStatus {
    imp::set_shortcut(&shortcut);
    let active = imp::ensure_started(app);
    HotkeyStatus {
        authorized: imp::listen_event_authorized(),
        active,
        shortcut: imp::shortcut_id(),
    }
}

/// Current listener status for Settings.
#[tauri::command]
pub fn voice_typing_hotkey_status() -> HotkeyStatus {
    HotkeyStatus {
        authorized: imp::listen_event_authorized(),
        active: imp::is_started(),
        shortcut: imp::shortcut_id(),
    }
}

/// Start the listener at app launch (requests Input Monitoring if needed).
pub fn init(app: AppHandle) {
    imp::ensure_started(app);
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
    use std::sync::Mutex;

    use tauri::{AppHandle, Emitter};

    type CGEventTapProxy = *const c_void;
    type CGEventRef = *const c_void;
    type CFMachPortRef = *const c_void;
    type CFRunLoopSourceRef = *const c_void;
    type CFRunLoopRef = *const c_void;
    type CFStringRef = *const c_void;
    type CGEventType = u32;

    // Active tap (NOT listen-only) so we can swallow the selected key before
    // macOS or the frontmost app also reacts to it.
    const KCG_HID_EVENT_TAP: u32 = 0; // kCGHIDEventTap — earliest point in the pipeline
    const KCG_HEAD_INSERT: u32 = 0; // kCGHeadInsertEventTap
    const KCG_TAP_OPTION_DEFAULT: u32 = 0; // kCGEventTapOptionDefault
    const KCG_EVENT_KEYDOWN: CGEventType = 10;
    const KCG_EVENT_KEYUP: CGEventType = 11;
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

    #[derive(Clone, Copy, Debug)]
    enum Shortcut {
        Fn,
        RightOption,
        RightCommand,
        RightControl,
        Custom(u16),
    }

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
    static SHORTCUT: Mutex<Shortcut> = Mutex::new(Shortcut::Fn);
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
        let shortcut = if let Some(raw) = id.strip_prefix("keycode:") {
            raw.parse::<u16>()
                .map(Shortcut::Custom)
                .unwrap_or(Shortcut::Fn)
        } else {
            match id {
                "right-option" => Shortcut::RightOption,
                "right-command" => Shortcut::RightCommand,
                "right-control" => Shortcut::RightControl,
                _ => Shortcut::Fn,
            }
        };
        if let Ok(mut guard) = SHORTCUT.lock() {
            *guard = shortcut;
        }
        KEY_DOWN.store(false, Ordering::SeqCst);
    }

    pub fn shortcut_id() -> String {
        let s = SHORTCUT.lock().map(|g| *g).unwrap_or(Shortcut::Fn);
        match s {
            Shortcut::Fn => "fn".into(),
            Shortcut::RightOption => "right-option".into(),
            Shortcut::RightCommand => "right-command".into(),
            Shortcut::RightControl => "right-control".into(),
            Shortcut::Custom(c) => format!("keycode:{c}"),
        }
    }

    fn current_shortcut() -> Shortcut {
        SHORTCUT.lock().map(|g| *g).unwrap_or(Shortcut::Fn)
    }

    fn preset_trigger_state(key_code: i64, flags: u64, shortcut: Shortcut) -> Option<bool> {
        match shortcut {
            Shortcut::RightOption if key_code == KVK_RIGHT_OPTION => {
                Some((flags & FLAG_MASK_ALTERNATE) != 0)
            }
            Shortcut::RightCommand if key_code == KVK_RIGHT_COMMAND => {
                Some((flags & FLAG_MASK_COMMAND) != 0)
            }
            Shortcut::RightControl if key_code == KVK_RIGHT_CONTROL => {
                Some((flags & FLAG_MASK_CONTROL) != 0)
            }
            Shortcut::Fn if key_code == KVK_FUNCTION => {
                Some((flags & FLAG_MASK_SECONDARY_FN) != 0)
            }
            _ => None,
        }
    }

    unsafe fn emit_ptt(app_ptr: *mut c_void, down: bool) {
        let app = &*(app_ptr as *const AppHandle);
        log::info!("voice-typing: {} {}", shortcut_id(), if down { "down" } else { "up" });
        let _ = app.emit("voicetyping://ptt", serde_json::json!({ "down": down }));
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

        if user.is_null() {
            return event;
        }

        let shortcut = current_shortcut();

        // Preset modifiers (including fn/Globe) are best detected via
        // flags-changed so we can see modifier transitions without an actual
        // key-down event.
        if etype == KCG_EVENT_FLAGS_CHANGED && matches!(shortcut, Shortcut::Fn | Shortcut::RightOption | Shortcut::RightCommand | Shortcut::RightControl) {
            let key_code = unsafe { CGEventGetIntegerValueField(event, KCG_KEYBOARD_EVENT_KEYCODE) };
            let flags = unsafe { CGEventGetFlags(event) };
            if let Some(now) = preset_trigger_state(key_code, flags, shortcut) {
                if KEY_DOWN.swap(now, Ordering::SeqCst) != now {
                    unsafe { emit_ptt(user, now) };
                }
                // Swallow the selected push-to-talk key so the system or another
                // frontmost app doesn't also react to the modifier transition.
                return std::ptr::null();
            }
            return event;
        }

        // Custom keys are ordinary keys, so look for key-down / key-up events.
        if let Shortcut::Custom(custom_code) = shortcut {
            if etype == KCG_EVENT_KEYDOWN || etype == KCG_EVENT_KEYUP {
                let key_code =
                    unsafe { CGEventGetIntegerValueField(event, KCG_KEYBOARD_EVENT_KEYCODE) } as u16;
                if key_code == custom_code {
                    let down = etype == KCG_EVENT_KEYDOWN;
                    if KEY_DOWN.swap(down, Ordering::SeqCst) != down {
                        unsafe { emit_ptt(user, down) };
                    }
                    return std::ptr::null();
                }
            }
        }

        event
    }

    pub fn ensure_started(app: AppHandle) -> bool {
        if STARTED.swap(true, Ordering::SeqCst) {
            return true;
        }
        if !listen_event_authorized() {
            // Don't prompt at launch — that's jarring. The user enables voice
            // typing from Settings → Permissions, which calls
            // request_input_monitoring (the prompt) explicitly.
            STARTED.store(false, Ordering::SeqCst);
            return false;
        }
        // Build the tap inside the thread — the raw CF/CG pointers aren't `Send`,
        // only the `AppHandle` (which is) crosses the boundary. The thread owns
        // the run loop for the app's lifetime.
        std::thread::spawn(move || unsafe {
            let user = Box::into_raw(Box::new(app)) as *mut c_void;
            let mask: u64 = (1 << KCG_EVENT_FLAGS_CHANGED)
                | (1 << KCG_EVENT_KEYDOWN)
                | (1 << KCG_EVENT_KEYUP);
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
            log::info!("voice-typing: push-to-talk HID tap started");
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
    pub fn ensure_started(_app: AppHandle) -> bool {
        false
    }
    pub fn is_started() -> bool {
        false
    }
    pub fn set_shortcut(_id: &str) {}
    pub fn shortcut_id() -> String {
        "fn".into()
    }
}
