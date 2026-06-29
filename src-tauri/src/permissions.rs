//! macOS permission checks for onboarding. Two permissions gate a real
//! meeting: the microphone (your voice) and screen recording (required for the
//! Core Audio system-audio tap that captures the other party).

// The `objc` 0.2 macros emit `cfg(cargo-clippy)` checks newer compilers warn on.
#![allow(unexpected_cfgs)]

use serde::Serialize;

#[cfg(target_os = "macos")]
mod imp {
    use block::ConcreteBlock;
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    // Link the frameworks so AVCaptureDevice and the CG functions resolve.
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    use std::ffi::c_void;

    type CFArrayRef = *const c_void;
    type CFDictionaryRef = *const c_void;
    type CFStringRef = *const c_void;
    type CFTypeRef = *const c_void;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
        fn CGMainDisplayID() -> u32;
        fn CGDisplayStreamCreate(
            display: u32,
            output_width: usize,
            output_height: usize,
            pixel_format: i32,
            properties: CFDictionaryRef,
            handler: *const c_void,
        ) -> CFTypeRef;
        fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> CFArrayRef;
        static kCGWindowName: CFStringRef;
        static kCGWindowOwnerPID: CFStringRef;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFArrayGetCount(arr: CFArrayRef) -> isize;
        fn CFArrayGetValueAtIndex(arr: CFArrayRef, idx: isize) -> CFTypeRef;
        fn CFDictionaryGetValue(dict: CFDictionaryRef, key: *const c_void) -> CFTypeRef;
        fn CFStringGetLength(s: CFStringRef) -> isize;
        fn CFNumberGetValue(num: *const c_void, the_type: isize, value: *mut c_void) -> bool;
        fn CFRelease(cf: *const c_void);
    }

    const KCG_ON_SCREEN_ONLY: u32 = 1;
    const KCG_EXCLUDE_DESKTOP: u32 = 16;
    const KCF_NUMBER_SINT32: isize = 3;
    const PIXEL_FORMAT_BGRA: i32 = i32::from_be_bytes(*b"BGRA");

    /// Screen Recording grants are ultimately about being allowed to capture the
    /// display, not about whether any other app currently has a titled window.
    /// Creating a tiny display stream is a stronger probe than the window-list
    /// heuristic below and does not need the stream to be started.
    fn can_create_display_stream() -> bool {
        unsafe {
            let handler = ConcreteBlock::new(
                |_status: i32, _time: u64, _surface: *const c_void, _update: *const c_void| {},
            );
            let handler = handler.copy();
            let stream = CGDisplayStreamCreate(
                CGMainDisplayID(),
                1,
                1,
                PIXEL_FORMAT_BGRA,
                std::ptr::null(),
                &*handler as *const _ as *const c_void,
            );
            if !stream.is_null() {
                CFRelease(stream);
                true
            } else {
                false
            }
        }
    }

    /// Robust Screen-Recording check: `CGPreflightScreenCaptureAccess` is
    /// unreliable on recent macOS (returns false even when granted), so fall back
    /// to probing whether we can read ANOTHER app's window title — only possible
    /// when Screen Recording is actually granted.
    fn can_read_other_window_titles() -> bool {
        unsafe {
            let list = CGWindowListCopyWindowInfo(KCG_ON_SCREEN_ONLY | KCG_EXCLUDE_DESKTOP, 0);
            if list.is_null() {
                return false;
            }
            let our_pid = std::process::id() as i32;
            let count = CFArrayGetCount(list);
            let mut granted = false;
            for i in 0..count {
                let dict = CFArrayGetValueAtIndex(list, i) as CFDictionaryRef;
                if dict.is_null() {
                    continue;
                }
                let pid_ref = CFDictionaryGetValue(dict, kCGWindowOwnerPID as *const c_void);
                let mut pid: i32 = 0;
                if pid_ref.is_null()
                    || !CFNumberGetValue(
                        pid_ref,
                        KCF_NUMBER_SINT32,
                        &mut pid as *mut i32 as *mut c_void,
                    )
                {
                    continue;
                }
                if pid == our_pid {
                    continue; // our own windows always expose their title
                }
                let name =
                    CFDictionaryGetValue(dict, kCGWindowName as *const c_void) as CFStringRef;
                if !name.is_null() && CFStringGetLength(name) > 0 {
                    granted = true;
                    break;
                }
            }
            CFRelease(list);
            granted
        }
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

    /// Show the native microphone prompt (no-op completion handler).
    pub fn request_microphone() {
        unsafe {
            let media_type = CFString::new("soun");
            let mt: *const Object = media_type.as_concrete_TypeRef() as *const Object;
            let handler = ConcreteBlock::new(|_granted: bool| {});
            let handler = handler.copy();
            let cls = class!(AVCaptureDevice);
            let _: () = msg_send![cls, requestAccessForMediaType: mt completionHandler: &*handler];
            std::mem::forget(handler);
        }
    }

    pub fn screen_recording_authorized() -> bool {
        if unsafe { CGPreflightScreenCaptureAccess() } {
            return true;
        }
        if can_create_display_stream() {
            return true;
        }
        can_read_other_window_titles()
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
    pub fn request_microphone() {}
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

/// Show the native microphone permission prompt.
#[tauri::command]
pub fn request_microphone() {
    imp::request_microphone();
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
            "accessibility" => "Privacy_Accessibility",
            "input-monitoring" => "Privacy_ListenEvent",
            _ => "Privacy",
        };
        let url = format!("x-apple.systempreferences:com.apple.preference.security?{anchor}");
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = pane;
}
