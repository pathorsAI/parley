//! A short sound when a voice-typing dictation starts and when it ends
//! (issue #607), so the user knows Parley is listening without looking.
//!
//! The two sounds are Parley's own: `src-tauri/sounds/cue-{start,stop}.wav`,
//! synthesised by `scripts/sounds/generate-cues.py` and compiled into the
//! binary with `include_bytes!`, so there is no resource path to resolve at
//! runtime. They replaced the macOS system sounds Ping/Bottle, which were
//! harsh in a quiet room. macOS plays them through `NSSound`, Windows through
//! `PlaySoundW(SND_MEMORY)`. Every other platform is silent. Playback never
//! blocks, and a sound that fails to play just plays nothing.
//!
//! Whether to play at all is a setting the frontend checks
//! (`src/lib/meeting/cue.ts`); this command always plays when asked.

/// Which moment of the dictation the sound marks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Cue {
    Start,
    Stop,
}

const START_WAV: &[u8] = include_bytes!("../../sounds/cue-start.wav");
const STOP_WAV: &[u8] = include_bytes!("../../sounds/cue-stop.wav");

impl Cue {
    /// The WAV bytes for this cue: a higher, rising-feel bloop to start and a
    /// lower one to stop.
    #[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
    fn wav(self) -> &'static [u8] {
        match self {
            Cue::Start => START_WAV,
            Cue::Stop => STOP_WAV,
        }
    }
}

/// Play the cue for `cue`, without waiting for it to finish.
#[tauri::command]
pub(crate) fn play_cue(app: tauri::AppHandle, cue: Cue) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // NSSound belongs to AppKit; play it from the main thread.
        app.run_on_main_thread(move || macos::play(cue))
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        win::play(cue.wav());
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
    use super::Cue;
    use objc::runtime::{Object, BOOL, NO};
    use objc::{class, msg_send, sel, sel_impl};
    use std::cell::RefCell;
    use std::os::raw::c_void;

    thread_local! {
        /// One `NSSound` per cue, built on first use and kept for the life of
        /// the app (two small objects; never released on purpose). Only ever
        /// touched on the main thread.
        static SOUNDS: RefCell<[*mut Object; 2]> = const { RefCell::new([std::ptr::null_mut(); 2]) };
    }

    fn load(bytes: &'static [u8]) -> *mut Object {
        unsafe {
            let data: *mut Object = msg_send![class!(NSData),
                dataWithBytes: bytes.as_ptr() as *const c_void
                length: bytes.len()];
            if data.is_null() {
                return std::ptr::null_mut();
            }
            let sound: *mut Object = msg_send![class!(NSSound), alloc];
            msg_send![sound, initWithData: data]
        }
    }

    /// Play the cue. A sound still playing from the previous cue (a quick
    /// start → stop) is stopped first, because `play` refuses a sound that is
    /// already playing. Must run on the main thread.
    pub(super) fn play(cue: Cue) {
        let idx = match cue {
            Cue::Start => 0,
            Cue::Stop => 1,
        };
        SOUNDS.with(|cell| {
            let mut sounds = cell.borrow_mut();
            if sounds[idx].is_null() {
                sounds[idx] = load(cue.wav());
            }
            let sound = sounds[idx];
            if sound.is_null() {
                log::debug!("cue: could not load {cue:?} sound");
                return;
            }
            unsafe {
                let _: BOOL = msg_send![sound, stop];
                let played: BOOL = msg_send![sound, play];
                if played == NO {
                    log::debug!("cue: {cue:?} sound did not play");
                }
            }
        });
    }
}

#[cfg(target_os = "windows")]
mod win {
    use windows::core::PCWSTR;
    use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};

    /// Play an in-memory WAV asynchronously. The bytes are `'static`
    /// (`include_bytes!`), which `SND_ASYNC | SND_MEMORY` requires: the
    /// buffer is read after this call returns. `SND_NODEFAULT` keeps a bad
    /// buffer silent instead of falling back to the default beep.
    pub(super) fn play(wav: &'static [u8]) {
        let ok = unsafe {
            PlaySoundW(
                PCWSTR(wav.as_ptr() as *const u16),
                None,
                SND_MEMORY | SND_ASYNC | SND_NODEFAULT,
            )
        };
        if !ok.as_bool() {
            log::debug!("cue: in-memory sound did not play");
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
    fn each_cue_is_a_distinct_wav() {
        for cue in [Cue::Start, Cue::Stop] {
            let wav = cue.wav();
            assert_eq!(&wav[0..4], b"RIFF");
            assert_eq!(&wav[8..12], b"WAVE");
        }
        assert_ne!(Cue::Start.wav(), Cue::Stop.wav());
    }
}
