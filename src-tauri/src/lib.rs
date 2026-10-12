mod audio;
mod autostart;
mod ax_observe;
mod cache;
mod capture;
mod commands;
mod diarize;
mod history;
mod hotkey;
mod mcp;
mod menu;
mod permissions;
mod playback;
mod replay;
mod replay_audio;
mod transcription;
mod tray;
mod usage;
mod voice_typing;

use tauri::Manager;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

use capture::{MicCoordinator, MicTap};
use commands::MeetingState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // No shortcut and no plugin-wide handler here: every shortcut carries its
    // own handler. The push-to-talk combo is registered in setup below
    // (hotkey::register_boot_trigger), and a plugin-wide handler would fire for
    // every other shortcut too — see hotkey::on_ptt.
    let shortcut_plugin = tauri_plugin_global_shortcut::Builder::new().build();

    // Launch at login (Settings › Basic, see autostart.rs). The login item
    // starts the app with `--autostart`, which setup reads to keep the main
    // window hidden.
    let autostart_plugin = tauri_plugin_autostart::Builder::new()
        .args([autostart::AUTOSTART_ARG])
        .app_name(autostart::LOGIN_ITEM_NAME);
    // A LaunchAgent (also the plugin default), not AppleScript: an AppleScript
    // login item cannot pass `--autostart`, so a login launch would look like a
    // manual one, and creating it prompts for Automation access to System
    // Events. `macos_launcher` only exists on macOS.
    #[cfg(target_os = "macos")]
    let autostart_plugin =
        autostart_plugin.macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent);

    tauri::Builder::default()
        // Registered before everything else per the plugin's docs: a second
        // launch of the app (double-clicking the installed exe, taskbar pin,
        // …) focuses the running instance instead of starting another one.
        // macOS reaches the same behavior via RunEvent::Reopen below.
        //
        // A login launch that finds Parley already running is NOT the user
        // asking for the window (it can happen when the app was opened by hand
        // before the login item fired), so it must not pop the window up.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if autostart::is_autostart_launch(&args) {
                log::info!("app: login launch while already running; ignored");
                return;
            }
            show_main_window(app);
        }))
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
        // Authoritative OS detection for the frontend's platform branches
        // (src/lib/platform.ts) — window chrome, hidden panels, key caps.
        .plugin(tauri_plugin_os::init())
        // Unconditional like single-instance: the crate only builds for desktop.
        .plugin(autostart_plugin.build())
        // Single source of truth for "who owns the mic" (meeting / mic test /
        // voice typing) — guarantees at most one live capture session.
        .manage(MicCoordinator::default())
        // Tee of the live meeting's raw mic PCM so voice typing can dictate
        // during a meeting without opening a second input stream (see MicTap).
        .manage(MicTap::default())
        .manage(MeetingState::default())
        // Singleton guard for the voice-typing session task (abort-on-restart
        // + bounded post-release flush) — see voice_typing::VoiceTypingState.
        .manage(voice_typing::VoiceTypingState::default())
        // Where the voice-typing overlay draws, and the poller that makes the
        // rest of its window click-through — see voice_typing::OverlayHitState.
        .manage(voice_typing::OverlayHitState::default())
        // The clipboard a dictation borrows for its paste, and the restore
        // that gives it back — see voice_typing::ClipboardState.
        .manage(voice_typing::ClipboardState::default())
        // Native menu-bar "Diagnostics" submenu (View Logs + Clear Cache).
        .menu(menu::build)
        .on_menu_event(|app, event| menu::on_event(app, event.id().as_ref()))
        .setup(|app| {
            app.manage(mcp::start(app.handle().clone()));
            // The boot-default push-to-talk combo, live until the frontend
            // applies the saved selection. A failure is logged, not fatal.
            hotkey::register_boot_trigger(app.handle());
            // Start the global fn-key push-to-talk listener (no-op until the
            // user grants Input Monitoring).
            hotkey::init(app.handle().clone());
            // Re-assert the push-to-talk trigger after sleep/wake and session
            // unlock — Carbon hotkey registrations and CGEventTaps can come
            // back dead from a sleep cycle.
            hotkey::install_wake_observer(app.handle().clone());
            // Follow the user across Spaces while the voice-typing overlay is up.
            voice_typing::install_space_observer(app.handle().clone());
            // Windows: the notification-area icon the close button hides to.
            // A failure is logged, not fatal — `tray_active` then answers false
            // and the close button quits instead of hiding into nowhere.
            #[cfg(target_os = "windows")]
            app.manage(tray::TrayState::default());
            #[cfg(target_os = "windows")]
            let has_way_back = match tray::install(app.handle()) {
                Ok(()) => true,
                Err(e) => {
                    log::error!("tray: failed to install notification-area icon: {e}");
                    false
                }
            };
            // macOS: the Dock icon is always there (RunEvent::Reopen below).
            // Linux (not shipped): nothing to come back through.
            #[cfg(not(target_os = "windows"))]
            let has_way_back = cfg!(target_os = "macos");
            log::info!("app: starting up (parley {})", env!("CARGO_PKG_VERSION"));
            // The main window is created hidden ("visible": false in every
            // tauri*.conf.json — Tauri builds config windows BEFORE this closure
            // runs, so hiding a visible one here would flash it and steal
            // focus). A login launch leaves it that way: the user asked for
            // Parley to be RUNNING (voice typing's host lives in this window's
            // JS), not to look at it. Every other launch shows it here, still
            // before the page has loaded, which matches the old
            // visible-at-creation behavior.
            //
            // Hidden is the all-day state after a login launch, and macOS
            // throttles a hidden webview's timers — voice typing's settle and
            // cap timers in host.ts among them. tauri.macos.conf.json therefore
            // sets `"backgroundThrottling": "disabled"` on this window (honoured
            // on macOS 14+). Windows has no per-window switch: WebView2 takes
            // browser arguments per environment, shared with every other window.
            //
            // tao still activates the app at a login launch (its menu bar may
            // show briefly). Accepted: AppHandle::hide() would avoid it, but a
            // hidden app keeps the voice-typing overlay panel from coming up.
            //
            // An in-app update relaunch inherits `--autostart` from the process
            // it replaces; the marker the update path left says to show the
            // window anyway. Taken on every launch, so it is always consumed.
            let launched_at_login = autostart::is_autostart_launch(std::env::args());
            let relaunched_after_update = autostart::take_show_on_next_launch(app.handle());
            if autostart::start_hidden(launched_at_login, has_way_back, relaunched_after_update) {
                log::info!("app: launched at login; main window stays hidden");
            } else {
                if launched_at_login && relaunched_after_update {
                    log::info!("app: relaunched by an update; showing the main window");
                }
                show_main_window(app.handle());
            }
            // A LaunchAgent missing AbandonProcessGroup gets it now, so the
            // next login launch survives an update relaunch (autostart.rs).
            #[cfg(target_os = "macos")]
            autostart::repair_launch_agent(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_meeting,
            commands::stop_meeting,
            commands::cancel_meeting,
            commands::set_meeting_paused,
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
            commands::read_dictionary,
            commands::write_dictionary,
            commands::read_folders,
            commands::write_folders,
            commands::read_log_tail,
            commands::write_session,
            commands::read_session_commands,
            commands::append_session_command_result,
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
            voice_typing::insert_text,
            voice_typing::accessibility_status,
            voice_typing::present_voice_overlay,
            voice_typing::dismiss_voice_overlay,
            voice_typing::set_voice_overlay_hit_rects,
            ax_observe::observe_pasted_field,
            hotkey::ensure_fn_listener,
            hotkey::input_monitoring_status,
            hotkey::request_input_monitoring,
            hotkey::set_voice_typing_shortcut,
            hotkey::set_voice_typing_cancel_armed,
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
            history::read_transcript_file,
            history::write_sample_audio,
            playback::prepare_playback_fallback,
            diarize::download_diarize_model,
            diarize::diarize_model_status,
            mcp::get_mcp_server_info,
            mcp::get_mcp_activity,
            cache::clear_cache,
            cache::cache_sizes,
            autostart::launch_at_login_status,
            autostart::set_launch_at_login,
            autostart::mark_show_on_next_launch,
            autostart::clear_show_on_next_launch,
            tray::tray_active,
            tray::set_tray_labels
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(
            #[allow(unused_variables)]
            |app, event| {
                // macOS: a Dock-icon click (or launching the app again while
                // it's already running) arrives as `Reopen`. tao's app delegate
                // suppresses AppKit's default un-minimize response, so without
                // this handler the click does nothing once the main window is
                // hidden or minimized — the "app sits in the Dock but won't
                // open" bug.
                #[cfg(target_os = "macos")]
                if let tauri::RunEvent::Reopen { .. } = event {
                    show_main_window(app);
                }
            },
        );
}

/// Bring the main window back for a Dock-icon click (macOS Reopen), a second
/// app launch (single-instance callback), or the Windows tray icon (left click
/// or "Open Parley"): un-minimize + show + focus. On both shipping platforms
/// the close button now HIDES the main window — into the Dock on macOS, the
/// notification area on Windows — so this is the normal way back to it. Setup
/// also calls it to show the window on every launch that is not a login launch
/// (the window is created hidden, see setup).
/// Recreated from the window config if it was destroyed — possible via paths
/// that bypass the frontend's hide-on-close, such as a crashed webview. The
/// config says `"visible": false`, so the rebuilt window is explicitly made
/// visible and focused; otherwise it would come back invisible.
pub(crate) fn show_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
    else {
        log::error!("window: no main window config to recreate from");
        return;
    };
    match tauri::WebviewWindowBuilder::from_config(app, &config)
        .and_then(|b| b.visible(true).focused(true).build())
    {
        Ok(_) => log::info!("window: recreated main window on reopen"),
        Err(e) => log::error!("window: failed to recreate main window: {e}"),
    }
}
