mod audio;
mod capture;
mod commands;
mod diarize;
mod history;
mod hotkey;
mod mcp;
mod menu;
mod permissions;
mod replay;
mod replay_audio;
mod transcription;
mod translate;
mod usage;
mod voice_typing;

use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

use capture::MicCoordinator;
use commands::MeetingState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shortcut_plugin = tauri_plugin_global_shortcut::Builder::new()
        // Boot default until the frontend applies the saved selection (see
        // hotkey::set_voice_typing_shortcut, called from the voice-typing host).
        .with_shortcut(Shortcut::new(Some(Modifiers::ALT), Code::Space))
        .expect("register dictation shortcut")
        .with_handler(|app, _shortcut, event| {
            // Exactly one voice-typing trigger is ever registered (the picker
            // unregisters everything before applying a change), so any firing
            // shortcut is the push-to-talk key — including user-recorded combos.
            let down = match event.state {
                ShortcutState::Pressed => true,
                ShortcutState::Released => false,
            };
            let _ = app.emit("voicetyping://ptt", serde_json::json!({ "down": down }));
        })
        .build();

    tauri::Builder::default()
        // Registered FIRST so other plugins' logs are captured. Writes a rotating
        // file to the OS app-log dir (macOS: ~/Library/Logs/com.pathors.parley/),
        // plus stdout (dev) and the webview devtools. Captures Rust `log::` macros
        // and — via the frontend wrapper's attachConsole — webview console output.
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::LogDir {
                        file_name: Some("parley".into()),
                    }),
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::Webview),
                ])
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .max_file_size(5_000_000) // 5 MB per file
                .rotation_strategy(RotationStrategy::KeepSome(5))
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .build(),
        )
        .plugin(shortcut_plugin)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Single source of truth for "who owns the mic" (meeting / mic test /
        // voice typing) — guarantees at most one live capture session.
        .manage(MicCoordinator::default())
        .manage(MeetingState::default())
        // Singleton guard for the voice-typing session task (abort-on-restart
        // + bounded post-release flush) — see voice_typing::VoiceTypingState.
        .manage(voice_typing::VoiceTypingState::default())
        // Singleton guard for the live-translation session (mic → Gemini
        // translate → output device) — see translate::TranslateState.
        .manage(translate::TranslateState::default())
        // Native menu-bar "Diagnostics" submenu (View Logs + Clear Cache).
        .menu(menu::build)
        .on_menu_event(|app, event| menu::on_event(app, event.id().as_ref()))
        .setup(|app| {
            app.manage(mcp::start(app.handle().clone()));
            // Start the global fn-key push-to-talk listener (no-op until the
            // user grants Input Monitoring).
            hotkey::init(app.handle().clone());
            log::info!("app: starting up (parley {})", env!("CARGO_PKG_VERSION"));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_meeting,
            commands::stop_meeting,
            commands::discard_recording,
            commands::list_input_devices,
            commands::start_mic_test,
            commands::stop_mic_test,
            commands::meeting_active,
            commands::save_transcript,
            commands::export_recording,
            commands::start_oauth_loopback,
            commands::read_templates,
            commands::write_templates,
            commands::get_templates_path,
            commands::read_log_tail,
            commands::write_session,
            commands::read_session_commands,
            usage::append_usage_event,
            usage::read_usage_events,
            permissions::check_permissions,
            permissions::app_identity,
            permissions::probe_system_audio,
            permissions::request_microphone,
            permissions::open_privacy_settings,
            voice_typing::start_voice_typing,
            voice_typing::stop_voice_typing,
            voice_typing::append_voice_history,
            voice_typing::read_voice_history,
            voice_typing::write_voice_history,
            voice_typing::copy_to_clipboard,
            voice_typing::paste_to_frontmost,
            voice_typing::accessibility_status,
            voice_typing::present_voice_overlay,
            voice_typing::dismiss_voice_overlay,
            translate::start_translate,
            translate::stop_translate,
            translate::translate_active,
            translate::list_output_devices,
            hotkey::ensure_fn_listener,
            hotkey::input_monitoring_status,
            hotkey::request_input_monitoring,
            hotkey::set_voice_typing_shortcut,
            hotkey::voice_typing_hotkey_status,
            replay::transcribe_file,
            replay::measure_audio_speech_rate,
            diarize::diarize_audio,
            history::save_history_entry,
            history::save_remote_history_entry,
            history::download_remote_audio,
            history::list_history,
            history::read_history_entry,
            history::rename_history_entry,
            history::delete_history_entry,
            diarize::download_diarize_model,
            diarize::diarize_model_status,
            mcp::get_mcp_server_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
