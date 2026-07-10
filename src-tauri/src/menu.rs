//! Native (macOS menu-bar) diagnostics menu: open the Field Log window, and clear
//! the caches. "View Logs" emits `menu://view-logs`, which the frontend turns into
//! a standalone, movable log-viewer window (like Settings).
//! Built on top of the platform default menu so the standard items
//! (Quit, Edit, Window, …) stay intact. The on-disk caches (transcription,
//! diarization) are cleared directly. The webview-side caches live in
//! localStorage, so those are cleared via events the frontend listens for: the
//! analysis cache via `cache://clear-analysis`, and the saved speaker names (part
//! of the diarization result) via `cache://clear-speakers`.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

/// Build the app menu: platform default + a "Diagnostics" submenu.
pub fn build<R: Runtime>(handle: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(handle)?;

    let view_logs = MenuItem::with_id(handle, "view_logs", "View Logs", true, None::<&str>)?;

    let clear_tx = MenuItem::with_id(
        handle,
        "clear_cache_transcription",
        "Transcription Cache",
        true,
        None::<&str>,
    )?;
    let clear_dz = MenuItem::with_id(
        handle,
        "clear_cache_diarization",
        "Diarization Cache",
        true,
        None::<&str>,
    )?;
    let clear_an = MenuItem::with_id(
        handle,
        "clear_cache_analysis",
        "Analysis Cache",
        true,
        None::<&str>,
    )?;
    let clear_all = MenuItem::with_id(handle, "clear_cache_all", "All Caches", true, None::<&str>)?;
    let clear_sub = Submenu::with_items(
        handle,
        "Clear Cache",
        true,
        &[
            &clear_tx,
            &clear_dz,
            &clear_an,
            &PredefinedMenuItem::separator(handle)?,
            &clear_all,
        ],
    )?;

    let diagnostics = Submenu::with_items(
        handle,
        "Diagnostics",
        true,
        &[
            &view_logs,
            &PredefinedMenuItem::separator(handle)?,
            &clear_sub,
        ],
    )?;

    menu.append(&diagnostics)?;

    // "Translate" menu: opens the standalone Live Translation window (the frontend
    // listens for `menu://live-translate` and opens/focuses the webview).
    let live_translate = MenuItem::with_id(
        handle,
        "live_translate",
        "Live Translation…",
        true,
        None::<&str>,
    )?;
    let translate = Submenu::with_items(handle, "Translate", true, &[&live_translate])?;
    menu.append(&translate)?;

    Ok(menu)
}

/// Handle a click on one of our menu items (ignores the default ones).
pub fn on_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        // Open the standalone, movable Field Log window (the frontend listens for
        // this and opens/focuses the diagnostics webview). The window itself has a
        // "reveal in Finder" affordance for the on-disk rotating log folder.
        "view_logs" => {
            let _ = app.emit("menu://view-logs", ());
        }
        // Open the standalone Live Translation window (mic → Gemini translate →
        // output device); the frontend turns this into a webview window.
        "live_translate" => {
            let _ = app.emit("menu://live-translate", ());
        }
        "clear_cache_transcription" => {
            clear_cache_dir(app, "transcriptions");
            notify(app, "Transcription cache cleared.");
        }
        "clear_cache_diarization" => {
            clear_cache_dir(app, "diarizations");
            // The cluster cache is on disk; the speaker NAMES live in the webview's
            // localStorage, so clear those via an event too.
            let _ = app.emit("cache://clear-speakers", ());
            notify(app, "Diarization cache cleared.");
        }
        "clear_cache_analysis" => {
            let _ = app.emit("cache://clear-analysis", ());
            notify(app, "Analysis cache cleared.");
        }
        "clear_cache_all" => {
            clear_cache_dir(app, "transcriptions");
            clear_cache_dir(app, "diarizations");
            let _ = app.emit("cache://clear-analysis", ());
            let _ = app.emit("cache://clear-speakers", ());
            notify(app, "All caches cleared.");
        }
        _ => {}
    }
}

/// Remove a subdirectory of the OS app-cache dir (recreated lazily on next write).
fn clear_cache_dir<R: Runtime>(app: &AppHandle<R>, name: &str) {
    if let Ok(cache) = app.path().app_cache_dir() {
        let dir = cache.join(name);
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => log::info!("menu: cleared cache {}", dir.display()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::warn!("menu: clear cache {} failed: {e}", dir.display()),
        }
    }
}

/// Non-blocking confirmation dialog.
fn notify<R: Runtime>(app: &AppHandle<R>, msg: &str) {
    app.dialog().message(msg).title("Parley").show(|_| {});
}
