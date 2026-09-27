//! Watch the text field that voice typing just pasted into, and notice when the
//! user immediately fixes what the transcriber got wrong.
//!
//! The premise of the phrase dictionary is that a correction made seconds after
//! a dictation is a free, high-quality label: whatever the user retyped is what
//! they wanted the STT to produce. Catching it needs no keylogging — the
//! platform accessibility API (Accessibility on macOS, UI Automation on
//! Windows) can read the focused element's value, so we
//! snapshot it right after the paste and poll it for a minute. If the value
//! settles on something other than the snapshot while focus stays put, we emit
//! ONE `voicetyping://correction-candidate` and stop; the frontend diffs
//! baseline vs current against the inserted text and decides whether to offer
//! a phrase.
//!
//! Deliberately conservative — a false positive costs the user a dismissal, so
//! every ambiguous case (focus moved, value unreadable, absurdly long field,
//! a newer dictation started) ends the observation SILENTLY rather than guessing.
//!
//! Split in two: [`watch`] is the platform-neutral state machine (cadence,
//! settle-and-diff, stop conditions, payload); each platform module only reads
//! the field and reports what it saw as a [`watch::Tick`].

use tauri::AppHandle;

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod watch;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use self::macos as imp;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use self::windows as imp;

/// Start watching the field voice typing just pasted `inserted_text` into.
///
/// Returns whether an observation was (or, on Windows and for a
/// not-yet-accessible Electron app on macOS, is being) armed: `false` when the
/// platform accessibility layer is unavailable (macOS: Accessibility not
/// granted) or there is no app to watch. Returning `true` promises only that
/// we are watching — most observations legitimately end with no event,
/// because most dictations are not corrected, and a field that turns out to be
/// unreadable ends one quietly.
///
/// Non-blocking: the polling lives on a background thread, and a later call
/// supersedes an earlier one.
#[tauri::command]
pub fn observe_pasted_field(app: AppHandle, inserted_text: String) -> bool {
    imp::observe(app, inserted_text)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    use tauri::AppHandle;

    /// No field-reading accessibility layer is wired up on other platforms,
    /// so no correction is ever noticed there; the dictionary stays editable
    /// by hand.
    pub fn observe(_app: AppHandle, _inserted_text: String) -> bool {
        false
    }
}
