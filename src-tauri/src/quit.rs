//! Quitting Parley the orderly way.
//!
//! A live meeting's transcript exists only in the main window's page until the
//! meeting is ended and saved (the audio has its own crash journal, see
//! recording_journal.rs). An immediate exit — what AppKit's predefined Quit
//! item does on ⌘Q — therefore threw the transcript away and left the next
//! launch only the journal's audio to recover, with no summary, action items
//! or score. So every Quit Parley offers (⌘Q and the app menu's Quit item on
//! macOS, the tray's Quit on Windows) goes through [`request`] instead: the
//! main window ends an active meeting, waits for its history entry to land,
//! then exits (`quitAfterSaving` in src/App.tsx).
//!
//! The backend still exits on its own if the page never answers, so a wedged
//! webview cannot make the app unquittable: [`ACK_TIMEOUT`] for the page to
//! say it has the request ([`quit_acknowledged`]), then [`SAVE_TIMEOUT`] for
//! the save. Anything a forced exit cuts short is still in the crash journal.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Emitted to the main window: quit, after ending and saving a live meeting.
pub const QUIT_EVENT: &str = "app://quit-requested";

/// How long the page has to acknowledge the request. It is one event and one
/// IPC call, so missing it means the webview is wedged.
const ACK_TIMEOUT: Duration = Duration::from_secs(5);

/// How long an acknowledged quit may take before the backend exits anyway:
/// the stop, the encode of a long meeting, and the history write. The page
/// gives up on the save sooner than this (see `QUIT_SAVE_WAIT_MS`).
const SAVE_TIMEOUT: Duration = Duration::from_secs(90);

/// A quit is under way (requested and not yet exited).
static PENDING: AtomicBool = AtomicBool::new(false);
/// The page has the current request.
static ACKED: AtomicBool = AtomicBool::new(false);

/// Ask the main window to quit, with a backend exit as the fallback.
pub fn request<R: Runtime>(app: &AppHandle<R>) {
    if PENDING.swap(true, Ordering::SeqCst) {
        // A second ⌘Q while the meeting is still saving: the first one is
        // already on its way out, and its fallback still bounds the wait.
        log::info!("quit: already in progress");
        return;
    }
    ACKED.store(false, Ordering::SeqCst);
    log::info!("quit: requested");
    if app.get_webview_window("main").is_none() || app.emit_to("main", QUIT_EVENT, ()).is_err() {
        app.exit(0);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(ACK_TIMEOUT);
        if !ACKED.load(Ordering::SeqCst) {
            log::warn!("quit: the main window did not answer; exiting from the backend");
            app.exit(0);
            return;
        }
        std::thread::sleep(SAVE_TIMEOUT - ACK_TIMEOUT);
        log::warn!("quit: the main window did not exit in time; exiting from the backend");
        app.exit(0);
    });
}

/// The main window has the quit request and is ending the meeting.
#[tauri::command]
pub fn quit_acknowledged() {
    ACKED.store(true, Ordering::SeqCst);
}
