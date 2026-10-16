//! Voice typing: a lightweight push-to-talk dictation session that reuses the
//! meeting transcription stack (microphone -> one STT provider) but with none of
//! the meeting overhead (no diarization, no system-audio capture, no recording).
//!
//! It emits the same `transcript://segment` and `audio://level` events as a
//! meeting, tagged `source: "voice-typing"`, which the floating overlay window
//! renders. Once the dictation has settled, the host has it typed into the
//! frontmost app's focused field (`insert_text`): the text goes up on the
//! clipboard through the OS (the webview can't, because Parley isn't the
//! focused app), the paste chord is synthesized — ⌘V on macOS, which needs
//! Accessibility, or Ctrl+V on Windows, which needs no permission but is
//! refused by UIPI when the target window runs elevated — and a moment later
//! the clipboard gets back what the user had on it (see `clipboard`).

// The `objc` 0.2 macros emit `cfg(cargo-clippy)` checks newer compilers warn on.
#![allow(unexpected_cfgs)]
//!
//! - `session`: the session lifecycle (one live task, its cutoff and gate).
//! - `commands`: `start_voice_typing` / `stop_voice_typing`.
//! - `paste`: typing the result into the frontmost app.
//! - `overlay`, `hit_rects`: the floating overlay and its click-through.
//! - `history`: the dictation history file.
//! - `clipboard`: borrowing the clipboard and giving it back.
//! - `imp` (`platform_*.rs`): the native side, one file per platform.

mod clipboard;
pub(crate) mod commands;
pub(crate) mod hit_rects;
pub(crate) mod history;
pub(crate) mod overlay;
pub(crate) mod paste;
mod session;

#[cfg(target_os = "macos")]
#[path = "voice_typing/platform_macos.rs"]
mod imp;
#[cfg(target_os = "windows")]
#[path = "voice_typing/platform_windows.rs"]
mod imp;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[path = "voice_typing/platform_other.rs"]
mod imp;

pub use self::clipboard::ClipboardState;
pub use self::hit_rects::OverlayHitState;
pub use self::overlay::install_space_observer;
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) use self::paste::frontmost_app_pid;
#[cfg(target_os = "macos")]
pub(crate) use self::paste::is_accessibility_trusted;
pub(crate) use self::session::SessionEndGuard;
pub use self::session::VoiceTypingState;

// What the platform `imp` modules reach for as `super::…`.
#[cfg(target_os = "macos")]
use self::hit_rects::fraction_bottom_left;
#[cfg(target_os = "windows")]
use self::hit_rects::fraction_top_left;
