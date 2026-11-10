//! What a minimized window looks like in the macOS Dock. By default AppKit
//! shows a snapshot of the window there; the floating meeting window is a
//! small borderless, transparent pill, so its snapshot reads as a blank tile.
//! It shows the Parley logo instead. Other platforms are left alone (Windows
//! minimizes into the app's own taskbar button, which already carries it).

/// The logo the Dock shows for a minimized meeting window.
#[cfg(target_os = "macos")]
const LOGO: &[u8] = include_bytes!("../icons/128x128@2x.png");

/// Give `window` the Parley logo as its minimized Dock tile.
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
pub(crate) fn use_logo_when_minimized<R: tauri::Runtime>(window: &tauri::Window<R>) {
    #[cfg(target_os = "macos")]
    {
        let Ok(ns_window) = window.ns_window() else {
            return;
        };
        let ns_window = ns_window as usize;
        let _ = window.run_on_main_thread(move || macos::set_miniwindow_image(ns_window as *mut _));
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::c_void;

    /// `-[NSWindow setMiniwindowImage:]` with the logo. Must run on the main
    /// thread.
    pub(super) fn set_miniwindow_image(ns_window: *mut c_void) {
        if ns_window.is_null() {
            return;
        }
        unsafe {
            let data: *mut Object = msg_send![class!(NSData),
                dataWithBytes: super::LOGO.as_ptr() as *const c_void
                length: super::LOGO.len()];
            if data.is_null() {
                return;
            }
            let image: *mut Object = msg_send![class!(NSImage), alloc];
            let image: *mut Object = msg_send![image, initWithData: data];
            if image.is_null() {
                log::debug!("dock tile: logo image did not load");
                return;
            }
            let _: () = msg_send![ns_window as *mut Object, setMiniwindowImage: image];
            // The window retains it.
            let _: () = msg_send![image, release];
        }
    }
}
