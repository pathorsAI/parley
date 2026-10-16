use super::clipboard::Foreground;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HWND, POINT, RECT};
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
    GetCursorPos, GetForegroundWindow, GetWindowLongPtrW, GetWindowRect,
    GetWindowThreadProcessId, IsWindowVisible, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    GWL_EXSTYLE, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_HIDE,
    SW_SHOWNA, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

/// Virtual key for "V". Win32 declares no `VK_V`: the letter keys' virtual
/// codes are just their ASCII uppercase values.
const VK_V: VIRTUAL_KEY = VIRTUAL_KEY(0x56);

/// The high bit of `GetAsyncKeyState`'s result means "physically down right
/// now". The low bit is the unrelated "was pressed since the last call"
/// flag, which we must not confuse for a held key.
const KEY_DOWN_MASK: u16 = 0x8000;

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

/// The foreground window and the process id owning it. `None` when
/// nothing is foreground (a locked desktop, or a switch in flight).
fn foreground_window() -> Option<(HWND, u32)> {
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
    (pid != 0).then_some((hwnd, pid))
}

/// Process id owning the foreground window.
fn foreground_pid() -> Option<u32> {
    foreground_window().map(|(_, pid)| pid)
}

/// Whether the foreground window is one of Parley's own, and whether it
/// is on screen.
///
/// The tray is why the second half matters. tray-icon opens its menu by
/// making its own message window the foreground window (TrackPopupMenu
/// needs that to close the menu when the user clicks away), and nothing
/// hands the foreground back when the menu closes. That window is never
/// shown. So a dictation stopped from the tray settles with an invisible
/// Parley window in front, where a Ctrl+V lands nowhere — and SendInput
/// still reports it sent. Parley's visible windows (the Ask box,
/// Settings) are pasted into like any other app's.
pub fn foreground() -> Foreground {
    let Some((hwnd, pid)) = foreground_window() else {
        return Foreground::default();
    };
    let own = pid == std::process::id();
    // SAFETY: reads one window's visibility; a window destroyed since
    // `GetForegroundWindow` answers false, which reads as hidden — and
    // nothing would take the paste there either.
    let hidden = own && !unsafe { IsWindowVisible(hwnd) }.as_bool();
    Foreground { own, hidden }
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

/// The overlay's window, as `WebviewWindow::hwnd` hands it out.
pub type OverlayHandle = HWND;

/// Click-through is NOT switched on for Windows yet, pending a check on
/// real hardware (docs/TESTING.md) — nobody on the core team runs Windows.
///
/// The toggle would be WS_EX_TRANSPARENT | WS_EX_LAYERED, read-modify-write
/// on GWL_EXSTYLE (never tao's setter — see `present_overlay`). LAYERED is
/// the risk: a window made layered through SetWindowLong is not drawn until
/// SetLayeredWindowAttributes is called, and WebView2 is known not to
/// render in layered windows. Click-through would be the overlay's DEFAULT
/// state (the cursor is off the pill most of the time), so if layering
/// blanks the webview the overlay disappears for most of every dictation.
/// When enabling it: toggle only those two bits; never clear a LAYERED bit
/// that was set before the first toggle; if the webview goes blank, try one
/// `SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA)` after
/// LAYERED is first added, and failing that a SetWindowRgn built from the
/// same rects (no poller needed then).
///
/// Until then the transparent area stays a dead zone, as it always was.
/// The overlay has been WS_EX_NOACTIVATE from the start, so on Windows a
/// click there never activated Parley.
pub const CLICK_THROUGH: bool = false;

/// Where the cursor is, as a fraction of the overlay window; None while the
/// window is not on screen. Both readings are physical px: tao makes the
/// process per-monitor-v2 DPI aware. The overlay is undecorated and
/// shadowless, so its window rect is its client rect.
pub fn cursor_fraction(hwnd: HWND) -> Option<(f64, f64)> {
    // SAFETY: `hwnd` is the live overlay window and this runs on its
    // thread; the calls only read the cursor and that window's rect into
    // the locals they are handed.
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() {
            return None;
        }
        let mut cursor = POINT::default();
        GetCursorPos(&mut cursor).ok()?;
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).ok()?;
        super::fraction_top_left(
            (f64::from(cursor.x), f64::from(cursor.y)),
            (f64::from(rect.left), f64::from(rect.top)),
            (
                f64::from(rect.right - rect.left),
                f64::from(rect.bottom - rect.top),
            ),
        )
    }
}

/// No-op until Windows click-through is verified (see CLICK_THROUGH).
pub fn set_pass_through(_hwnd: HWND, _pass: bool) {}

/// Never click-through while `set_pass_through` is a no-op.
pub fn is_pass_through(_hwnd: HWND) -> bool {
    false
}
