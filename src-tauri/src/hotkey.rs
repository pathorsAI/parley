//! Global push-to-talk key listener for voice typing.
//!
//! Two trigger mechanisms, picked by the user:
//!   - Key combos — the boot default (Option+Space on macOS, Ctrl+Alt+Space on
//!     Windows) or any user-recorded `combo:<modifiers+Key>` (e.g.
//!     `combo:control+shift+KeyD`, `combo:F6`), handled by the cross-platform
//!     `tauri-plugin-global-shortcut` (Carbon `RegisterEventHotKey` on macOS).
//!     Needs NO extra permission — this is the out-of-the-box path.
//!   - `fn` / `right-option` / `right-command` / `right-control` — single
//!     modifier keys held as push-to-talk. On Windows only `right-control`
//!     (right Ctrl) and `right-option` (right Alt, the key in the same place)
//!     exist, delivered by a low-level keyboard hook that needs no permission
//!     — see `hotkey/windows_hook.rs`. On macOS all four are handled by an
//!     event tap (`kCGSessionEventTap`),
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
//! parks the HID tap (it matches nothing) or removes the Windows hook;
//! selecting a modifier unregisters all combos and arms the tap / hook on that
//! key.
//!
//! While a dictation is cancellable, Esc cancels it: a global shortcut armed
//! and disarmed by the frontend (`set_voice_typing_cancel_armed`), plus the
//! Windows hook for an Esc under a held right Ctrl / right Alt.
//!
//! Auto-paste is a separate concern with a separate gate: Accessibility on
//! macOS, nothing at all on Windows (see voice_typing.rs).

#![allow(unexpected_cfgs)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState,
};

/// Key transitions → push-to-talk start/stop for a held modifier. Only the
/// Windows hook drives it, but it is compiled into every test build so its
/// unit tests run on macOS CI too.
#[cfg(any(target_os = "windows", test))]
mod modifier_ptt;
#[cfg(target_os = "windows")]
mod windows_hook;
#[cfg(target_os = "windows")]
use windows_hook as imp;

/// The modifier-key ids handled by the HID tap on macOS and the low-level
/// keyboard hook on Windows (everything else is a combo). Windows delivers only
/// the right Ctrl / right Alt ones; an id a platform can't deliver reports as
/// inert rather than pretending — see `modifier_status`.
const MODIFIER_IDS: [&str; 4] = ["fn", "right-option", "right-command", "right-control"];

/// The Option+Space global shortcut handled by the global-shortcut plugin.
fn alt_space() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT), Code::Space)
}

/// The current selection id. `None` until the frontend applies the saved
/// setting at startup — until then [`status`] reports [`BOOT_DEFAULT_ID`].
static CURRENT: Mutex<Option<String>> = Mutex::new(None);

/// The trigger [`register_boot_trigger`] registers at launch, and therefore
/// what [`status`] must report before the frontend applies the saved
/// selection. It differs per platform because Alt+Space is the native window
/// system menu on Windows — see [`register_boot_trigger`] for why we don't
/// claim it there.
#[cfg(target_os = "macos")]
const BOOT_DEFAULT_ID: &str = "alt-space";
#[cfg(target_os = "windows")]
const BOOT_DEFAULT_ID: &str = "combo:control+alt+Space";
/// Nothing is registered at boot on other platforms (voice typing has no
/// implementation there), but [`status`] still needs an id to name.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const BOOT_DEFAULT_ID: &str = "alt-space";

/// Whether the active combo actually registered with the OS (a combo can fail
/// if another app owns it). [`register_boot_trigger`] stores the boot
/// registration's real result on both shipping platforms. On a platform where
/// it registers nothing this reads optimistically until the frontend applies
/// the saved selection — which is also the first moment a trigger could exist
/// there at all, so nobody is misled about a live one.
static COMBO_OK: AtomicBool = AtomicBool::new(true);

/// What every push-to-talk trigger emits: the combo handler below, the macOS
/// HID tap and the Windows keyboard hook alike, so the dictation host cannot
/// tell them apart.
pub(crate) const PTT_EVENT: &str = "voicetyping://ptt";

/// Push-to-talk for a key-combo trigger: key down starts, key up ends.
///
/// Attached to the one trigger shortcut (`on_shortcut`), never installed as the
/// plugin-wide `Builder::with_handler`. The plugin calls a plugin-wide handler
/// for EVERY shortcut it has registered, including the ones host.ts registers
/// from JS — the dictionary suggestion's ⌥↩ — so each of those used to start a
/// dictation too. The plugin also runs handlers while it holds its
/// shortcut-map lock, and registering takes that lock: never (un)register a
/// shortcut from inside a handler.
fn on_ptt(app: &AppHandle, _sc: &Shortcut, ev: ShortcutEvent) {
    let down = ev.state == ShortcutState::Pressed;
    let _ = app.emit(PTT_EVENT, serde_json::json!({ "down": down }));
}

/// Register `sc` as the push-to-talk combo. A failure — another app owns the
/// combo — is logged (`what` names the attempt) and answered false; it is
/// never fatal.
fn register_trigger(app: &AppHandle, sc: Shortcut, what: &str) -> bool {
    app.global_shortcut()
        .on_shortcut(sc, on_ptt)
        .map_err(|e| log::warn!("voice-typing: {what} {sc} failed: {e}"))
        .is_ok()
}

/// Register the boot default until the frontend applies the saved selection
/// (see [`set_voice_typing_shortcut`], called from the voice-typing host).
///
/// The two shipping platforms deliberately take a DIFFERENT key. Alt+Space is
/// the conventional dictation trigger on macOS, but on Windows it is the native
/// window system menu (the Move/Size/Close popup every window has), and
/// claiming it globally would swallow that menu for the whole session. Windows
/// therefore boots on Ctrl+Alt+Space, which is also what the frontend defaults
/// the saved setting to, so applying the setting re-registers the same combo
/// rather than moving the user's shortcut out from under them. Nowhere else
/// registers anything: voice typing has no implementation to drive there (see
/// voice_typing.rs).
///
/// Called from the app's setup rather than handed to the plugin's builder:
/// there, a boot combo the OS refused (on Windows, one another app already
/// owns) failed the plugin's own setup, which failed the app build and
/// panicked at launch. Here it is a logged warning and a "not active" trigger
/// in Settings.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub fn register_boot_trigger(app: &AppHandle) {
    let ok =
        parse_combo(BOOT_DEFAULT_ID).is_some_and(|sc| register_trigger(app, sc, "boot register"));
    COMBO_OK.store(ok, Ordering::SeqCst);
}

/// Nothing to register off macOS and Windows (see the shipping variant).
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn register_boot_trigger(_app: &AppHandle) {}

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

/// The selection id in effect: the saved one once the frontend has applied it,
/// the boot default before that.
fn current_id() -> String {
    CURRENT
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| BOOT_DEFAULT_ID.to_string())
}

// ── Esc cancels a dictation ──────────────────────────────────────────────────
//
// host.ts arms the cancel from a press until the dictation's text is committed
// to the clipboard, and disarms it after. While armed, Esc is a global
// shortcut (Carbon `RegisterEventHotKey` / Win32 `RegisterHotKey`) that only
// Parley receives; the rest of the time it belongs to the app in front.

/// Esc cancelled the dictation. Payload `{ "fromTrigger": bool }`: true when
/// the Windows hook caught it under the held trigger and swallowed it, which
/// also silences that trigger's release (see `windows_hook::deliver`).
pub(crate) const CANCEL_EVENT: &str = "voicetyping://cancel";

/// A dictation is cancellable right now. The Windows hook reads it on every
/// key, so it is the Rust side's own record rather than a JS mirror.
pub(crate) static CANCEL_ARMED: AtomicBool = AtomicBool::new(false);

/// The Esc shortcuts registered while armed, so disarming removes exactly
/// those and never the push-to-talk trigger.
static CANCEL_REGISTERED: Mutex<Vec<Shortcut>> = Mutex::new(Vec::new());

/// Esc pressed while armed. Only the press: a held Esc must not cancel twice,
/// and the release means nothing. Like [`on_ptt`], it runs under the plugin's
/// shortcut-map lock, so it only emits.
fn on_cancel(app: &AppHandle, _sc: &Shortcut, ev: ShortcutEvent) {
    if ev.state != ShortcutState::Pressed {
        return;
    }
    log::info!("voice-typing: escape cancel (shortcut)");
    let _ = app.emit(CANCEL_EVENT, serde_json::json!({ "fromTrigger": false }));
}

/// Escape chords the OS reserves, which the cancel never claims even when the
/// held trigger would need them: on Windows Ctrl+Esc (Start), Alt+Esc and
/// Alt+Shift+Esc (cycle windows), Ctrl+Shift+Esc (Task Manager) and anything
/// with the Windows key; on macOS ⌘⌥Esc (Force Quit) and ⌘⌥⇧Esc (force quit
/// the front app).
fn reserved_escape(mods: Modifiers, windows: bool) -> bool {
    if windows {
        mods.contains(Modifiers::SUPER)
            || [
                Modifiers::CONTROL,
                Modifiers::ALT,
                Modifiers::ALT | Modifiers::SHIFT,
                Modifiers::CONTROL | Modifiers::SHIFT,
            ]
            .contains(&mods)
    } else {
        mods.contains(Modifiers::SUPER | Modifiers::ALT)
    }
}

/// The Esc shortcuts that cancel a dictation started by trigger `id`.
///
/// Carbon and `RegisterHotKey` match modifiers exactly, so a bare Esc never
/// fires while the user is still holding a trigger that has one: holding
/// ⌥Space and pressing Esc arrives as ⌥Esc. Each trigger therefore also gets
/// Esc with the modifiers it holds — except where the OS reserves that chord,
/// and except Windows' right Ctrl / right Alt, whose Esc the keyboard hook
/// catches before any hotkey could (`modifier_ptt`). `fn` is not a hotkey
/// modifier, so fn+Esc should match the bare Esc (a manual check in
/// docs/TESTING.md). A shortcut equal to the trigger
/// itself is dropped: the plugin keys its handlers by chord, so registering it
/// would replace push-to-talk, and disarming would then unregister it.
/// `windows` picks the platform rules, so both are testable anywhere.
fn cancel_shortcuts_for(id: &str, windows: bool) -> Vec<Shortcut> {
    let trigger = parse_combo(id);
    let held = match id {
        _ if windows && MODIFIER_IDS.contains(&id) => None,
        "right-option" => Some(Modifiers::ALT),
        "right-command" => Some(Modifiers::SUPER),
        "right-control" => Some(Modifiers::CONTROL),
        "fn" => None,
        // `alt-space` and every recorded combo: the modifiers it is held with.
        _ => trigger.map(|sc| sc.mods),
    };
    let mut out = vec![Shortcut::new(None, Code::Escape)];
    // The variant always has modifiers, so it never repeats the bare Esc.
    if let Some(mods) = held.filter(|m| !m.is_empty() && !reserved_escape(*m, windows)) {
        out.push(Shortcut::new(Some(mods), Code::Escape));
    }
    out.retain(|sc| trigger.is_none_or(|t| t.id() != sc.id()));
    out
}

/// Arm or disarm Esc for cancelling the current dictation (host.ts). Sync on
/// purpose, like [`set_voice_typing_shortcut`]: it runs on the main thread,
/// where the plugin's registration runs inline. A repeat of the current state
/// does nothing, so the frontend keeps no mirror of it.
#[tauri::command]
pub fn set_voice_typing_cancel_armed(app: AppHandle, armed: bool) {
    if CANCEL_ARMED.swap(armed, Ordering::SeqCst) == armed {
        return;
    }
    apply_cancel_shortcuts(&app);
}

/// Bring the registered Esc shortcuts in line with [`CANCEL_ARMED`] and the
/// current trigger. A shortcut that does not register — another app owns
/// Esc, macOS 15's refusal of Option-only hotkeys, a chord the OS keeps — is
/// logged and skipped; the other one may still work. Main thread only (every
/// caller is): it holds [`CANCEL_REGISTERED`] across the plugin calls, which
/// would otherwise wait on the main thread.
fn apply_cancel_shortcuts(app: &AppHandle) {
    let gs = app.global_shortcut();
    let mut registered = CANCEL_REGISTERED.lock().unwrap();
    for sc in registered.drain(..) {
        if let Err(e) = gs.unregister(sc) {
            log::warn!("voice-typing: escape cancel {sc} not unregistered: {e}");
        }
    }
    if !CANCEL_ARMED.load(Ordering::SeqCst) {
        return;
    }
    for sc in cancel_shortcuts_for(&current_id(), cfg!(target_os = "windows")) {
        match gs.on_shortcut(sc, on_cancel) {
            Ok(()) => registered.push(sc),
            Err(e) => log::warn!("voice-typing: escape cancel {sc} not registered: {e}"),
        }
    }
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
    /// that observes but can't swallow), `hook` (Windows low-level keyboard
    /// hook, which observes and swallows only the Esc that cancels a held
    /// dictation), or `none` (nothing live).
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
    // Drop every combo we own (ours is the only user of the plugin), the Esc
    // cancel included — it is re-applied below for the new trigger.
    let _ = gs.unregister_all();
    CANCEL_REGISTERED.lock().unwrap().clear();
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
            Some(sc) => register_trigger(&app, sc, "register"),
            None => {
                log::warn!("voice-typing: unparsable shortcut {shortcut:?}");
                false
            }
        };
        COMBO_OK.store(ok, Ordering::SeqCst);
    }
    *CURRENT.lock().unwrap() = Some(shortcut);
    // The held-trigger Esc variant follows the trigger (and a change made
    // mid-dictation keeps the cancel armed).
    apply_cancel_shortcuts(&app);
    status()
}

/// Current listener status for Settings.
#[tauri::command]
pub fn voice_typing_hotkey_status() -> HotkeyStatus {
    status()
}

fn status() -> HotkeyStatus {
    let id = current_id();
    if MODIFIER_IDS.contains(&id.as_str()) {
        modifier_status(id)
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

/// Status for one of the [`MODIFIER_IDS`], which the HID event tap delivers.
#[cfg(target_os = "macos")]
fn modifier_status(id: String) -> HotkeyStatus {
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
}

/// Status for one of the [`MODIFIER_IDS`] on Windows, where a low-level
/// keyboard hook delivers right Ctrl / right Alt. No permission gates the hook,
/// so a key Windows has is always authorized, and it is live exactly when the
/// hook is installed — an installation failure shows as "not active" in
/// Settings instead of a trigger that silently does nothing. `fn` and
/// `right-command` have no Windows key (a settings file written on a Mac can
/// still carry one), so they report "not authorized, not live".
///
/// This must not share the macOS branch: that one tests
/// [`crate::voice_typing::is_accessibility_trusted`], which is always true on
/// Windows and would vouch for keys that can never fire.
#[cfg(target_os = "windows")]
fn modifier_status(id: String) -> HotkeyStatus {
    let supported = modifier_ptt::Trigger::from_id(&id).is_some();
    let active = supported && imp::is_hooked();
    HotkeyStatus {
        authorized: supported,
        active,
        mode: if active { "hook" } else { "none" }.to_string(),
        shortcut: id,
    }
}

/// Nothing delivers the [`MODIFIER_IDS`] off macOS and Windows, so the answer
/// is a flat "not authorized, not live".
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn modifier_status(id: String) -> HotkeyStatus {
    HotkeyStatus {
        authorized: false,
        active: false,
        mode: "none".to_string(),
        shortcut: id,
    }
}

/// Start the listener at app launch. Not forced: with neither permission
/// granted this is a silent no-op, so launch never registers Parley in the TCC
/// panes uninvited. (Harmless under the default Alt+Space selection since the
/// tap then matches nothing.)
pub fn init(app: AppHandle) {
    imp::ensure_started(app, false);
}

/// Watch for sleep/wake and session re-activation (NSWorkspace notifications)
/// and re-assert the push-to-talk trigger each time. Both delivery paths can
/// silently die across a sleep cycle: a Carbon hotkey registration can come
/// back inert, and a CGEventTap can be left disabled without ever receiving
/// the "disabled by timeout" callback its self-heal relies on (that callback
/// only fires when an event actually reaches the dead tap). Re-registering is
/// cheap and idempotent, so we just redo it on every wake.
pub fn install_wake_observer(app: AppHandle) {
    imp::install_wake_observer(app);
}

/// Re-apply the currently selected trigger (see [`install_wake_observer`]).
/// macOS runs it from the NSWorkspace wake block, where it repairs an inert
/// Carbon registration or a silently disabled CGEventTap. Windows runs it on
/// the main thread after `WM_POWERBROADCAST` / `PBT_APMRESUMEAUTOMATIC`, where
/// it re-registers the `RegisterHotKey` combo and — through `reenable_tap` —
/// re-installs the low-level keyboard hook, which Windows removes without
/// notice when it times out during a slow wake.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn reassert(app: &AppHandle) {
    let id = current_id();
    log::info!("voice-typing: re-asserting trigger {id:?} after wake");
    // Always revive the tap: in combo mode it's parked (matches nothing) but
    // must stay alive for the next switch back to a modifier key. (The
    // Windows hook is removed in combo mode, so there this re-installs it
    // only when a modifier key is selected.)
    imp::reenable_tap();
    if MODIFIER_IDS.contains(&id.as_str()) {
        // No-op when the tap thread is alive; recreates it if boot skipped it
        // (permission granted after launch).
        imp::ensure_started(app.clone(), false);
    } else {
        let _ = app.global_shortcut().unregister_all();
        CANCEL_REGISTERED.lock().unwrap().clear();
        let ok = parse_combo(&id).is_some_and(|sc| register_trigger(app, sc, "wake re-register"));
        COMBO_OK.store(ok, Ordering::SeqCst);
    }
    // A Carbon registration can come back inert from sleep too: re-register
    // the Esc cancel if a dictation is armed (else this only clears it).
    apply_cancel_shortcuts(app);
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

    // kCGSessionEventTap: events at the login-session level. Apple documents
    // the HID level (kCGHIDEventTap = 0) as root-only — non-root creation may
    // return NULL — and shipping event-tap apps (Hammerspoon, VoiceInk) all tap
    // at session level. Head-insert placement below still sees the modifier
    // before the frontmost app does.
    const KCG_SESSION_EVENT_TAP: u32 = 1;
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
                    let _ = app.emit(super::PTT_EVENT, serde_json::json!({ "down": now }));
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

    /// Re-enable the live tap if macOS disabled it (sleep/wake can leave a tap
    /// off without the "disabled" callback ever firing). No-op without a tap.
    pub fn reenable_tap() {
        let port = TAP_PORT.load(Ordering::SeqCst);
        if !port.is_null() {
            unsafe { CGEventTapEnable(port as CFMachPortRef, true) };
        }
    }

    /// Register NSWorkspace wake/session-activation observers that re-assert
    /// the push-to-talk trigger. Installed once at setup, lives for the app's
    /// lifetime (the notification center holds the block-based observers).
    pub fn install_wake_observer(app: AppHandle) {
        use block2::RcBlock;
        use core_foundation::base::TCFType;
        use core_foundation::string::CFString;
        use objc::runtime::Object;
        use objc::{class, msg_send, sel, sel_impl};

        // Lid-open wake, and console session re-activation (fast user
        // switching / some lock-screen returns) — either can strand the
        // trigger. NSNotificationName is an NSString, so a matching CFString
        // (toll-free bridged) subscribes to the same notification.
        const NAMES: [&str; 2] = [
            "NSWorkspaceDidWakeNotification",
            "NSWorkspaceSessionDidBecomeActiveNotification",
        ];
        unsafe {
            let ws: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
            let nc: *mut Object = msg_send![ws, notificationCenter];
            let queue: *mut Object = msg_send![class!(NSOperationQueue), mainQueue];
            for name in NAMES {
                let app = app.clone();
                let block = RcBlock::<dyn Fn(*mut std::ffi::c_void)>::new(move |_note| {
                    super::reassert(&app);
                });
                let cf = CFString::new(name);
                let name_obj = cf.as_concrete_TypeRef() as *const Object;
                let nil: *mut Object = std::ptr::null_mut();
                let _observer: *mut Object = msg_send![nc, addObserverForName: name_obj object: nil queue: queue usingBlock: &*block];
                // Never removed — the center keeps the observer + block alive;
                // forget our handle so the block isn't dropped underneath it.
                std::mem::forget(block);
            }
        }
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
                KCG_SESSION_EVENT_TAP,
                KCG_HEAD_INSERT,
                KCG_TAP_OPTION_DEFAULT,
                mask,
                callback,
                user,
            );
            if port.is_null() {
                mode = TAP_MODE_LISTEN;
                port = CGEventTapCreate(
                    KCG_SESSION_EVENT_TAP,
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
            log::info!(
                "voice-typing: modifier-key HID tap started ({} mode)",
                tap_mode()
            );
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

/// Neither a HID tap nor a keyboard hook exists off macOS and Windows, so every
/// entry point here reports "nothing is listening" and the modifier ids can
/// never go live (see `modifier_status`).
///
/// This carries ONLY the functions the shared code actually calls there; an
/// unused stub is not free, because CI compiles with `-D warnings`.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    use tauri::AppHandle;
    pub fn listen_event_authorized() -> bool {
        false
    }
    pub fn request_listen_event() -> bool {
        false
    }
    pub fn set_shortcut(_id: &str) {}
    pub fn ensure_started(_app: AppHandle, _force: bool) -> bool {
        false
    }
    pub fn install_wake_observer(_app: AppHandle) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The boot trigger is registered from this id at launch; an id that no
    /// longer parses would leave a fresh install with no trigger at all.
    #[test]
    fn the_boot_default_parses_to_a_combo() {
        assert!(parse_combo(BOOT_DEFAULT_ID).is_some());
    }

    fn esc(mods: Option<Modifiers>) -> Shortcut {
        Shortcut::new(mods, Code::Escape)
    }

    const MAC: bool = false;
    const WIN: bool = true;

    #[test]
    fn a_trigger_without_modifiers_needs_only_the_bare_escape() {
        for windows in [MAC, WIN] {
            assert_eq!(cancel_shortcuts_for("combo:F13", windows), [esc(None)]);
        }
        assert_eq!(cancel_shortcuts_for("fn", MAC), [esc(None)]);
    }

    #[test]
    fn a_held_modifier_trigger_also_gets_escape_under_that_modifier() {
        let alt = Some(Modifiers::ALT);
        assert_eq!(
            cancel_shortcuts_for("alt-space", MAC),
            [esc(None), esc(alt)]
        );
        assert_eq!(
            cancel_shortcuts_for("right-option", MAC),
            [esc(None), esc(alt)]
        );
        assert_eq!(
            cancel_shortcuts_for("right-command", MAC),
            [esc(None), esc(Some(Modifiers::SUPER))]
        );
        assert_eq!(
            cancel_shortcuts_for("right-control", MAC),
            [esc(None), esc(Some(Modifiers::CONTROL))]
        );
        assert_eq!(
            cancel_shortcuts_for("combo:control+alt+Space", WIN),
            [esc(None), esc(Some(Modifiers::CONTROL | Modifiers::ALT))]
        );
    }

    /// The keyboard hook catches Esc under a held right Ctrl / right Alt, and
    /// Ctrl+Esc / Alt+Esc are Windows' own.
    #[test]
    fn windows_leaves_the_held_modifier_keys_to_the_hook() {
        assert_eq!(cancel_shortcuts_for("right-control", WIN), [esc(None)]);
        assert_eq!(cancel_shortcuts_for("right-option", WIN), [esc(None)]);
        assert_eq!(cancel_shortcuts_for("alt-space", WIN), [esc(None)]);
    }

    #[test]
    fn chords_the_os_reserves_are_never_claimed() {
        // Task Manager.
        assert_eq!(
            cancel_shortcuts_for("combo:control+shift+KeyD", WIN),
            [esc(None)]
        );
        // Anything with the Windows key.
        assert_eq!(
            cancel_shortcuts_for("combo:super+shift+KeyV", WIN),
            [esc(None)]
        );
        // Force Quit, and its force-quit-the-front-app sibling.
        assert_eq!(
            cancel_shortcuts_for("combo:super+alt+KeyD", MAC),
            [esc(None)]
        );
        assert_eq!(
            cancel_shortcuts_for("combo:super+alt+shift+KeyD", MAC),
            [esc(None)]
        );
        // The same chord on the other platform is fine.
        assert_eq!(
            cancel_shortcuts_for("combo:control+shift+KeyD", MAC),
            [esc(None), esc(Some(Modifiers::CONTROL | Modifiers::SHIFT))]
        );
    }

    /// Registering the trigger's own chord would replace push-to-talk's
    /// handler, and disarming would unregister the trigger.
    #[test]
    fn the_trigger_itself_is_never_a_cancel() {
        for windows in [MAC, WIN] {
            assert!(cancel_shortcuts_for("combo:Escape", windows).is_empty());
            assert_eq!(
                cancel_shortcuts_for("combo:alt+Escape", windows),
                [esc(None)]
            );
        }
    }

    #[test]
    fn an_unparsable_trigger_still_gets_the_bare_escape() {
        for windows in [MAC, WIN] {
            assert_eq!(
                cancel_shortcuts_for("combo:not a key", windows),
                [esc(None)]
            );
        }
    }
}
