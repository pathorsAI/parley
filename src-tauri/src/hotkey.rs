//! Global push-to-talk key listener for voice typing.
//!
//! The trigger is the macOS `fn` (Globe) key. When "Press 🌐 to" is bound to a
//! system action, the key is consumed before it reaches `NSEvent` monitors — so
//! we tap at the HID level (`kCGHIDEventTap`), which sees the raw key first. We
//! watch `flagsChanged` for the fn key (keyCode 63) and emit
//! `voicetyping://ptt { down }` on each transition.
//!
//! An HID keyboard tap requires Input Monitoring (TCC). We request it at launch;
//! the grant takes effect on the next run. (Auto-paste separately needs
//! Accessibility — see voice_typing.rs.)

#![allow(unexpected_cfgs)]

use tauri::AppHandle;

/// Whether Input Monitoring is granted (needed to see the fn key globally).
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

/// Start the global fn-key tap if it isn't running and the permission is granted.
/// Safe to call repeatedly. Returns whether the tap is active.
#[tauri::command]
pub fn ensure_fn_listener(app: AppHandle) -> bool {
    imp::ensure_started(app)
}

/// Start the listener at app launch (requests Input Monitoring if needed).
pub fn init(app: AppHandle) {
    imp::ensure_started(app);
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};

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
    // Active tap (NOT listen-only) so we can SWALLOW the fn key and stop macOS's
    // own "Press 🌐 to" action (emoji / dictation / input-source) from firing.
    const KCG_TAP_OPTION_DEFAULT: u32 = 0;
    const KCG_EVENT_FLAGS_CHANGED: CGEventType = 12;
    const KCG_KEYBOARD_EVENT_KEYCODE: u32 = 9; // CGEventField
    const FLAG_MASK_SECONDARY_FN: u64 = 0x0080_0000; // kCGEventFlagMaskSecondaryFn
    const KVK_FUNCTION: i64 = 63; // the fn/Globe key
    const TAP_DISABLED_BY_TIMEOUT: CGEventType = 0xFFFF_FFFE;
    const TAP_DISABLED_BY_USER_INPUT: CGEventType = 0xFFFF_FFFF;

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

    static FN_DOWN: AtomicBool = AtomicBool::new(false);
    static STARTED: AtomicBool = AtomicBool::new(false);
    /// The live tap port, so the callback can re-enable it when macOS disables it.
    static TAP_PORT: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

    pub fn listen_event_authorized() -> bool {
        unsafe { CGPreflightListenEventAccess() }
    }

    pub fn request_listen_event() -> bool {
        unsafe { CGRequestListenEventAccess() }
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
            // Only the fn/Globe key drives push-to-talk.
            if key_code == KVK_FUNCTION {
                let flags = unsafe { CGEventGetFlags(event) };
                let fn_now = (flags & FLAG_MASK_SECONDARY_FN) != 0;
                if FN_DOWN.swap(fn_now, Ordering::SeqCst) != fn_now {
                    let app = unsafe { &*(user as *const AppHandle) };
                    log::info!("voice-typing: fn {}", if fn_now { "down" } else { "up" });
                    let _ = app.emit("voicetyping://ptt", serde_json::json!({ "down": fn_now }));
                }
                // Swallow the fn key so the system's "Press 🌐 to" action doesn't
                // also fire (emoji viewer / dictation / input-source switch).
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
            log::info!("voice-typing: fn-key HID tap started");
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
}
