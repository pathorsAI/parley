//! OS permission checks for onboarding + the Settings Permissions panel.
//! Two permissions gate a real meeting: the microphone (your voice) and system
//! audio (the capture of the other party). On macOS the latter is the Core
//! Audio process tap's own TCC service (NOT Screen Recording), prompted via
//! `NSAudioCaptureUsageDescription`. On Windows the microphone is a per-app
//! privacy setting read from the capability consent store; system audio
//! (WASAPI loopback) needs no consent and reports `unsupported` until the
//! loopback capture ships.
//!
//! Status checks here must be side-effect free: `check_permissions` is polled by
//! onboarding, so it must never trigger an OS consent prompt. Anything that can
//! prompt (`request_microphone`, `probe_system_audio`) is a separate command
//! wired to an explicit user click.

// The `objc` 0.2 macros emit `cfg(cargo-clippy)` checks newer compilers warn on.
#![allow(unexpected_cfgs)]

use std::sync::atomic::{AtomicU8, Ordering};

use serde::Serialize;
use tauri::AppHandle;

/// Last known System Audio Recording state. There is no public side-effect-free
/// TCC query for the process tap, so we cache what the probes and real meeting
/// captures observe: 0 = unknown (never probed), 1 = granted, 2 = denied,
/// 3 = unsupported (macOS < 14.2).
static SYSTEM_AUDIO: AtomicU8 = AtomicU8::new(SA_UNKNOWN);

const SA_UNKNOWN: u8 = 0;
const SA_GRANTED: u8 = 1;
const SA_DENIED: u8 = 2;
const SA_UNSUPPORTED: u8 = 3;

fn system_audio_str() -> &'static str {
    match SYSTEM_AUDIO.load(Ordering::SeqCst) {
        SA_GRANTED => "granted",
        SA_DENIED => "denied",
        SA_UNSUPPORTED => "unsupported",
        _ => "unknown",
    }
}

/// Called from the meeting's system-audio capture when tapped frames actually
/// arrive — the strongest possible "granted" signal.
pub fn note_system_audio_granted() {
    SYSTEM_AUDIO.store(SA_GRANTED, Ordering::SeqCst);
}

#[cfg(target_os = "macos")]
mod imp {
    use block2::RcBlock;
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    // Link the framework so AVCaptureDevice resolves.
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    /// Microphone authorization via AVFoundation (AVMediaTypeAudio == "soun").
    pub fn microphone_status() -> &'static str {
        unsafe {
            let media_type = CFString::new("soun");
            let mt: *const Object = media_type.as_concrete_TypeRef() as *const Object;
            let cls = class!(AVCaptureDevice);
            let status: i64 = msg_send![cls, authorizationStatusForMediaType: mt];
            match status {
                0 => "notDetermined",
                1 => "restricted",
                2 => "denied",
                3 => "authorized",
                _ => "unknown",
            }
        }
    }

    /// Show the native microphone prompt (no-op completion handler).
    pub fn request_microphone() {
        unsafe {
            let media_type = CFString::new("soun");
            let mt: *const Object = media_type.as_concrete_TypeRef() as *const Object;
            let handler = RcBlock::<dyn Fn(i8)>::new(|_granted| {});
            let cls = class!(AVCaptureDevice);
            let _: () = msg_send![cls, requestAccessForMediaType: mt completionHandler: &*handler];
            std::mem::forget(handler);
        }
    }

    /// Probe the process-tap authorization (may show the consent prompt).
    pub fn probe_system_audio() -> u8 {
        use crate::audio::system_macos::TapAccess;
        match crate::audio::system_macos::probe_access() {
            TapAccess::Granted => super::SA_GRANTED,
            TapAccess::Denied => super::SA_DENIED,
            TapAccess::Unsupported => super::SA_UNSUPPORTED,
        }
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const CONSENT_STORE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

    /// Windows gates the microphone per user in Settings › Privacy & security ›
    /// Microphone. Desktop (non-packaged) apps are governed by two switches in
    /// the capability consent store: the master `microphone` value and the
    /// `NonPackaged` value ("Let desktop apps access your microphone"). Both
    /// default to Allow when absent, so a missing key reads as authorized.
    pub fn microphone_status() -> &'static str {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let denied = |subkey: &str| -> bool {
            hkcu.open_subkey(subkey)
                .and_then(|k| k.get_value::<String, _>("Value"))
                .map(|v| v.eq_ignore_ascii_case("Deny"))
                .unwrap_or(false)
        };
        if denied(CONSENT_STORE) || denied(&format!(r"{CONSENT_STORE}\NonPackaged")) {
            "denied"
        } else {
            "authorized"
        }
    }

    /// Windows shows no runtime consent prompt for desktop apps — access is
    /// toggled in Settings, which `open_privacy_settings` deep-links to.
    pub fn request_microphone() {}

    /// WASAPI loopback capture is not implemented yet; `unsupported` keeps the
    /// system-audio rows hidden in onboarding and Settings. Flips to granted
    /// when the loopback source lands (loopback needs no OS consent).
    pub fn probe_system_audio() -> u8 {
        super::SA_UNSUPPORTED
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    pub fn microphone_status() -> &'static str {
        "unknown"
    }
    pub fn request_microphone() {}
    pub fn probe_system_audio() -> u8 {
        super::SA_UNSUPPORTED
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    /// notDetermined | restricted | denied | authorized | unknown
    pub microphone: String,
    /// unknown | granted | denied | unsupported — last observed process-tap
    /// state (see SYSTEM_AUDIO). "unknown" until a probe or meeting runs.
    pub system_audio: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppIdentity {
    pub bundle_identifier: String,
    pub executable_path: String,
    pub running_from_app_bundle: bool,
    pub likely_dev_binary: bool,
}

/// Side-effect-free status snapshot (safe to poll — never prompts).
#[tauri::command]
pub fn check_permissions() -> Permissions {
    Permissions {
        microphone: imp::microphone_status().to_string(),
        system_audio: system_audio_str().to_string(),
    }
}

#[tauri::command]
pub fn app_identity(app: AppHandle) -> AppIdentity {
    let executable_path = std::env::current_exe()
        .ok()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    // Normalize separators so the heuristics below hold on Windows too.
    let normalized = executable_path.replace('\\', "/");
    let running_from_app_bundle = normalized.contains(".app/Contents/MacOS/");
    let likely_dev_binary = !running_from_app_bundle
        && (normalized.contains("/target/debug/")
            || normalized.contains("/cargo-target/debug/")
            || normalized.contains("/cursor-sandbox-cache/"));

    AppIdentity {
        bundle_identifier: app.config().identifier.clone(),
        executable_path,
        running_from_app_bundle,
        likely_dev_binary,
    }
}

/// Explicitly test/request System Audio Recording by creating (and immediately
/// destroying) a process tap. First call with TCC undetermined → macOS shows the
/// consent prompt. Returns the resulting status string. Wire this to a user
/// click only. Async + spawn_blocking: tap creation can block on the TCC XPC
/// while the consent prompt is up, and that must not freeze the main thread.
#[tauri::command]
pub async fn probe_system_audio() -> String {
    let state = tauri::async_runtime::spawn_blocking(imp::probe_system_audio)
        .await
        .unwrap_or(SA_UNKNOWN);
    SYSTEM_AUDIO.store(state, Ordering::SeqCst);
    system_audio_str().to_string()
}

/// Show the native microphone permission prompt.
#[tauri::command]
pub fn request_microphone() {
    imp::request_microphone();
}

/// Open the relevant macOS Settings pane so the user can grant access manually
/// (the native prompts only fire once and may need an app restart).
/// "system-audio" and "screen" both land on the Screen & System Audio Recording
/// pane — that's where the tap's "System Audio Recording Only" entry lives.
/// "keyboard" opens the Keyboard pane (for setting the 🌐/fn key to "Do
/// Nothing" when Parley can only listen to it, not swallow it).
#[tauri::command]
pub fn open_privacy_settings(pane: String) {
    #[cfg(target_os = "macos")]
    {
        let url = match pane.as_str() {
            "keyboard" => {
                "x-apple.systempreferences:com.apple.Keyboard-Settings.extension".to_string()
            }
            _ => {
                let anchor = match pane.as_str() {
                    "screen" | "system-audio" => "Privacy_ScreenCapture",
                    "microphone" => "Privacy_Microphone",
                    "accessibility" => "Privacy_Accessibility",
                    "input-monitoring" => "Privacy_ListenEvent",
                    _ => "Privacy",
                };
                format!("x-apple.systempreferences:com.apple.preference.security?{anchor}")
            }
        };
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        // Only the microphone has a Windows analogue; everything else lands on
        // the privacy hub. explorer.exe resolves ms-settings: URIs without the
        // cmd `start` quoting pitfalls.
        let url = match pane.as_str() {
            "microphone" => "ms-settings:privacy-microphone",
            _ => "ms-settings:privacy",
        };
        let _ = std::process::Command::new("explorer.exe").arg(url).spawn();
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = pane;
}
