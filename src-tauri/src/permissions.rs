//! macOS permission checks for onboarding. Two permissions gate a real
//! meeting: the microphone (your voice) and screen recording (required for the
//! Core Audio system-audio tap that captures the other party).

// The `objc` 0.2 macros emit `cfg(cargo-clippy)` checks newer compilers warn on.
#![allow(unexpected_cfgs)]

use serde::Serialize;

#[cfg(target_os = "macos")]
mod imp {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    // Link the frameworks so AVCaptureDevice and the CG functions resolve.
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

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

    pub fn screen_recording_authorized() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() }
    }

    /// Prompt for screen-recording access. Returns the (possibly stale) status;
    /// macOS often only reflects the grant after the app restarts.
    pub fn request_screen_recording() -> bool {
        unsafe { CGRequestScreenCaptureAccess() }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn microphone_status() -> &'static str {
        "unknown"
    }
    pub fn screen_recording_authorized() -> bool {
        true
    }
    pub fn request_screen_recording() -> bool {
        true
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    /// notDetermined | restricted | denied | authorized | unknown
    pub microphone: String,
    pub screen_recording: bool,
}

#[tauri::command]
pub fn check_permissions() -> Permissions {
    Permissions {
        microphone: imp::microphone_status().to_string(),
        screen_recording: imp::screen_recording_authorized(),
    }
}

/// Prompt the OS for screen-recording access (used by onboarding).
#[tauri::command]
pub fn request_screen_recording() -> bool {
    imp::request_screen_recording()
}

/// Open the relevant macOS Privacy settings pane so the user can grant access
/// manually (the native prompts only fire once and need an app restart).
#[tauri::command]
pub fn open_privacy_settings(pane: String) {
    #[cfg(target_os = "macos")]
    {
        let anchor = match pane.as_str() {
            "screen" => "Privacy_ScreenCapture",
            "microphone" => "Privacy_Microphone",
            _ => "Privacy",
        };
        let url = format!("x-apple.systempreferences:com.apple.preference.security?{anchor}");
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = pane;
}
