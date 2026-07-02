//! Global push-to-talk key listener for voice typing.
//!
//! Two trigger mechanisms, picked by the user:
//!   - Key combos — the default `alt-space` (Option+Space) or any user-recorded
//!     `combo:<modifiers+Key>` (e.g. `combo:control+shift+KeyD`, `combo:F6`),
//!     handled by the cross-platform `tauri-plugin-global-shortcut`
//!     (Carbon `RegisterEventHotKey` on macOS). Needs NO extra permission —
//!     this is the out-of-the-box path.
//!   - `fn` / `right-option` / `right-command` / `right-control` — hold-friendly
//!     single modifier keys handled by a macOS HID event tap (`kCGHIDEventTap`),
//!     which sees modifier transitions before AppKit monitors. The tap is
//!     created ACTIVE first (on modern macOS that pairs with the Accessibility
//!     permission) so the selected key can be swallowed before the OS /
//!     frontmost app reacts; if that fails it falls back to a LISTEN-ONLY tap
//!     (which pairs with Input Monitoring) that still drives push-to-talk but
//!     cannot suppress the key's normal action. Either permission therefore
//!     enables the feature; with neither, the tap can't be created at all.
//!     Because the tap thread lives for the app's lifetime, upgrading
//!     listen-only → active after granting Accessibility takes effect on the
//!     next app launch.
//!
//! The picker is the single source of truth: exactly one trigger is live at a
//! time. Selecting a combo unregisters everything, registers that combo, and
//! parks the HID tap (it matches nothing); selecting a modifier unregisters all
//! combos and arms the HID tap on that key.
//!
//! Auto-paste separately needs Accessibility — see voice_typing.rs.

#![allow(unexpected_cfgs)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

/// The modifier-key ids handled by the HID tap (everything else is a combo).
const MODIFIER_IDS: [&str; 4] = ["fn", "right-option", "right-command", "right-control"];

/// The Option+Space global shortcut handled by the global-shortcut plugin.
fn alt_space() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT), Code::Space)
}

/// The current selection id. `None` until the frontend applies the saved
/// setting at startup — the boot default (Alt+Space, registered in lib.rs)
/// reports as "alt-space" via [`status`].
static CURRENT: Mutex<Option<String>> = Mutex::new(None);
/// Whether the active combo actually registered with the OS (a combo can fail
/// if another app owns it). Starts true: lib.rs registers Alt+Space at boot.
static COMBO_OK: AtomicBool = AtomicBool::new(true);

/// Parse a picker id into a plugin `Shortcut`. `alt-space` is the legacy id for
/// Option+Space; `combo:<expr>` carries a recorded combo whose tokens follow the
/// W3C `KeyboardEvent.code` names the plugin's parser accepts (e.g.
/// `combo:alt+Space`, `combo:super+shift+KeyV`, `combo:F6`).
fn parse_combo(id: &str) -> Option<Shortcut> {
    if id == "alt-space" {
        return Some(alt_space());
    }
    id.strip_prefix("combo:")?.parse::<Shortcut>().ok()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyStatus {
    /// A permission that can back the trigger is granted. For the HID-tap
    /// modifier keys that's Input Monitoring OR Accessibility (either enables
    /// a tap mode); combos are always authorized.
    authorized: bool,
    /// Whether the selected trigger is actually live.
    active: bool,
    /// How the trigger is delivered: `combo` (global-shortcut plugin),
    /// `tap-active` (HID tap that swallows the key), `tap-listen` (HID tap
    /// that observes but can't swallow), or `none` (no live tap).
    mode: String,
    /// The current selection id (`alt-space` / `combo:…` / `fn` / `right-*`).
    shortcut: String,
}

/// Whether Input Monitoring is granted (needed to see the modifier keys
/// globally). Checked via IOHIDCheckAccess — unlike CGPreflightListenEventAccess
/// it reflects a grant made while the app is running (no stale "denied" after
/// the user flips the toggle in System Settings).
#[tauri::command]
pub fn input_monitoring_status() -> bool {
    imp::listen_event_authorized()
}

/// Prompt for Input Monitoring. macOS shows the prompt once; the grant may only
/// take effect after a relaunch. Returns the current (possibly stale) status.
#[tauri::command]
pub fn request_input_monitoring() -> bool {
    imp::request_listen_event()
}

/// Start the global modifier-key tap if it isn't running. Called from Settings
/// (an explicit user action), so it forces a creation attempt even when no
/// permission looks granted yet. Safe to call repeatedly. Returns whether the
/// tap is actually live.
#[tauri::command]
pub fn ensure_fn_listener(app: AppHandle) -> bool {
    imp::ensure_started(app, true)
}

/// Apply the user's selected voice-typing trigger. The picker is the single
/// source of truth: everything previously registered is dropped first, so only
/// one trigger is ever live. Returns the effective listener status.
#[tauri::command]
pub fn set_voice_typing_shortcut(app: AppHandle, shortcut: String) -> HotkeyStatus {
    let gs = app.global_shortcut();
    // Drop every combo we own (ours is the only user of the plugin).
    let _ = gs.unregister_all();
    if MODIFIER_IDS.contains(&shortcut.as_str()) {
        // A modifier key drives push-to-talk via the HID tap. The user picked
        // it explicitly, so force a tap attempt even without a visible grant.
        COMBO_OK.store(false, Ordering::SeqCst);
        imp::set_shortcut(&shortcut);
        imp::ensure_started(app.clone(), true);
    } else {
        // A key combo drives push-to-talk; park the HID tap (matches nothing).
        imp::set_shortcut("alt-space");
        let ok = match parse_combo(&shortcut) {
            Some(sc) => gs.register(sc).map_err(|e| log::warn!("voice-typing: register {shortcut:?} failed: {e}")).is_ok(),
            None => {
                log::warn!("voice-typing: unparsable shortcut {shortcut:?}");
                false
            }
        };
        COMBO_OK.store(ok, Ordering::SeqCst);
    }
    *CURRENT.lock().unwrap() = Some(shortcut);
    status()
}

/// Current listener status for Settings.
#[tauri::command]
pub fn voice_typing_hotkey_status() -> HotkeyStatus {
    status()
}

fn status() -> HotkeyStatus {
    let id = CURRENT
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| "alt-space".to_string());
    if MODIFIER_IDS.contains(&id.as_str()) {
        // Either permission can back a tap: Accessibility → active tap,
        // Input Monitoring → listen-only tap.
        let authorized =
            imp::listen_event_authorized() || crate::voice_typing::is_accessibility_trusted();
        let mode = match imp::tap_mode() {
            "active" => "tap-active",
            "listen" => "tap-listen",
            _ => "none",
        };
        HotkeyStatus {
            authorized,
            // STARTED alone can be optimistically true for a moment (the
            // ensure_started guard sets it before the tap thread reports, and
            // a recv timeout deliberately leaves it set); requiring a recorded
            // tap mode makes `active` mean "a live tap exists right now".
            active: imp::is_started() && imp::tap_mode() != "none",
            mode: mode.to_string(),
            shortcut: id,
        }
    } else {
        // Combos need no permission; "active" reflects OS registration (which
        // can fail when another app owns the combo).
        HotkeyStatus {
            authorized: true,
            active: COMBO_OK.load(Ordering::SeqCst),
            mode: "combo".to_string(),
            shortcut: id,
        }
    }
}

/// Start the listener at app launch. Not forced: with neither permission
/// granted this is a silent no-op, so launch never registers Parley in the TCC
/// panes uninvited. (Harmless under the default Alt+Space selection since the
/// tap then matches nothing.)
pub fn init(app: AppHandle) {
    imp::ensure_started(app, false);
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
    // On modern macOS an ACTIVE keyboard tap pairs with the Accessibility
    // permission; creation fails without it.
    const KCG_TAP_OPTION_DEFAULT: u32 = 0;
    // Listen-only tap: pairs with Input Monitoring, sees the key but cannot
    // swallow it — the fallback when the active tap can't be created.
    const KCG_TAP_OPTION_LISTEN_ONLY: u32 = 1;
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
    }

    // Input Monitoring TCC via IOKit. IOHIDCheckAccess is the reliable check:
    // CGPreflightListenEventAccess is cached per-process and keeps returning
    // false after the user grants the permission in System Settings (the
    // "granted but still shows not granted" bug).
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOHIDCheckAccess(request_type: u32) -> u32;
        fn IOHIDRequestAccess(request_type: u32) -> bool;
    }
    const KIOHID_REQUEST_LISTEN_EVENT: u32 = 1; // kIOHIDRequestTypeListenEvent
    const KIOHID_ACCESS_GRANTED: u32 = 0; // kIOHIDAccessTypeGranted

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

    // Which tap mode is live (see the module doc for the fallback story).
    const TAP_MODE_NONE: u8 = 0;
    const TAP_MODE_ACTIVE: u8 = 1;
    const TAP_MODE_LISTEN: u8 = 2;

    static KEY_DOWN: AtomicBool = AtomicBool::new(false);
    static STARTED: AtomicBool = AtomicBool::new(false);
    static SHORTCUT: AtomicU8 = AtomicU8::new(SHORTCUT_ALT_SPACE);
    /// The mode of the live tap; NONE whenever no tap exists (kept in sync
    /// with STARTED).
    static TAP_MODE: AtomicU8 = AtomicU8::new(TAP_MODE_NONE);
    /// The live tap port, so the callback can re-enable it when macOS disables it.
    static TAP_PORT: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

    pub fn tap_mode() -> &'static str {
        match TAP_MODE.load(Ordering::SeqCst) {
            TAP_MODE_ACTIVE => "active",
            TAP_MODE_LISTEN => "listen",
            _ => "none",
        }
    }

    pub fn listen_event_authorized() -> bool {
        unsafe { IOHIDCheckAccess(KIOHID_REQUEST_LISTEN_EVENT) == KIOHID_ACCESS_GRANTED }
    }

    pub fn request_listen_event() -> bool {
        unsafe { IOHIDRequestAccess(KIOHID_REQUEST_LISTEN_EVENT) }
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
                // (e.g. fn's "Press 🌐 to" emoji / dictation / input-source) —
                // only an ACTIVE tap may filter. A listen-only tap must return
                // the event unchanged (that's its contract); push-to-talk still
                // works, the key's normal action just isn't suppressed.
                if TAP_MODE.load(Ordering::SeqCst) == TAP_MODE_ACTIVE {
                    return std::ptr::null();
                }
            }
        }
        event
    }

    /// Start the tap thread if it isn't running; returns whether a live tap
    /// exists. `force` skips the permission pre-gate (explicit user action).
    pub fn ensure_started(app: AppHandle, force: bool) -> bool {
        if STARTED.swap(true, Ordering::SeqCst) {
            return true;
        }
        // Either permission can enable a tap mode: Accessibility backs the
        // ACTIVE (swallowing) tap, Input Monitoring the LISTEN-ONLY fallback.
        let input_monitoring = listen_event_authorized();
        let accessibility = crate::voice_typing::is_accessibility_trusted();
        if !input_monitoring && !accessibility && !force {
            // Launch path: don't attempt a doomed tap — a failed
            // CGEventTapCreate registers the app in the Input Monitoring TCC
            // pane uninvited (and we never prompt at launch; Settings calls
            // request_input_monitoring explicitly).
            TAP_MODE.store(TAP_MODE_NONE, Ordering::SeqCst);
            STARTED.store(false, Ordering::SeqCst);
            return false;
        }
        // When forced without a visible grant we attempt anyway: the failed
        // CGEventTapCreate makes macOS list the app under Input Monitoring,
        // which actually HELPS the user find and enable the toggle.
        //
        // Build the tap inside the thread — the raw CF/CG pointers aren't `Send`,
        // only the `AppHandle` (which is) crosses the boundary. The thread owns
        // the run loop for the app's lifetime and reports creation success back
        // over the channel so this function's result is truthful.
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        std::thread::spawn(move || unsafe {
            let user = Box::into_raw(Box::new(app)) as *mut c_void;
            let mask: u64 = 1 << KCG_EVENT_FLAGS_CHANGED;
            // Prefer the ACTIVE tap (can swallow the key); fall back to
            // LISTEN-ONLY (observes but can't swallow) when it fails.
            let mut mode = TAP_MODE_ACTIVE;
            let mut port = CGEventTapCreate(
                KCG_HID_EVENT_TAP,
                KCG_HEAD_INSERT,
                KCG_TAP_OPTION_DEFAULT,
                mask,
                callback,
                user,
            );
            if port.is_null() {
                mode = TAP_MODE_LISTEN;
                port = CGEventTapCreate(
                    KCG_HID_EVENT_TAP,
                    KCG_HEAD_INSERT,
                    KCG_TAP_OPTION_LISTEN_ONLY,
                    mask,
                    callback,
                    user,
                );
            }
            if port.is_null() {
                drop(Box::from_raw(user as *mut AppHandle));
                TAP_MODE.store(TAP_MODE_NONE, Ordering::SeqCst);
                STARTED.store(false, Ordering::SeqCst);
                log::error!(
                    "voice-typing: HID event tap not created (input-monitoring={} accessibility={})",
                    listen_event_authorized(),
                    crate::voice_typing::is_accessibility_trusted(),
                );
                let _ = tx.send(false);
                return;
            }
            TAP_MODE.store(mode, Ordering::SeqCst);
            TAP_PORT.store(port as *mut c_void, Ordering::SeqCst);
            let source = CFMachPortCreateRunLoopSource(std::ptr::null(), port, 0);
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
            CGEventTapEnable(port, true);
            log::info!("voice-typing: modifier-key HID tap started ({} mode)", tap_mode());
            let _ = tx.send(true);
            CFRunLoopRun();
        });
        match rx.recv_timeout(std::time::Duration::from_secs(1)) {
            Ok(created) => created,
            Err(_) => {
                // Leave STARTED as-is: if creation succeeds late, the status
                // query catches up (it also checks TAP_MODE); if it fails, the
                // thread resets STARTED itself.
                log::warn!("voice-typing: HID tap thread didn't report within 1s");
                false
            }
        }
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
    pub fn tap_mode() -> &'static str {
        "none"
    }
    pub fn ensure_started(_app: AppHandle, _force: bool) -> bool {
        false
    }
}
