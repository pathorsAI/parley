mod audio;
mod commands;
mod diarize;
mod history;
mod mcp;
mod menu;
mod permissions;
mod replay;
mod replay_audio;
mod transcription;
mod usage;

use tauri::Manager;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

use commands::MeetingState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Registered FIRST so other plugins' logs are captured. Writes a rotating
        // file to the OS app-log dir (macOS: ~/Library/Logs/com.pathors.parley/),
        // plus stdout (dev) and the webview devtools. Captures Rust `log::` macros
        // and — via the frontend wrapper's attachConsole — webview console output.
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::LogDir { file_name: Some("parley".into()) }),
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(MeetingState::default())
        // Native menu-bar "Diagnostics" submenu (View Logs + Clear Cache).
        .menu(|handle| menu::build(handle))
        .on_menu_event(|app, event| menu::on_event(app, event.id().as_ref()))
        .setup(|app| {
            app.manage(mcp::start(app.handle().clone()));
            log::info!("app: starting up (parley {})", env!("CARGO_PKG_VERSION"));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_meeting,
            commands::stop_meeting,
            commands::list_input_devices,
            commands::start_mic_test,
            commands::stop_mic_test,
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
            permissions::request_screen_recording,
            permissions::open_privacy_settings,
            replay::transcribe_file,
            diarize::diarize_audio,
            history::save_history_entry,
            history::list_history,
            history::read_history_entry,
            history::delete_history_entry,
            diarize::download_diarize_model,
            diarize::diarize_model_status,
            mcp::get_mcp_server_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
