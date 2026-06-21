//! Native (macOS menu-bar) diagnostics menu: open the log folder, and clear the
//! caches. Built on top of the platform default menu so the standard items
//! (Quit, Edit, Window, …) stay intact. The on-disk caches (transcription,
//! diarization) are cleared directly; the analysis cache lives in the webview's
//! localStorage, so that one is cleared via a `cache://clear-analysis` event the
//! frontend listens for.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// Build the app menu: platform default + a "Diagnostics" submenu.
pub fn build<R: Runtime>(handle: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(handle)?;

    let view_logs = MenuItem::with_id(handle, "view_logs", "View Logs", true, None::<&str>)?;

    let clear_tx =
        MenuItem::with_id(handle, "clear_cache_transcription", "Transcription Cache", true, None::<&str>)?;
    let clear_dz =
        MenuItem::with_id(handle, "clear_cache_diarization", "Diarization Cache", true, None::<&str>)?;
    let clear_an =
        MenuItem::with_id(handle, "clear_cache_analysis", "Analysis Cache", true, None::<&str>)?;
    let clear_all = MenuItem::with_id(handle, "clear_cache_all", "All Caches", true, None::<&str>)?;
    let clear_sub = Submenu::with_items(
        handle,
        "Clear Cache",
        true,
        &[&clear_tx, &clear_dz, &clear_an, &PredefinedMenuItem::separator(handle)?, &clear_all],
    )?;

    let diagnostics = Submenu::with_items(
        handle,
        "Diagnostics",
        true,
        &[&view_logs, &PredefinedMenuItem::separator(handle)?, &clear_sub],
    )?;

    menu.append(&diagnostics)?;
    Ok(menu)
}

/// Handle a click on one of our menu items (ignores the default ones).
pub fn on_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "view_logs" => open_logs(app),
        "clear_cache_transcription" => {
            clear_cache_dir(app, "transcriptions");
            notify(app, "Transcription cache cleared.");
        }
        "clear_cache_diarization" => {
            clear_cache_dir(app, "diarizations");
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
            notify(app, "All caches cleared.");
        }
        _ => {}
    }
}

/// Reveal the rotating log folder in the file manager.
fn open_logs<R: Runtime>(app: &AppHandle<R>) {
    match app.path().app_log_dir() {
        Ok(dir) => {
            let _ = std::fs::create_dir_all(&dir);
            if let Err(e) = app.opener().open_path(dir.to_string_lossy().into_owned(), None::<&str>) {
                log::warn!("menu: open logs failed: {e}");
            }
        }
        Err(e) => log::warn!("menu: app_log_dir unavailable: {e}"),
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
