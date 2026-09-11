//! The application menu bar.
//!
//! This used to be `Menu::default()` plus an appended "Diagnostics" submenu.
//! It is spelled out by hand now for one reason: on macOS an NSMenu key
//! equivalent is matched by AppKit *before* the event reaches the webview, so
//! any chord we want the menu bar to show has to BE a menu item — and
//! `Menu::default()`'s View submenu carries no stable id to append into. The
//! rest of this file therefore mirrors `Menu::default()` item for item (see
//! tauri-2.11.2/src/menu/menu.rs, `fn default`) so nothing standard is lost,
//! and adds our own items around it.
//!
//! The frontend's command table (src/lib/commands/registry.ts) is the source of
//! truth for every accelerator here: a chord listed there with a `native` field
//! is deliberately NOT bound by the webview on macOS, because this file claims
//! it. Change one without the other and the shortcut either dies or fires
//! twice.
//!
//! Menu labels are English on purpose, even though the app itself is bilingual.
//! Tauri's own File/Edit/Window/Help submenus and every predefined item are
//! English regardless of app locale, and Rust has no way to reach the
//! TypeScript i18n dictionary — a half-translated menu bar reads worse than an
//! English one.
//!
//! Diagnostics is unchanged: "View Logs" emits `menu://view-logs`, which the
//! frontend turns into a standalone, movable log-viewer window (like Settings).
//! The on-disk caches (transcription, diarization) are cleared directly. The
//! webview-side caches live in localStorage, so those are cleared via events
//! the frontend listens for: the analysis cache via `cache://clear-analysis`,
//! and the saved speaker names (part of the diarization result) via
//! `cache://clear-speakers`.

use tauri::menu::{
    AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

/// Menu items that stand for a frontend command carry the id
/// `cmd:<scope>:<command-id>`, e.g. `cmd:main:nav.home`.
///
/// The scope travels *in the id* so that `on_event` can route a click without a
/// second copy of the command table over here. A Rust-side list of "which
/// command belongs to which window" would be a duplicate of
/// src/lib/commands/registry.ts that nothing checks, and duplicates of that
/// table are exactly what the table was introduced to kill.
const CMD_PREFIX: &str = "cmd:";

/// Event the frontend listens on; payload is the bare command id ("nav.home").
const CMD_EVENT: &str = "menu://command";

/// The main window's label (Tauri's default for the window in tauri.conf.json).
const MAIN_WINDOW: &str = "main";

/// A menu item that routes back to a frontend command. `scope` and `id` come
/// from the command table; `accel` must match that row's `native` field.
///
/// macOS-only, like every caller: off macOS the webview binds these chords
/// itself and there is no menu bar to put them in.
#[cfg(target_os = "macos")]
fn command_item<R: Runtime>(
    handle: &AppHandle<R>,
    scope: &str,
    id: &str,
    label: &str,
    accel: &str,
) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(
        handle,
        format!("{CMD_PREFIX}{scope}:{id}"),
        label,
        true,
        Some(accel),
    )
}

/// Build the app menu.
pub fn build<R: Runtime>(handle: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg_info = handle.package_info();
    let config = handle.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    // ── our items ───────────────────────────────────────────────────────────
    // Everything below is macOS-only. The main window is undecorated on
    // Windows and renders no menu bar at all, so off macOS these items would be
    // invisible — and worse than invisible: `claimedByMenuBar()` in
    // src/lib/commands/bind.ts returns false off macOS precisely so the webview
    // keeps binding these chords itself. Claiming them here too would be the
    // double fire that the `native` field exists to prevent.
    #[cfg(target_os = "macos")]
    let settings = command_item(handle, "global", "settings.open", "Settings…", "CmdOrCtrl+,")?;

    #[cfg(target_os = "macos")]
    let zoom_in = command_item(handle, "global", "zoom.in", "Zoom In", "CmdOrCtrl+=")?;
    #[cfg(target_os = "macos")]
    let zoom_out = command_item(handle, "global", "zoom.out", "Zoom Out", "CmdOrCtrl+-")?;
    #[cfg(target_os = "macos")]
    let zoom_reset = command_item(handle, "global", "zoom.reset", "Actual Size", "CmdOrCtrl+0")?;
    #[cfg(target_os = "macos")]
    let toggle_sidebar = command_item(
        handle,
        "main",
        "view.toggleSidebar",
        "Toggle Sidebar",
        "CmdOrCtrl+B",
    )?;

    #[cfg(target_os = "macos")]
    let nav_home = command_item(handle, "main", "nav.home", "Home", "CmdOrCtrl+1")?;
    #[cfg(target_os = "macos")]
    let nav_library = command_item(handle, "main", "nav.library", "Library", "CmdOrCtrl+2")?;
    // `nav.study` in the table; "Current Recording" is what it means to a user —
    // the replay workbench for the recording that is already open.
    #[cfg(target_os = "macos")]
    let nav_study = command_item(handle, "main", "nav.study", "Current Recording", "CmdOrCtrl+3")?;
    #[cfg(target_os = "macos")]
    let nav_back = command_item(handle, "main", "nav.back", "Back", "CmdOrCtrl+[")?;
    #[cfg(target_os = "macos")]
    let nav_forward = command_item(handle, "main", "nav.forward", "Forward", "CmdOrCtrl+]")?;
    #[cfg(target_os = "macos")]
    let nav_jump = command_item(handle, "main", "nav.jumpTo", "Jump to…", "CmdOrCtrl+K")?;

    #[cfg(target_os = "macos")]
    let meeting_start = command_item(handle, "main", "meeting.start", "Start Meeting", "CmdOrCtrl+R")?;
    #[cfg(target_os = "macos")]
    let meeting_pause = command_item(
        handle,
        "main",
        "meeting.togglePause",
        "Pause or Resume Recording",
        "Shift+CmdOrCtrl+P",
    )?;

    #[cfg(target_os = "macos")]
    let shortcuts = command_item(
        handle,
        "global",
        "shortcuts.show",
        "Keyboard Shortcuts",
        "Shift+Slash",
    )?;

    // ── Diagnostics (unchanged) ─────────────────────────────────────────────
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

    // ── the standard submenus, reproduced from Menu::default() ──────────────
    // Both keep Tauri's reserved ids: on macOS the app promotes them to NSApp's
    // windowsMenu / helpMenu, which is what makes "Window" list the open
    // windows and Help get the search field.
    let window_menu = Submenu::with_id_and_items(
        handle,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::close_window(handle, None)?,
        ],
    )?;

    let help_menu = Submenu::with_id_and_items(
        handle,
        HELP_SUBMENU_ID,
        "Help",
        true,
        &[
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::about(handle, None, Some(about_metadata))?,
            #[cfg(target_os = "macos")]
            &shortcuts,
        ],
    )?;

    let menu = Menu::with_items(
        handle,
        &[
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                handle,
                pkg_info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(handle, None, Some(about_metadata))?,
                    &PredefinedMenuItem::separator(handle)?,
                    // Where macOS users look for it, with the chord they expect.
                    &settings,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::services(handle, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::hide(handle, None)?,
                    &PredefinedMenuItem::hide_others(handle, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::quit(handle, None)?,
                ],
            )?,
            #[cfg(not(any(
                target_os = "linux",
                target_os = "dragonfly",
                target_os = "freebsd",
                target_os = "netbsd",
                target_os = "openbsd"
            )))]
            &Submenu::with_items(
                handle,
                "File",
                true,
                &[
                    // ⌘W lives here (and in Window) already, which is why the
                    // command table marks `window.close` as owned by the OS.
                    &PredefinedMenuItem::close_window(handle, None)?,
                    #[cfg(not(target_os = "macos"))]
                    &PredefinedMenuItem::quit(handle, None)?,
                ],
            )?,
            &Submenu::with_items(
                handle,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(handle, None)?,
                    &PredefinedMenuItem::redo(handle, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::cut(handle, None)?,
                    &PredefinedMenuItem::copy(handle, None)?,
                    &PredefinedMenuItem::paste(handle, None)?,
                    &PredefinedMenuItem::select_all(handle, None)?,
                ],
            )?,
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                handle,
                "View",
                true,
                &[
                    &zoom_in,
                    &zoom_out,
                    &zoom_reset,
                    &PredefinedMenuItem::separator(handle)?,
                    &toggle_sidebar,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::fullscreen(handle, None)?,
                ],
            )?,
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                handle,
                "Go",
                true,
                &[
                    &nav_home,
                    &nav_library,
                    &nav_study,
                    &PredefinedMenuItem::separator(handle)?,
                    &nav_back,
                    &nav_forward,
                    &PredefinedMenuItem::separator(handle)?,
                    &nav_jump,
                ],
            )?,
            #[cfg(target_os = "macos")]
            &Submenu::with_items(handle, "Meeting", true, &[&meeting_start, &meeting_pause])?,
            &window_menu,
            &diagnostics,
            &help_menu,
        ],
    )?;

    Ok(menu)
}

/// Handle a click on one of our menu items (ignores the default ones).
pub fn on_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Some(rest) = id.strip_prefix(CMD_PREFIX) {
        route_command(app, rest);
        return;
    }
    match id {
        // Open the standalone, movable Field Log window (the frontend listens for
        // this and opens/focuses the diagnostics webview). The window itself has a
        // "reveal in Finder" affordance for the on-disk rotating log folder.
        "view_logs" => {
            let _ = app.emit("menu://view-logs", ());
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

/// Deliver a `cmd:<scope>:<id>` click to the window that can act on it.
///
/// Only the SCOPE is interpreted here — the command id is passed through
/// untouched, so adding a row to the frontend's command table never means
/// editing this function.
fn route_command<R: Runtime>(app: &AppHandle<R>, rest: &str) {
    let Some((scope, command)) = rest.split_once(':') else {
        log::warn!("menu: malformed command id {CMD_PREFIX}{rest}");
        return;
    };

    let label = match scope {
        // Every window installs the global commands, so the click belongs to
        // whichever one the user is looking at. Broadcasting would be wrong,
        // not merely wasteful: page zoom is per-window, so ⌘= from the menu
        // would resize every open window at once.
        //
        // Found by scanning rather than via `get_focused_window()`, which sits
        // behind Tauri's `unstable` feature — not worth turning that on for one
        // lookup over a handful of windows.
        "global" => app
            .webview_windows()
            .into_iter()
            .find(|(_, win)| win.is_focused().unwrap_or(false))
            .map(|(label, _)| label)
            .unwrap_or_else(|| MAIN_WINDOW.to_string()),
        // Only the main window's shell can navigate or start a meeting. Bring it
        // forward first: picking "Go → Home" from the Settings window should
        // show you the result, not change something behind your back.
        "main" => {
            if let Some(win) = app.get_webview_window(MAIN_WINDOW) {
                let _ = win.show();
                let _ = win.set_focus();
            } else {
                log::warn!("menu: no main window for {command}");
                return;
            }
            MAIN_WINDOW.to_string()
        }
        _ => {
            log::warn!("menu: unroutable scope {scope} for {command}");
            return;
        }
    };

    if let Err(e) = app.emit_to(label.as_str(), CMD_EVENT, command) {
        log::warn!("menu: emit {command} to {label} failed: {e}");
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
