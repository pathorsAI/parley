//! Windows: hold right Ctrl / right Alt to dictate, via a low-level keyboard
//! hook (`WH_KEYBOARD_LL`).
//!
//! Three threads are involved, and the split is the point:
//!
//! - **The hook thread** owns a hidden top-level window and runs a
//!   `GetMessageW` loop for the app's lifetime. A low-level hook is called on
//!   the thread that installed it, through that thread's message loop, so the
//!   hook is installed (and removed, and re-installed) only here. The hidden
//!   window is also how the thread hears `WM_POWERBROADCAST`: message-only
//!   windows (`HWND_MESSAGE`) never receive broadcasts, a hidden top-level
//!   one does.
//! - **The hook callback** runs on that thread for every key press in the
//!   session and must return within a few milliseconds — Windows silently
//!   removes a hook that keeps exceeding `LowLevelHooksTimeout`. It therefore
//!   only feeds the transition to the pure [`ModifierPtt`] state machine and
//!   pushes the resulting start/stop onto a channel. It never logs, never
//!   touches Tauri and never swallows a key (`CallNextHookEx` always runs), so
//!   right Ctrl / right Alt keep working as modifiers in every app.
//! - **The dispatcher thread** drains that channel and does the slow part:
//!   logging, the `voicetyping://ptt` event (the same event the combo path in
//!   lib.rs emits, so the dictation session cannot tell the two apart), and
//!   the menu-mask keystroke for right Alt described at
//!   [`mask_menu_activation`].
//!
//! The hook is installed only while a modifier trigger is selected. With a key
//! combo selected (the default) nothing in Parley sees ordinary typing — the
//! combo is an OS `RegisterHotKey` registration — and the hook thread just
//! idles, waiting for a selection change or a resume from sleep.
//!
//! No permission is involved: any process may install a low-level keyboard
//! hook, so the trigger reports authorized unconditionally. What UIPI does
//! with an elevated ("Run as administrator") window in front is part of the
//! manual Windows check-list rather than something this code decides: either
//! the hook still sees the key and dictation runs, in which case the
//! auto-paste into that window is refused and voice_typing.rs leaves the text
//! on the clipboard, or the hook sees nothing there and the key simply does
//! nothing until a normal window is in front again.

use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU8, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::OnceLock;
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_KEYUP, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
    SendMessageTimeoutW, SetWindowsHookExW, UnhookWindowsHookEx, HC_ACTION, HHOOK, KBDLLHOOKSTRUCT,
    LLKHF_INJECTED, LLKHF_UP, MSG, PBT_APMRESUMEAUTOMATIC, SMTO_ABORTIFHUNG, WH_KEYBOARD_LL,
    WINDOW_STYLE, WM_APP, WM_POWERBROADCAST, WNDCLASSW, WS_EX_TOOLWINDOW,
};

use super::modifier_ptt::{Action, KeyEvent, ModifierPtt, Trigger};

/// The selected trigger, shared between the command threads that change it
/// and the hook callback that reads it on every key.
const SHORTCUT_NONE: u8 = 0;
const SHORTCUT_RIGHT_CTRL: u8 = 1;
const SHORTCUT_RIGHT_ALT: u8 = 2;
static SHORTCUT: AtomicU8 = AtomicU8::new(SHORTCUT_NONE);

/// The hook thread (and its window) exist.
static STARTED: AtomicBool = AtomicBool::new(false);
/// A low-level hook is installed right now.
static HOOKED: AtomicBool = AtomicBool::new(false);
/// The hook thread's hidden window, the address for every request to it.
static WINDOW: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
/// Start/stop from the hook callback to the dispatcher thread.
static EVENTS: OnceLock<Sender<(Action, Trigger)>> = OnceLock::new();
/// For the resume handler, which re-arms through the shared `reassert`.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Private message: bring the hook in line with [`SHORTCUT`]. `wParam` != 0
/// forces a fresh hook (re-arm after sleep) even when one is installed.
/// Answers 1 when a hook is installed afterwards.
const WM_SYNC_HOOK: u32 = WM_APP + 1;
/// How long a caller waits for the hook thread to answer [`WM_SYNC_HOOK`].
const SYNC_TIMEOUT_MS: u32 = 1000;
const CLASS_NAME: PCWSTR = w!("ParleyPushToTalkHook");

thread_local! {
    /// Hook-thread-only state: the installed hook and the key bookkeeping.
    static HOOK: Cell<Option<HHOOK>> = const { Cell::new(None) };
    static MACHINE: RefCell<ModifierPtt> = RefCell::new(ModifierPtt::default());
}

fn current_trigger() -> Option<Trigger> {
    match SHORTCUT.load(Ordering::SeqCst) {
        SHORTCUT_RIGHT_CTRL => Some(Trigger::RightCtrl),
        SHORTCUT_RIGHT_ALT => Some(Trigger::RightAlt),
        _ => None,
    }
}

/// No Windows permission gates a low-level keyboard hook. These two exist for
/// the macOS Input Monitoring commands, which have nothing to report here.
pub fn listen_event_authorized() -> bool {
    false
}

pub fn request_listen_event() -> bool {
    false
}

/// Whether a low-level hook is installed right now.
pub fn is_hooked() -> bool {
    HOOKED.load(Ordering::SeqCst)
}

/// Select the key the hook watches (`right-control` / `right-option`; any
/// other id watches nothing and removes the hook).
pub fn set_shortcut(id: &str) {
    let next = match Trigger::from_id(id) {
        Some(Trigger::RightCtrl) => SHORTCUT_RIGHT_CTRL,
        Some(Trigger::RightAlt) => SHORTCUT_RIGHT_ALT,
        None => SHORTCUT_NONE,
    };
    SHORTCUT.store(next, Ordering::SeqCst);
    if STARTED.load(Ordering::SeqCst) {
        sync_hook(false);
    }
}

/// Start the hook thread if it isn't running, then install or remove the hook
/// to match the selection. Returns whether a hook is installed. `force` is a
/// macOS notion (attempt a tap without a visible grant); nothing needs a
/// grant here.
pub fn ensure_started(app: AppHandle, _force: bool) -> bool {
    if !STARTED.swap(true, Ordering::SeqCst) && !start_thread(app) {
        STARTED.store(false, Ordering::SeqCst);
        return false;
    }
    sync_hook(false)
}

/// The power listener is the hook thread's own window, so installing the
/// observer is starting that thread.
pub fn install_wake_observer(app: AppHandle) {
    ensure_started(app, false);
}

/// Re-arm after a resume: drop the hook and install a fresh one. A low-level
/// hook that timed out while the machine was waking is removed without any
/// notification, so re-installing is the only way to be sure it is live.
pub fn reenable_tap() {
    if STARTED.load(Ordering::SeqCst) {
        sync_hook(true);
    }
}

fn start_thread(app: AppHandle) -> bool {
    let _ = APP.set(app.clone());
    if EVENTS.get().is_none() {
        let _ = EVENTS.set(spawn_dispatcher(app));
    }
    let (tx, rx) = channel::<bool>();
    let spawned = std::thread::Builder::new()
        .name("voice-typing-hook".into())
        .spawn(move || run_hook_thread(tx));
    if let Err(e) = spawned {
        log::error!("voice-typing: hook thread not spawned: {e}");
        return false;
    }
    match rx.recv_timeout(Duration::from_secs(1)) {
        Ok(ok) => ok,
        Err(_) => {
            log::warn!("voice-typing: hook thread didn't report within 1s");
            false
        }
    }
}

/// Ask the hook thread to bring the hook in line with the selection, and wait
/// for the answer. `SendMessageTimeoutW` runs [`window_proc`] on the hook
/// thread — the only thread allowed to install or remove its hook.
fn sync_hook(rearm: bool) -> bool {
    let hwnd = HWND(WINDOW.load(Ordering::SeqCst));
    if hwnd.0.is_null() {
        return false;
    }
    let mut answer: usize = 0;
    // SAFETY: `hwnd` is the hook thread's window, which lives as long as the
    // process; `answer` outlives the call.
    let delivered = unsafe {
        SendMessageTimeoutW(
            hwnd,
            WM_SYNC_HOOK,
            WPARAM(usize::from(rearm)),
            LPARAM(0),
            SMTO_ABORTIFHUNG,
            SYNC_TIMEOUT_MS,
            Some(&mut answer),
        )
    };
    if delivered.0 == 0 {
        log::warn!("voice-typing: hook thread didn't answer a sync request");
        return is_hooked();
    }
    answer != 0
}

fn run_hook_thread(ready: Sender<bool>) {
    let hwnd = match create_window() {
        Ok(hwnd) => hwnd,
        Err(e) => {
            log::error!("voice-typing: hook window not created: {e}");
            let _ = ready.send(false);
            return;
        }
    };
    WINDOW.store(hwnd.0, Ordering::SeqCst);
    let _ = ready.send(true);
    let mut msg = MSG::default();
    // SAFETY: plain message pump on the thread that owns the window and the
    // hook. GetMessageW returns 0 on WM_QUIT and -1 on error; both end it.
    while unsafe { GetMessageW(&mut msg, None, 0, 0) }.0 > 0 {
        unsafe { DispatchMessageW(&msg) };
    }
    log::warn!("voice-typing: hook thread message loop ended");
}

/// The module handle of this executable — the linker's `__ImageBase` symbol,
/// which avoids enabling the `LibraryLoader` feature for `GetModuleHandleW`.
fn image_base() -> HINSTANCE {
    extern "C" {
        static __ImageBase: u8;
    }
    // Only the address of the linker-provided symbol is taken (a safe
    // operation), never its value.
    HINSTANCE((&raw const __ImageBase).cast_mut().cast())
}

/// A hidden top-level window (never shown, so never on the taskbar or
/// screen). Top-level rather than message-only, because only top-level windows
/// receive `WM_POWERBROADCAST`.
fn create_window() -> windows::core::Result<HWND> {
    let instance = image_base();
    let class = WNDCLASSW {
        lpfnWndProc: Some(window_proc),
        hInstance: instance,
        lpszClassName: CLASS_NAME,
        ..Default::default()
    };
    // SAFETY: `class` is fully initialised and its strings are static.
    if unsafe { RegisterClassW(&class) } == 0 {
        return Err(windows::core::Error::from_win32());
    }
    // SAFETY: the class was just registered with this instance.
    unsafe {
        CreateWindowExW(
            WS_EX_TOOLWINDOW,
            CLASS_NAME,
            w!("Parley push-to-talk"),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            None,
            None,
            Some(instance),
            None,
        )
    }
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_SYNC_HOOK => LRESULT(isize::from(apply_selection(wparam.0 != 0))),
        WM_POWERBROADCAST if wparam.0 == PBT_APMRESUMEAUTOMATIC as usize => {
            on_resume();
            LRESULT(1)
        }
        // SAFETY: forwarding the arguments we were given.
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// Hook thread: make the installed hook match the selection. Returns whether a
/// hook is installed afterwards.
fn apply_selection(rearm: bool) -> bool {
    let trigger = current_trigger();
    let stale = MACHINE.with(|m| {
        let mut m = m.borrow_mut();
        m.set_trigger(trigger);
        if rearm {
            m.reset()
        } else {
            None
        }
    });
    if let (Some(action), Some(t)) = (stale, trigger) {
        send(action, t);
    }
    if rearm || trigger.is_none() {
        remove_hook();
    }
    match trigger {
        Some(_) => HOOK.with(Cell::get).is_some() || install_hook(),
        None => false,
    }
}

fn install_hook() -> bool {
    // SAFETY: `keyboard_proc` has the HOOKPROC signature; a global low-level
    // hook needs no module handle for code in this process.
    match unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), None, 0) } {
        Ok(hook) => {
            HOOK.with(|h| h.set(Some(hook)));
            HOOKED.store(true, Ordering::SeqCst);
            log::info!("voice-typing: low-level keyboard hook installed");
            true
        }
        Err(e) => {
            HOOKED.store(false, Ordering::SeqCst);
            // HRESULT_FROM_WIN32 keeps the Win32 code in its low 16 bits.
            let last_error = (e.code().0 as u32) & 0xFFFF;
            log::error!(
                "voice-typing: low-level keyboard hook not installed (GetLastError {last_error}): {e}"
            );
            false
        }
    }
}

fn remove_hook() {
    if let Some(hook) = HOOK.with(Cell::take) {
        // SAFETY: `hook` was installed by this thread and not yet removed.
        if let Err(e) = unsafe { UnhookWindowsHookEx(hook) } {
            log::warn!("voice-typing: UnhookWindowsHookEx failed: {e}");
        }
        log::info!("voice-typing: low-level keyboard hook removed");
    }
    HOOKED.store(false, Ordering::SeqCst);
}

fn on_resume() {
    let Some(app) = APP.get() else { return };
    log::info!("voice-typing: resumed from sleep");
    // Never re-arm on this thread: `reassert` re-registers the combo through
    // the global-shortcut plugin (main thread) and asks this thread to
    // re-install the hook, which it can only answer once this returns.
    let handle = app.clone();
    if let Err(e) = app.run_on_main_thread(move || super::reassert(&handle)) {
        log::warn!("voice-typing: couldn't schedule the wake re-arm: {e}");
    }
}

/// The hook callback. Keep it this small: see the module doc.
unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        // SAFETY: for HC_ACTION, `lparam` points at a KBDLLHOOKSTRUCT that is
        // valid for the duration of this call.
        observe(unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) });
    }
    // SAFETY: forwarding the arguments we were given; never swallow a key.
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

fn observe(info: &KBDLLHOOKSTRUCT) {
    // Synthesized input is not the user's hand on the key: our own Ctrl+V
    // paste, and anything another tool injects, must never drive dictation.
    if info.flags.0 & LLKHF_INJECTED.0 != 0 {
        return;
    }
    let Some(trigger) = current_trigger() else {
        return;
    };
    let ev = KeyEvent {
        vk: info.vkCode,
        scan_code: info.scanCode,
        up: info.flags.0 & LLKHF_UP.0 != 0,
    };
    let action = MACHINE.with(|m| {
        let mut m = m.borrow_mut();
        m.set_trigger(Some(trigger));
        m.on_key(ev, key_is_down)
    });
    if let Some(action) = action {
        send(action, trigger);
    }
}

fn key_is_down(vk: u32) -> bool {
    // SAFETY: only reads global keyboard state.
    let state = unsafe { GetAsyncKeyState(vk as i32) };
    state < 0 // the high bit is "down right now"
}

fn send(action: Action, trigger: Trigger) {
    if let Some(tx) = EVENTS.get() {
        let _ = tx.send((action, trigger));
    }
}

fn spawn_dispatcher(app: AppHandle) -> Sender<(Action, Trigger)> {
    let (tx, rx) = channel::<(Action, Trigger)>();
    let spawned = std::thread::Builder::new()
        .name("voice-typing-ptt".into())
        .spawn(move || {
            for (action, trigger) in rx {
                deliver(&app, action, trigger);
            }
        });
    if let Err(e) = spawned {
        log::error!("voice-typing: push-to-talk dispatcher not spawned: {e}");
    }
    tx
}

fn deliver(app: &AppHandle, action: Action, trigger: Trigger) {
    let down = action == Action::Start;
    log::info!(
        "voice-typing: {} {}",
        trigger.id(),
        if down { "down" } else { "up" }
    );
    if down && trigger == Trigger::RightAlt {
        mask_menu_activation();
    }
    let _ = app.emit("voicetyping://ptt", serde_json::json!({ "down": down }));
}

/// An unassigned virtual-key code (0xE8), the same "menu mask" key
/// AutoHotkey sends for the same reason.
const VK_MENU_MASK: VIRTUAL_KEY = VIRTUAL_KEY(0xE8);

/// Tap a key nobody listens to while right Alt is held.
///
/// Pressing and releasing Alt with nothing in between is how Windows opens an
/// app's menu bar from the keyboard: without this, every right-Alt dictation
/// would end with Notepad's (or Explorer's, or Office's) menu bar armed, and
/// the Ctrl+V auto-paste that follows would land in the menu instead of the
/// document. Any key between the Alt press and release cancels that, and an
/// unassigned one does nothing else. The hook ignores it (it is injected).
fn mask_menu_activation() {
    let key = |flags: KEYBD_EVENT_FLAGS| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VK_MENU_MASK,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let events = [key(KEYBD_EVENT_FLAGS(0)), key(KEYEVENTF_KEYUP)];
    // SAFETY: a live slice of initialised INPUT records and their size.
    let sent = unsafe { SendInput(&events, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != events.len() {
        // UIPI (an elevated window in front) refuses injection; the menu bar
        // may then arm, and the paste already falls back to the clipboard.
        log::warn!("voice-typing: menu-mask key injected {sent}/2 events");
    }
}
