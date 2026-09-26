//! The Windows notification-area (tray) icon.
//!
//! Windows only, on purpose. On macOS the close button hides the main window
//! and the app lives on in the Dock — a Dock click brings it back (see
//! `RunEvent::Reopen` in lib.rs) and voice typing's global hotkey keeps
//! working. Windows has no Dock, so before this icon existed the close button
//! had to QUIT the app (see `exitOnClose` in src/App.tsx), which took voice
//! typing down with it. The tray icon is the somewhere-to-hide-to: closing the
//! window now hides it, and this icon is how the user gets it back, starts a
//! dictation without the hotkey, or really quits. macOS deliberately gets no
//! menu-bar icon — the Dock already does this job there.
//!
//! The menu labels start in English and are replaced by the frontend's
//! translations (`set_tray_labels`) as soon as the main window boots and
//! whenever the language changes. Unlike the native menu bar (see menu.rs),
//! this menu is ours end to end, so it can follow the app's language.
//!
//! Everything the tray asks the app to DO goes through the frontend over the
//! same channels as the other entry points:
//!
//! * **Open Parley** — [`crate::show_main_window`], the path a second launch
//!   and a macOS Dock click take.
//! * **Start/Stop voice typing** — `voicetyping://toggle`, which the
//!   voice-typing host (src/lib/voiceTyping/host.ts) runs through the SAME
//!   start/end session code as the hotkey's `voicetyping://ptt`. A menu click
//!   cannot be "held", so it toggles; the label follows the session via
//!   [`set_voice_typing_active`].
//! * **Quit** — `app://quit-requested` to the main window, which stops an
//!   active meeting before exiting (the same chain the close button used to
//!   run). A fallback exit fires if the webview never answers, so Quit can
//!   never be a dead item.

use serde::Deserialize;
use tauri::{AppHandle, Runtime};

#[cfg(target_os = "windows")]
pub use imp::{install, TrayState};

/// The tray menu's labels, as translated by the frontend.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub struct TrayLabels {
    open: String,
    start_voice_typing: String,
    stop_voice_typing: String,
    quit: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            open: "Open Parley".into(),
            start_voice_typing: "Start Voice Typing".into(),
            stop_voice_typing: "Stop Voice Typing".into(),
            quit: "Quit Parley".into(),
        }
    }
}

/// Whether the close button may hide the main window to the tray: true only
/// once the icon actually exists. The frontend falls back to quitting when this
/// is false, so a tray that failed to build can never strand a hidden window
/// the user has no way back to.
#[tauri::command]
pub fn tray_active<R: Runtime>(app: AppHandle<R>) -> bool {
    #[cfg(target_os = "windows")]
    {
        imp::is_installed(&app)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        false
    }
}

/// Replace the tray menu's labels with the frontend's translations. A no-op
/// off Windows (there is no tray), so the frontend can call it unconditionally.
#[tauri::command]
pub fn set_tray_labels<R: Runtime>(app: AppHandle<R>, labels: TrayLabels) {
    #[cfg(target_os = "windows")]
    {
        imp::update(&app, |inner| inner.labels = labels);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, labels);
    }
}

/// Keep the voice-typing item's label in step with the dictation session
/// ("Start" while idle, "Stop" while running). Called by the voice-typing
/// start/stop commands; a no-op off Windows.
pub fn set_voice_typing_active<R: Runtime>(app: &AppHandle<R>, active: bool) {
    #[cfg(target_os = "windows")]
    {
        imp::update(app, |inner| inner.voice_active = active);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, active);
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::TrayLabels;
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::{AppHandle, Emitter, Manager, Runtime};

    /// Emitted (app-wide) when the tray's voice-typing item is clicked.
    const TOGGLE_EVENT: &str = "voicetyping://toggle";

    /// Emitted to the main window when the tray's Quit item is clicked.
    const QUIT_EVENT: &str = "app://quit-requested";

    const TRAY_ID: &str = "main";
    const ITEM_OPEN: &str = "tray:open";
    const ITEM_VOICE: &str = "tray:voice-typing";
    const ITEM_QUIT: &str = "tray:quit";

    /// How long Quit waits for the frontend's orderly exit (stop an active
    /// meeting, then exit) before exiting from here. The frontend path is a
    /// single IPC round trip; this only matters if the webview is wedged.
    const QUIT_FALLBACK: std::time::Duration = std::time::Duration::from_secs(5);

    /// Managed state: the live menu items (once built), the current labels,
    /// and whether a dictation is running (which picks the voice label).
    #[derive(Default)]
    pub struct TrayState(std::sync::Mutex<Inner>);

    #[derive(Default)]
    pub(super) struct Inner {
        pub(super) labels: TrayLabels,
        pub(super) voice_active: bool,
        items: Option<Items>,
    }

    impl Inner {
        fn voice_label(&self) -> &str {
            if self.voice_active {
                &self.labels.stop_voice_typing
            } else {
                &self.labels.start_voice_typing
            }
        }
    }

    /// The menu items whose text changes after the icon is built.
    struct Items {
        open: MenuItem<tauri::Wry>,
        voice: MenuItem<tauri::Wry>,
        quit: MenuItem<tauri::Wry>,
    }

    /// Build the tray icon. Called once from `setup`.
    pub fn install(app: &AppHandle) -> tauri::Result<()> {
        let state = app.state::<TrayState>();
        // Labels are read up front and the lock released: building the icon
        // hops to the main thread, and no lock of ours should be held across
        // that.
        let (open_label, voice_label, quit_label) = {
            let inner = state.0.lock().unwrap();
            (
                inner.labels.open.clone(),
                inner.voice_label().to_string(),
                inner.labels.quit.clone(),
            )
        };
        let open = MenuItem::with_id(app, ITEM_OPEN, open_label, true, None::<&str>)?;
        let voice = MenuItem::with_id(app, ITEM_VOICE, voice_label, true, None::<&str>)?;
        let quit = MenuItem::with_id(app, ITEM_QUIT, quit_label, true, None::<&str>)?;
        let menu = Menu::with_items(
            app,
            &[&open, &voice, &PredefinedMenuItem::separator(app)?, &quit],
        )?;

        let mut builder = TrayIconBuilder::with_id(TRAY_ID)
            .tooltip("Parley")
            .menu(&menu)
            // Left click opens the window (the Windows convention for an app
            // that lives in the notification area); right click shows the menu.
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    crate::show_main_window(tray.app_handle());
                }
            });
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        builder.build(app)?;

        state.0.lock().unwrap().items = Some(Items { open, voice, quit });
        log::info!("tray: notification-area icon installed");
        Ok(())
    }

    pub(super) fn is_installed<R: Runtime>(app: &AppHandle<R>) -> bool {
        app.try_state::<TrayState>()
            .is_some_and(|state| state.0.lock().unwrap().items.is_some())
    }

    /// Change the state, then relabel the live items to match.
    ///
    /// The relabel is posted to the main thread rather than done here. Off the
    /// main thread `set_text` blocks until the main thread gets round to it,
    /// and the voice-typing stop command calls this — it must not wait behind
    /// whatever the main thread is busy with. Posting also keeps the order: the
    /// main thread runs these in sequence and each reads the state as it is by
    /// then, so a quick start → stop can never end on a stale "Stop".
    pub(super) fn update<R: Runtime>(app: &AppHandle<R>, change: impl FnOnce(&mut Inner)) {
        let Some(state) = app.try_state::<TrayState>() else {
            return;
        };
        change(&mut state.0.lock().unwrap());
        let handle = app.clone();
        if let Err(e) = app.run_on_main_thread(move || relabel(&handle)) {
            log::warn!("tray: relabel dispatch failed: {e}");
        }
    }

    /// Push the current labels onto the live items (no-op before `install`).
    /// Runs on the main thread, where `set_text` applies immediately.
    fn relabel<R: Runtime>(app: &AppHandle<R>) {
        let Some(state) = app.try_state::<TrayState>() else {
            return;
        };
        let inner = state.0.lock().unwrap();
        let Some(items) = inner.items.as_ref() else {
            return;
        };
        for (item, text) in [
            (&items.open, inner.labels.open.as_str()),
            (&items.voice, inner.voice_label()),
            (&items.quit, inner.labels.quit.as_str()),
        ] {
            if let Err(e) = item.set_text(text) {
                log::warn!("tray: relabel failed: {e}");
            }
        }
    }

    /// A tray-menu click. The handler Tauri calls here also sees every OTHER
    /// menu event in the app (menu-bar items included), so anything that is not
    /// one of ours falls through untouched — menu.rs handles those.
    fn on_menu(app: &AppHandle, id: &str) {
        match id {
            ITEM_OPEN => crate::show_main_window(app),
            ITEM_VOICE => {
                if let Err(e) = app.emit(TOGGLE_EVENT, ()) {
                    log::warn!("tray: voice-typing toggle emit failed: {e}");
                }
            }
            ITEM_QUIT => quit(app),
            _ => {}
        }
    }

    /// Ask the main window to quit (so an active meeting is stopped first),
    /// with a fallback exit in case it never does.
    fn quit(app: &AppHandle) {
        log::info!("tray: quit requested");
        if app.get_webview_window("main").is_none() || app.emit_to("main", QUIT_EVENT, ()).is_err()
        {
            app.exit(0);
            return;
        }
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(QUIT_FALLBACK);
            log::warn!("tray: frontend did not exit in time; exiting from the backend");
            app.exit(0);
        });
    }
}
