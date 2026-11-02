//! A short system sound when a meeting recording starts and when it ends
//! (issue #607), so the user knows Parley is listening without looking.
//!
//! Only the OS's own sounds are used — no audio assets ship with the app:
//! macOS plays `/System/Library/Sounds` through `NSSound`, Windows plays a
//! system-sound alias through `PlaySoundW`. Every other platform is silent.
//! Playback never blocks, and a sound that is missing (renamed in a future
//! macOS, no sound assigned to the Windows event) just plays nothing.
//!
//! Whether to play at all is a setting the frontend checks
//! (`src/lib/meeting/cue.ts`); this command always plays when asked.

/// Which moment of the recording the sound marks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Cue {
    Start,
    Stop,
}

impl Cue {
    /// The macOS system sound (`/System/Library/Sounds/<name>.aiff`): Hero's
    /// rising chime to start, Glass's bright ring to stop — distinct from each
    /// other and easy to hear over a call (Tink and Pop were too faint).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn macos_sound(self) -> &'static str {
        match self {
            Cue::Start => "Hero",
            Cue::Stop => "Glass",
        }
    }

    /// The Windows system-sound alias (an event under
    /// `HKCU\AppEvents\Schemes\Apps\.Default`). Both are the quiet, everyday
    /// ones — not Exclamation/Hand, which read as an error.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    fn windows_alias(self) -> &'static str {
        match self {
            Cue::Start => "Notification.Default",
            Cue::Stop => "SystemDefault",
        }
    }
}

/// Play the cue for `cue`, without waiting for it to finish.
#[tauri::command]
pub(crate) fn play_cue(app: tauri::AppHandle, cue: Cue) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // NSSound belongs to AppKit; play it from the main thread.
        let name = cue.macos_sound();
        app.run_on_main_thread(move || macos::play(name))
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        win::play(cue.windows_alias());
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, cue);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use objc::runtime::{Class, Object, BOOL, NO};
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CString;

    /// Play the named system sound. `soundNamed:` returns a shared instance
    /// that is still playing if the previous cue has not finished (a quick
    /// start → end), and `play` refuses a sound already playing, so it is
    /// stopped first. Must run on the main thread.
    pub(super) fn play(name: &str) {
        let Some(ns_sound) = Class::get("NSSound") else {
            return;
        };
        let Ok(c_name) = CString::new(name) else {
            return;
        };
        unsafe {
            let ns_name: *mut Object =
                msg_send![class!(NSString), stringWithUTF8String: c_name.as_ptr()];
            if ns_name.is_null() {
                return;
            }
            let sound: *mut Object = msg_send![ns_sound, soundNamed: ns_name];
            if sound.is_null() {
                log::debug!("cue: system sound {name} not found");
                return;
            }
            let _: BOOL = msg_send![sound, stop];
            let played: BOOL = msg_send![sound, play];
            if played == NO {
                log::debug!("cue: system sound {name} did not play");
            }
        }
    }
}

#[cfg(target_os = "windows")]
mod win {
    use windows::core::HSTRING;
    use windows::Win32::Media::Audio::{PlaySoundW, SND_ALIAS, SND_ASYNC, SND_NODEFAULT};

    /// Play a system-sound alias asynchronously. `SND_NODEFAULT` keeps an
    /// unknown alias (or an event with no sound assigned) silent instead of
    /// falling back to the default beep.
    pub(super) fn play(alias: &str) {
        let alias = HSTRING::from(alias);
        let ok = unsafe { PlaySoundW(&alias, None, SND_ALIAS | SND_ASYNC | SND_NODEFAULT) };
        if !ok.as_bool() {
            log::debug!("cue: system sound {alias} did not play");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Cue;

    #[test]
    fn cue_parses_from_the_frontend_names() {
        let start: Cue = serde_json::from_str("\"start\"").unwrap();
        let stop: Cue = serde_json::from_str("\"stop\"").unwrap();
        assert_eq!(start, Cue::Start);
        assert_eq!(stop, Cue::Stop);
        assert!(serde_json::from_str::<Cue>("\"pause\"").is_err());
    }

    #[test]
    fn each_cue_maps_to_a_distinct_system_sound() {
        assert_eq!(Cue::Start.macos_sound(), "Hero");
        assert_eq!(Cue::Stop.macos_sound(), "Glass");
        assert_eq!(Cue::Start.windows_alias(), "Notification.Default");
        assert_eq!(Cue::Stop.windows_alias(), "SystemDefault");
    }
}
