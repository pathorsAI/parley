mod audio;
mod commands;
mod transcription;

use commands::MeetingState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(MeetingState::default())
        .invoke_handler(tauri::generate_handler![
            commands::start_meeting,
            commands::stop_meeting,
            commands::list_input_devices,
            commands::start_mic_test,
            commands::stop_mic_test,
            commands::save_transcript
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
