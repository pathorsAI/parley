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
//!
//! **An in-app update must survive a login launch.** Two things go wrong when
//! the running Parley was started by the login item and the user clicks
//! "Update & restart" (src/lib/update.ts):
//! - macOS: the login launch makes Parley the LaunchAgent job's main process,
//!   and Tauri's restart spawns the new version as a plain child in the job's
//!   process group before exiting. launchd then kills the rest of the group —
//!   the new version included — unless the plist says `AbandonProcessGroup`,
//!   which auto-launch cannot write. See `launch_agent`.
//! - Both OSes: the relaunch forwards the old argv, `--autostart` included
//!   (Tauri's restart on macOS; the NSIS `/ARGS` on Windows), so the new
//!   version would start hidden as if it were a login launch. The update path
//!   leaves a one-shot marker instead — see [`mark_show_on_next_launch`].

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, Runtime};
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
///
/// `relaunched_after_update` ([`take_show_on_next_launch`]) wins over the
/// login flag: an update relaunch inherits `--autostart` from the process it
/// replaces, but the user just clicked "Update & restart" in a visible window
/// and expects it back.
pub fn start_hidden(
    launched_at_login: bool,
    has_way_back: bool,
    relaunched_after_update: bool,
) -> bool {
    launched_at_login && has_way_back && !relaunched_after_update
}

/// The one-shot "show the window on the next launch" marker, in the app's
/// local data dir. Its content is the unix time (seconds) it was written.
const SHOW_ON_NEXT_LAUNCH: &str = "show-on-next-launch";

/// How old a marker may be and still count. It is written BEFORE the download
/// starts (on Windows the install exits the process from inside
/// `downloadAndInstall`, so there is no later point to write it from JS), so
/// this has to cover a slow download plus the install and relaunch. A marker
/// left behind by an install that never relaunched (installer cancelled or
/// killed) must not force the window open at some later login, hence a limit
/// at all.
const SHOW_ON_NEXT_LAUNCH_MAX_AGE_SECS: u64 = 30 * 60;

fn show_on_next_launch_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join(SHOW_ON_NEXT_LAUNCH))
        .map_err(|e| e.to_string())
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Whether a marker whose content is `content` still counts at `now`. Either
/// direction of clock skew is held to the same limit, so a timestamp from the
/// future (a clock that was wrong, then corrected) does not live forever.
fn marker_is_fresh(content: &str, now: u64) -> bool {
    content
        .trim()
        .parse::<u64>()
        .is_ok_and(|written| now.abs_diff(written) <= SHOW_ON_NEXT_LAUNCH_MAX_AGE_SECS)
}

/// Remove the marker; already gone is success.
fn remove_marker(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Read and delete the marker at `path`, whatever it holds, and answer whether
/// it was a fresh one. Deleting unconditionally is what makes it one-shot: the
/// launch after this one is judged on its own argv again.
fn take_marker(path: &Path, now: u64) -> bool {
    let content = match std::fs::read(path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return false,
        Err(e) => {
            log::warn!("app: could not read the show-on-next-launch marker: {e}");
            String::new()
        }
    };
    if let Err(e) = remove_marker(path) {
        log::warn!("app: could not remove the show-on-next-launch marker: {e}");
    }
    let fresh = marker_is_fresh(&content, now);
    if !fresh {
        log::info!("app: ignored a stale show-on-next-launch marker");
    }
    fresh
}

/// Setup: was this process started by an in-app update that asked for the
/// window? Always consumes the marker. False when there is none, it is stale,
/// or the data dir cannot be resolved.
pub fn take_show_on_next_launch<R: Runtime>(app: &AppHandle<R>) -> bool {
    match show_on_next_launch_path(app) {
        Ok(path) => take_marker(&path, unix_now()),
        Err(e) => {
            log::warn!("app: no data dir for the show-on-next-launch marker: {e}");
            false
        }
    }
}

/// Called by the update path (src/lib/update.ts) right before
/// `downloadAndInstall`: the next process shows its main window even though
/// the relaunch forwards `--autostart` — Tauri's restart re-passes the old
/// argv on macOS, and on Windows the updater hands it to the NSIS installer as
/// `/ARGS`, which starts the new version with it. Stripping the flag is not an
/// option on Windows: the updater captures argv at startup and does not expose
/// it.
#[tauri::command]
pub async fn mark_show_on_next_launch<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let path = show_on_next_launch_path(&app)?;
    let written = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::write(&path, unix_now().to_string()));
    written.map_err(|e| {
        log::warn!("app: could not write the show-on-next-launch marker: {e}");
        e.to_string()
    })
}

/// Called when `downloadAndInstall` failed: nothing will relaunch, so the
/// marker must not wait for an unrelated future launch.
#[tauri::command]
pub async fn clear_show_on_next_launch<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let path = show_on_next_launch_path(&app)?;
    remove_marker(&path).map_err(|e| {
        log::warn!("app: could not remove the show-on-next-launch marker: {e}");
        e.to_string()
    })
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
    // A LaunchAgent without AbandonProcessGroup kills every update relaunch of
    // a login-launched Parley (see `launch_agent`), so it is not a login item
    // worth keeping: if the patch does not take, take the item back out and
    // say so rather than report success.
    #[cfg(target_os = "macos")]
    if enabled && result.is_ok() {
        if let Err(e) = launch_agent::ensure_abandon_process_group(&app) {
            log::warn!("autostart: could not patch the LaunchAgent ({e}); turning it back off");
            if let Err(e) = manager.disable() {
                log::warn!("autostart: removing the unpatched LaunchAgent failed: {e}");
            }
            return Err(e);
        }
    }
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

/// The macOS LaunchAgent's `AbandonProcessGroup` key.
///
/// At login launchd runs Parley's binary directly as the LaunchAgent job's
/// main process. launchd.plist(5): when a job's main process exits, launchd
/// kills every remaining process in the job's process group unless
/// `AbandonProcessGroup` is true. Tauri's restart (the update relaunch, via
/// plugin-process) spawns the new version as a plain child — same process
/// group — and then exits, so without the key launchd kills the new version a
/// moment after it starts: Parley disappears and push-to-talk is dead until
/// the user reopens it. A manual launch goes through LaunchServices and is not
/// this job, which is why the same restart always worked there.
///
/// auto-launch writes the plist itself (Label, ProgramArguments, RunAtLoad)
/// with no way to add keys, and rewrites it on every `enable()`, so the key is
/// added after each enable and repaired at setup (`repair_launch_agent`).
/// launchd reads the file at the next login, which is when it matters.
#[cfg(target_os = "macos")]
mod launch_agent {
    use std::path::{Path, PathBuf};

    use tauri::{AppHandle, Manager, Runtime};

    use super::LOGIN_ITEM_NAME;

    const ABANDON_PROCESS_GROUP: &str = "AbandonProcessGroup";

    /// Where auto-launch writes the LaunchAgent: it names the file after
    /// `app_name`, which lib.rs sets to [`LOGIN_ITEM_NAME`].
    fn plist_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
        app.path()
            .home_dir()
            .map(|home| {
                home.join("Library")
                    .join("LaunchAgents")
                    .join(format!("{LOGIN_ITEM_NAME}.plist"))
            })
            .map_err(|e| e.to_string())
    }

    /// Set the key in a LaunchAgent dictionary. Answers whether anything
    /// changed, so an already-patched file is not rewritten.
    fn set_abandon_process_group(dict: &mut plist::Dictionary) -> bool {
        if dict
            .get(ABANDON_PROCESS_GROUP)
            .and_then(plist::Value::as_boolean)
            == Some(true)
        {
            return false;
        }
        dict.insert(ABANDON_PROCESS_GROUP.into(), plist::Value::Boolean(true));
        true
    }

    /// Patch the plist at `path` in place. Ok(true) when it wrote the key,
    /// Ok(false) when it was already there. Every other key is kept.
    pub(super) fn patch_file(path: &Path) -> Result<bool, String> {
        let mut dict: plist::Dictionary = plist::from_file(path).map_err(|e| e.to_string())?;
        if !set_abandon_process_group(&mut dict) {
            return Ok(false);
        }
        plist::Value::Dictionary(dict)
            .to_file_xml(path)
            .map_err(|e| e.to_string())?;
        Ok(true)
    }

    /// Patch Parley's LaunchAgent (see the module docs). Idempotent.
    pub fn ensure_abandon_process_group<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
        patch_file(&plist_path(app)?)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// What auto-launch 0.5 `enable()` writes, byte for byte.
        fn auto_launch_plist(exe: &str) -> String {
            format!(
                "{}\n{}\n<plist version=\"1.0\">\n  <dict>\n  <key>Label</key>\n  \
                 <string>Parley</string>\n  <key>ProgramArguments</key>\n  \
                 <array><string>{exe}</string><string>--autostart</string></array>\n  \
                 <key>RunAtLoad</key>\n  <true/>\n  </dict>\n</plist>",
                r#"<?xml version="1.0" encoding="UTF-8"?>"#,
                r#"<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">"#,
            )
        }

        fn temp_plist(content: &str) -> PathBuf {
            let dir =
                std::env::temp_dir().join(format!("parley-agent-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("Parley.plist");
            std::fs::write(&path, content).unwrap();
            path
        }

        #[test]
        fn adds_the_key_and_keeps_what_auto_launch_wrote() {
            let exe = "/Applications/Parley.app/Contents/MacOS/parley";
            let path = temp_plist(&auto_launch_plist(exe));
            assert_eq!(patch_file(&path), Ok(true));

            let dict: plist::Dictionary = plist::from_file(&path).unwrap();
            assert_eq!(
                dict.get(ABANDON_PROCESS_GROUP)
                    .and_then(plist::Value::as_boolean),
                Some(true)
            );
            assert_eq!(
                dict.get("Label").and_then(plist::Value::as_string),
                Some("Parley")
            );
            assert_eq!(
                dict.get("RunAtLoad").and_then(plist::Value::as_boolean),
                Some(true)
            );
            let args: Vec<&str> = dict
                .get("ProgramArguments")
                .and_then(plist::Value::as_array)
                .unwrap()
                .iter()
                .filter_map(plist::Value::as_string)
                .collect();
            assert_eq!(args, [exe, "--autostart"]);
            std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
        }

        #[test]
        fn is_idempotent() {
            let path = temp_plist(&auto_launch_plist(
                "/Applications/Parley.app/Contents/MacOS/parley",
            ));
            assert_eq!(patch_file(&path), Ok(true));
            let once = std::fs::read(&path).unwrap();
            assert_eq!(patch_file(&path), Ok(false));
            assert_eq!(std::fs::read(&path).unwrap(), once);
            std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
        }

        #[test]
        fn a_false_value_is_turned_on() {
            let mut dict = plist::Dictionary::new();
            dict.insert(ABANDON_PROCESS_GROUP.into(), plist::Value::Boolean(false));
            assert!(set_abandon_process_group(&mut dict));
            assert_eq!(
                dict.get(ABANDON_PROCESS_GROUP)
                    .and_then(plist::Value::as_boolean),
                Some(true)
            );
        }

        #[test]
        fn a_missing_or_unreadable_plist_is_an_error() {
            let dir =
                std::env::temp_dir().join(format!("parley-agent-test-{}", uuid::Uuid::new_v4()));
            assert!(patch_file(&dir.join("Parley.plist")).is_err());
            let path = temp_plist("not a plist");
            assert!(patch_file(&path).is_err());
            std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
        }
    }
}

/// Setup (macOS): add `AbandonProcessGroup` to an existing LaunchAgent that
/// lacks it — one written before the key was patched in, or by an `enable()`
/// whose patch was interrupted. A failure is logged, not fatal, and does not
/// turn the login item off behind the user's back.
#[cfg(target_os = "macos")]
pub fn repair_launch_agent<R: Runtime>(app: &AppHandle<R>) {
    match app.autolaunch().is_enabled() {
        Ok(true) => match launch_agent::ensure_abandon_process_group(app) {
            Ok(true) => log::info!("autostart: added AbandonProcessGroup to the LaunchAgent"),
            Ok(false) => {}
            Err(e) => log::warn!("autostart: could not patch the LaunchAgent: {e}"),
        },
        Ok(false) => {}
        Err(e) => log::warn!("autostart: status check at setup failed: {e}"),
    }
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
        assert!(start_hidden(true, true, false));
        assert!(!start_hidden(true, false, false));
        assert!(!start_hidden(false, true, false));
        assert!(!start_hidden(false, false, false));
    }

    #[test]
    fn an_update_relaunch_shows_the_window_despite_the_inherited_flag() {
        assert!(!start_hidden(true, true, true));
        assert!(!start_hidden(true, false, true));
        assert!(!start_hidden(false, true, true));
        assert!(!start_hidden(false, false, true));
    }

    #[test]
    fn a_marker_counts_only_while_fresh() {
        let now = 1_800_000_000;
        assert!(marker_is_fresh(&now.to_string(), now));
        assert!(marker_is_fresh(&format!("{}\n", now - 60), now));
        assert!(marker_is_fresh(
            &(now - SHOW_ON_NEXT_LAUNCH_MAX_AGE_SECS).to_string(),
            now
        ));
        assert!(!marker_is_fresh(
            &(now - SHOW_ON_NEXT_LAUNCH_MAX_AGE_SECS - 1).to_string(),
            now
        ));
        // A clock that ran ahead when the marker was written.
        assert!(!marker_is_fresh(&(now + 86_400).to_string(), now));
    }

    #[test]
    fn a_marker_without_a_timestamp_does_not_count() {
        assert!(!marker_is_fresh("", 1_800_000_000));
        assert!(!marker_is_fresh("yes", 1_800_000_000));
        assert!(!marker_is_fresh("-5", 1_800_000_000));
    }

    fn temp_marker_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("parley-marker-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn taking_a_marker_is_one_shot() {
        let dir = temp_marker_dir();
        let path = dir.join(SHOW_ON_NEXT_LAUNCH);
        let now = 1_800_000_000;
        std::fs::write(&path, now.to_string()).unwrap();
        assert!(take_marker(&path, now + 5));
        assert!(!path.exists());
        // The launch after the update relaunch is judged on its own argv again.
        assert!(!take_marker(&path, now + 10));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_stale_marker_is_removed_without_counting() {
        let dir = temp_marker_dir();
        let path = dir.join(SHOW_ON_NEXT_LAUNCH);
        let now = 1_800_000_000;
        std::fs::write(
            &path,
            (now - 2 * SHOW_ON_NEXT_LAUNCH_MAX_AGE_SECS).to_string(),
        )
        .unwrap();
        assert!(!take_marker(&path, now));
        assert!(!path.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn removing_a_missing_marker_is_fine() {
        let dir = temp_marker_dir();
        assert!(remove_marker(&dir.join(SHOW_ON_NEXT_LAUNCH)).is_ok());
        std::fs::remove_dir_all(&dir).unwrap();
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
