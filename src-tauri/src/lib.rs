mod audio;
mod commands;
mod mcp;
mod permissions;
mod replay;
mod replay_audio;
mod transcription;
mod usage;

use tauri::Manager;

use commands::MeetingState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(MeetingState::default())
        .setup(|app| {
            app.manage(mcp::start(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_meeting,
            commands::stop_meeting,
            commands::list_input_devices,
            commands::start_mic_test,
            commands::stop_mic_test,
            commands::save_transcript,
            commands::read_templates,
            commands::write_templates,
            commands::get_templates_path,
            commands::write_session,
            commands::read_session_commands,
            usage::append_usage_event,
            usage::read_usage_events,
            permissions::check_permissions,
            permissions::request_screen_recording,
            permissions::open_privacy_settings,
            replay::transcribe_file,
            mcp::get_mcp_server_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
