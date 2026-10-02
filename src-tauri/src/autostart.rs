//! Launch at login (Settings › Basic).
//!
//! Voice typing's host — the push-to-talk listener, the session, the paste —
//! runs in the MAIN window's JS (src/lib/voiceTyping/host.ts, mounted from
//! App.tsx). After a reboot or a fresh login the hotkey therefore did nothing
//! until the user opened Parley by hand, and Parley otherwise stays up for days,
//! so a login was the one thing that reliably took voice typing away. With this
//! on, the OS starts Parley at login with [`AUTOSTART_ARG`], and setup (lib.rs)
//! leaves the main window hidden: the user asked for Parley to be RUNNING, not
//! to look at it. The hidden window is the same state the close button already
//! puts it in, with the same ways back (Dock click, tray icon, second launch).
//!
//! **The OS is the source of truth**, not a persisted setting. The login item
//! can change behind Parley's back — Task Manager › Startup apps on Windows, a
//! removed LaunchAgent, a reinstall — and settings live in the webview's
//! localStorage, where a copy would drift. The value is also per device and
//! must never travel with synced settings. So the toggle asks
//! [`launch_at_login_status`] every time it is shown and believes the answer.
//!
//! **macOS uses a LaunchAgent** (`~/Library/LaunchAgents/<name>.plist`, also
//! the plugin default), not an AppleScript login item: an AppleScript item
//! cannot pass arguments, so a login launch would look exactly like a manual
//! one, and creating it prompts for Automation access to System Events.
//! Windows writes the `HKCU\…\Run` value, whose `is_enabled` also honours the
//! Task Manager Startup-apps switch.
//!
//! **The plugin's own `enable`/`disable`/`is_enabled` commands are not
//! granted** (no `autostart:*` in capabilities/default.json) and its JS package
//! is not installed. The webview only reaches the two commands below, which
//! re-read the OS state after a change and log what happened, so there is one
//! door to the login item and it is ours.

use std::path::Path;

use tauri::{AppHandle, Runtime};
use tauri_plugin_autostart::ManagerExt;

/// Appended to the login item's command line, so a login launch can tell
/// itself apart from the user opening the app.
pub const AUTOSTART_ARG: &str = "--autostart";

/// LaunchAgent label/filename on macOS, Run value name on Windows. Debug
/// builds use their own name so `tauri dev` can never overwrite or delete the
/// installed app's entry with one pointing at target/debug.
pub const LOGIN_ITEM_NAME: &str = if cfg!(debug_assertions) {
    "Parley Dev"
} else {
    "Parley"
};

/// The error [`set_launch_at_login`] rejects with when the app is running
/// from a Gatekeeper-translocated path. Matched by the frontend
/// (src/lib/launchAtLogin.ts), which shows a translated "move Parley to
/// Applications first" instead of the raw string.
pub const TRANSLOCATED_ERROR: &str = "translocated";

/// Whether this process was started by the login item. `args` is a full argv
/// (`std::env::args()`, or the `Vec<String>` the single-instance callback
/// receives); argv[0] is the program slot and never counts. An exact match
/// only, so a lookalike such as `--autostart=1` is not mistaken for one.
///
/// `any` rather than "the last argument" on purpose: Windows' Run value is
/// written unquoted, so for an install path with a space in it argv[0] is
/// split into several pieces and the flag is no longer argv[1].
pub fn is_autostart_launch<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .skip(1)
        .any(|a| a.as_ref() == AUTOSTART_ARG)
}

/// Whether setup should leave the main window hidden. Only for a login
/// launch, and only when the user has a way back to the window afterwards —
/// on Windows that is the tray icon, which can fail to build; without it a
/// hidden window would leave Parley running with no visible way in.
pub fn start_hidden(launched_at_login: bool, has_way_back: bool) -> bool {
    launched_at_login && has_way_back
}

/// macOS runs a quarantined app opened from Downloads or a disk image from a
/// randomized read-only copy (Gatekeeper path randomization). That path is
/// gone once the app quits, so a login item pointing at it silently never
/// fires.
fn is_translocated(exe: &Path) -> bool {
    exe.to_string_lossy().contains("/AppTranslocation/")
}

/// Is Parley registered to launch at login? Straight from the OS: the
/// LaunchAgent plist on macOS; the Run value plus the Task Manager switch on
/// Windows.
#[tauri::command]
pub async fn launch_at_login_status<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| {
        log::warn!("autostart: status check failed: {e}");
        e.to_string()
    })
}

/// Turn launch at login on or off. Resolves to the OS state AFTER the change
/// (re-read, not assumed), and rejects when the OS did not take it.
#[tauri::command]
pub async fn set_launch_at_login<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
) -> Result<bool, String> {
    if enabled && cfg!(target_os = "macos") {
        if let Ok(exe) = std::env::current_exe() {
            if is_translocated(&exe) {
                log::warn!("autostart: refused to enable from a translocated app path");
                return Err(TRANSLOCATED_ERROR.into());
            }
        }
    }
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    // Judge by the OS state, not by the call: auto-launch's disable() errors on
    // Windows when the Run value is already gone (NotFound), which is success
    // from the user's point of view.
    let now = manager.is_enabled().map_err(|e| {
        log::warn!("autostart: status check after set {enabled} failed: {e}");
        e.to_string()
    })?;
    if now != enabled {
        let reason = result
            .err()
            .map(|e| e.to_string())
            .unwrap_or_else(|| "login item state did not change".into());
        log::warn!("autostart: set {enabled} failed: {reason}");
        return Err(reason);
    }
    log::info!(
        "autostart: launch at login {}",
        if now { "on" } else { "off" }
    );
    Ok(now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autostart_flag_after_the_program_is_a_login_launch() {
        assert!(is_autostart_launch(["parley", "--autostart"]));
        assert!(is_autostart_launch(["parley", "--other", "--autostart"]));
    }

    #[test]
    fn no_flag_is_a_manual_launch() {
        assert!(!is_autostart_launch(["parley"]));
        assert!(!is_autostart_launch(Vec::<String>::new()));
    }

    #[test]
    fn argv0_is_the_program_slot_and_never_counts() {
        assert!(!is_autostart_launch(["--autostart"]));
    }

    #[test]
    fn lookalike_flags_do_not_count() {
        assert!(!is_autostart_launch(["parley", "--autostart=1"]));
        assert!(!is_autostart_launch(["parley", "--autostarted"]));
        assert!(!is_autostart_launch(["parley", "--AUTOSTART"]));
    }

    #[test]
    fn unquoted_windows_path_with_a_space_still_finds_the_flag() {
        // `C:\Users\First Last\…\Parley.exe --autostart`, split on the space.
        assert!(is_autostart_launch([
            r"C:\Users\First",
            r"Last\AppData\Local\Parley\Parley.exe",
            "--autostart",
        ]));
    }

    #[test]
    fn accepts_the_single_instance_callback_shape() {
        // The single-instance callback hands over a Vec<String> and the caller
        // keeps it, so it must work by reference.
        let args: Vec<String> = vec!["Parley.exe".into(), "--autostart".into()];
        assert!(is_autostart_launch(&args));
        assert_eq!(args.len(), 2);
    }

    #[test]
    fn start_hidden_needs_a_login_launch_and_a_way_back() {
        assert!(start_hidden(true, true));
        assert!(!start_hidden(true, false));
        assert!(!start_hidden(false, true));
        assert!(!start_hidden(false, false));
    }

    #[test]
    fn translocated_paths_are_detected() {
        assert!(is_translocated(Path::new(
            "/private/var/folders/ab/xyz/T/AppTranslocation/1234-ABCD/d/Parley.app/Contents/MacOS/parley"
        )));
        assert!(!is_translocated(Path::new(
            "/Applications/Parley.app/Contents/MacOS/parley"
        )));
    }

    #[cfg(debug_assertions)]
    #[test]
    fn debug_builds_never_share_the_release_login_item() {
        assert_ne!(LOGIN_ITEM_NAME, "Parley");
    }
}
