//! The floating overlay window: shown above every app without activating
//! Parley, and hidden again (the native work is in each platform's `imp`).

use tauri::{AppHandle, Manager};

use super::hit_rects::{start_hit_poller, OverlayHitState};
use super::imp;

/// The overlay window's label (overlay.ts creates it).
const OVERLAY_LABEL: &str = "voice-typing";

/// The overlay's native window: the NSWindow on macOS, the HWND on Windows.
#[cfg(target_os = "macos")]
pub(super) fn overlay_handle(app: &AppHandle) -> Option<imp::OverlayHandle> {
    app.get_webview_window(OVERLAY_LABEL)?.ns_window().ok()
}

#[cfg(target_os = "windows")]
pub(super) fn overlay_handle(app: &AppHandle) -> Option<imp::OverlayHandle> {
    app.get_webview_window(OVERLAY_LABEL)?.hwnd().ok()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(super) fn overlay_handle(_app: &AppHandle) -> Option<imp::OverlayHandle> {
    None
}

/// Show the overlay above ALL apps without activating Parley or stealing focus.
/// Driving visibility natively avoids Tauri's `show()`, which can bring Parley
/// to the front — and the front is exactly where it must not go, because the
/// user is dictating into another app's text field and the caret has to stay
/// there. macOS gets `orderFrontRegardless` + a floating level + all-spaces /
/// full-screen collection behaviour; Windows gets a non-activating topmost
/// `SetWindowPos` (see each platform's `imp::present_overlay`).
///
/// Where click-through is live (`imp::CLICK_THROUGH`, macOS today), the window
/// comes up click-through and stays that way except while the cursor is over
/// one of the blocks the overlay draws (see `start_hit_poller`): its
/// transparent 460×180 rectangle sits right where chat composers are, and it
/// used to swallow every click there for the length of a dictation.
#[tauri::command]
pub fn present_voice_overlay(app: AppHandle) {
    let Some(handle) = overlay_handle(&app) else {
        return;
    };
    // Before the window is on screen, so it never catches a click it should
    // not have; the poller's first tick turns capture back on under the pill.
    imp::set_pass_through(handle, true);
    imp::present_overlay(handle);
    start_hit_poller(&app);
}

/// Keep a visible overlay in front of the user as they swipe between Spaces
/// (macOS Spaces; a no-op elsewhere). Installed once at setup.
pub fn install_space_observer(app: AppHandle) {
    #[cfg(target_os = "macos")]
    imp::install_space_observer(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Hide the overlay (`orderOut:` on macOS, `SW_HIDE` on Windows), the
/// counterpart to `present_voice_overlay`.
#[tauri::command]
pub fn dismiss_voice_overlay(app: AppHandle) {
    // Stop the poller first. This runs on the main thread, as every tick does,
    // so a tick already queued sees the new generation and leaves the window
    // alone instead of turning capture back on behind the hide.
    app.state::<OverlayHitState>().poller.stop();
    let Some(handle) = overlay_handle(&app) else {
        return;
    };
    imp::set_pass_through(handle, true);
    imp::dismiss_overlay(handle);
}
