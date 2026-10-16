//! Typing a dictation into the frontmost app: the clipboard borrow, the paste
//! chord and the permission it needs, and the frontmost-app queries.

use tauri::{AppHandle, Manager};

#[cfg(not(target_os = "windows"))]
use tauri::State;

use super::clipboard::{self, ClipboardState, SystemPasteboard};
use super::imp;

/// Copy text to the system clipboard: an explicit copy the user asked for
/// (Esc's Undo, the overlay's Copy). Through the OS because the webview's
/// `navigator.clipboard` is blocked while Parley isn't focused. Never restored
/// over — a restore still pending from the last dictation is called off.
///
/// Synchronous on macOS, so Tauri runs it on the main thread, where AppKit
/// wants the pasteboard. On Windows it runs on a blocking worker instead (see
/// `insert_text`).
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn copy_to_clipboard(state: State<'_, ClipboardState>, text: String) -> Result<(), String> {
    clipboard::copy(&mut state.lock(), &mut SystemPasteboard, &text)
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn copy_to_clipboard(app: AppHandle, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ClipboardState>();
        let mut ledger = state.lock();
        clipboard::copy(&mut ledger, &mut SystemPasteboard, &text)
    })
    .await
    .map_err(|e| format!("clipboard copy did not run: {e}"))?
}

/// Outcome of an insert: whether the paste went out, and WHO it went to.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteResult {
    /// False when no paste chord was posted and the text was left on the
    /// clipboard for the user to paste: on macOS because Accessibility isn't
    /// granted, on Windows because UIPI refused the injection (the target
    /// window belongs to an elevated process) or because the foreground
    /// window is Parley's own hidden tray window, where a paste lands nowhere.
    pasted: bool,
    /// Identifier of the app that was frontmost at paste time, sampled BEFORE
    /// the paste chord so it names the app that actually received the text.
    /// The name is macOS's: there it is the bundle identifier (e.g.
    /// "com.apple.Notes"). Windows has no such thing, so it carries the
    /// foreground process's executable file name instead (e.g. "notepad.exe"),
    /// which is the closest stable per-app key available without permissions.
    /// `None` when there is no frontmost app, when it has no bundle id (some
    /// helper processes), when the process can't be opened (Windows: a target
    /// at a higher integrity level), or on a platform with neither.
    app_bundle_id: Option<String>,
}

/// Type `text` into the frontmost app's focused field: borrow the clipboard,
/// post the paste chord, and give the clipboard back a moment later (see
/// `clipboard`), so a dictation never costs the user what they had copied.
/// Reports whether the paste went out and which app received it — the
/// dictionary's correction watcher needs to know which app's field it is
/// about to observe.
///
/// Posts nothing, and leaves the text on the clipboard to paste by hand, when
/// macOS has not granted Accessibility or Windows refuses the injection.
///
/// Parley itself in front is pasted into like any other app. The overlay
/// never activates Parley, so that is the user dictating into one of its own
/// fields (the Ask box, a meeting's context, Settings), and the paste lands
/// there. Holding it back on the clipboard told them to paste by hand a text
/// that was already in the field — doing so inserted it twice. The one
/// exception is a Parley window that is not on screen: on Windows the tray
/// menu leaves its hidden window in front, so a dictation stopped from the
/// tray stays on the clipboard (`clipboard::paste_block`).
///
/// Synchronous on macOS, so Tauri runs it on the main thread, where AppKit
/// wants the pasteboard. On Windows it runs on a blocking worker instead:
/// saving the clipboard asks the app that copied it to render what it only
/// promised, and opening the clipboard waits out whoever holds it, so on the
/// main thread an Excel range or a busy clipboard would freeze every Parley
/// window. Ctrl+V and the foreground-window queries work from any thread.
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn insert_text(app: AppHandle, text: String) -> Result<PasteResult, String> {
    insert_now(&app, &text)
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn insert_text(app: AppHandle, text: String) -> Result<PasteResult, String> {
    tauri::async_runtime::spawn_blocking(move || insert_now(&app, &text))
        .await
        .map_err(|e| format!("insert did not run: {e}"))?
}

/// `insert_text`'s work, on whichever thread the platform wants it.
fn insert_now(app: &AppHandle, text: &str) -> Result<PasteResult, String> {
    // Sample the frontmost app FIRST: posting the paste can move focus (a
    // paste that opens a sheet, an app that activates on input), so reading
    // it afterward could name the wrong app.
    let app_bundle_id = imp::frontmost_bundle_id();
    let blocked = clipboard::paste_block(imp::accessibility_trusted(false), imp::foreground());
    // A remote-desktop or VM client reads the clipboard after the paste, on
    // its own schedule: no restore for it (see `reads_clipboard_late`).
    let reads_late = app_bundle_id
        .as_deref()
        .is_some_and(clipboard::reads_clipboard_late);
    let state = app.state::<ClipboardState>();
    let done = clipboard::insert(
        &mut state.lock(),
        &mut SystemPasteboard,
        text,
        blocked,
        reads_late,
        imp::paste_to_frontmost,
    )?;
    if let Some(generation) = done.restore {
        clipboard::schedule_restore(app, generation);
    }
    Ok(PasteResult {
        pasted: done.pasted,
        app_bundle_id,
    })
}

/// Whether the app is trusted for Accessibility (needed for auto-paste).
/// When `prompt` is true, macOS shows the "grant Accessibility" dialog.
#[tauri::command]
pub fn accessibility_status(prompt: bool) -> bool {
    imp::accessibility_trusted(prompt)
}

/// Crate-internal Accessibility check (never prompts), used by hotkey.rs: an
/// ACTIVE CGEventTap runs under Accessibility even when Input Monitoring is
/// missing, so the push-to-talk tap consults both permissions. ax_observe reads
/// it for the same permission.
///
/// macOS-only, and deliberately so: both callers are the macOS event tap and
/// the macOS AX tree. It must NOT be reused as a general "may we auto-paste"
/// test, because off macOS `accessibility_trusted` answers a different question
/// — on Windows it returns true meaning "no permission is required", which says
/// nothing about whether a CGEventTap-shaped trigger could work.
#[cfg(target_os = "macos")]
pub(crate) fn is_accessibility_trusted() -> bool {
    imp::accessibility_trusted(false)
}

/// Pid of the frontmost app (the one voice typing pastes into), used by
/// ax_observe to scope its queries to that app. On macOS it comes from
/// NSWorkspace, not AX — works even when the target's accessibility tree is
/// still switched off.
///
/// On Windows it is the process owning the foreground window, which the UI
/// Automation watcher compares against the focused element's process id.
/// Compiled only where correction watching exists — a stub elsewhere would be a
/// dead-code warning with nothing to call it.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn frontmost_app_pid() -> Option<i32> {
    imp::frontmost_pid()
}
