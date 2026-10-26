//! The app's general Tauri commands, by what they touch:
//!
//! - `config`: the small state files in the app config dir (paths and IO).
//! - `shared_files`: templates, the phrase dictionary, the folder registry.
//! - `session_files`: the live session snapshot and the MCP command queue.
//! - `meeting`: starting, pausing, stopping and cancelling a live meeting.
//! - `mic_test`: the Settings microphone preview.
//! - `export`: saved transcripts, exported audio, unsaved-recording cleanup.
//! - `oauth`: the desktop sign-in loopback.
//! - `logs`: the in-app log viewer.
//! - `ai_memory`: onboarding's read of Claude Code's memory files.

pub(crate) mod ai_memory;
pub(crate) mod config;
pub(crate) mod export;
pub(crate) mod logs;
pub(crate) mod meeting;
pub(crate) mod mic_test;
pub(crate) mod oauth;
pub(crate) mod session_files;
pub(crate) mod shared_files;

pub(crate) use self::export::documents_dir;
pub use self::meeting::MeetingState;
pub(crate) use self::session_files::{
    session_command_results_path, session_commands_path, session_path,
};
pub(crate) use self::shared_files::{dictionary_path, templates_path};
