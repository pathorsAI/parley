//! Moving and resizing a window with the platform's own animation — the
//! meeting's mini window gliding to its dock and growing or shrinking with
//! its tab, rather than jumping there.

/// Move and resize `window` to a frame in logical px with a top-left origin
/// (what `LogicalPosition` / `LogicalSize` take). On macOS it glides there over
/// `duration_ms` with an ease-out curve, without blocking; elsewhere the frame
/// is set at once.
#[tauri::command]
pub(crate) fn animate_window_frame(
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    duration_ms: u32,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // A raw pointer is not Send; the main-thread closure gets the address.
        let ns = window.ns_window().map_err(|e| e.to_string())? as usize;
        window
            .run_on_main_thread(move || unsafe {
                macos::glide(
                    ns as *mut objc::runtime::Object,
                    x,
                    y,
                    width,
                    height,
                    duration_ms,
                )
            })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = duration_ms;
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        window
            .set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use objc::runtime::{Class, Object, YES};
    use objc::{class, msg_send, sel, sel_impl};

    // Foundation's geometry structs. CGFloat is f64 on every 64-bit Mac.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSPoint {
        x: f64,
        y: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSSize {
        width: f64,
        height: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSRect {
        origin: NSPoint,
        size: NSSize,
    }

    /// Animate `w` to the top-left-origin frame through its animator proxy,
    /// inside an NSAnimationContext group that sets the duration and curve.
    /// Main thread only.
    pub(super) unsafe fn glide(
        w: *mut Object,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        duration_ms: u32,
    ) {
        // Cocoa's origin is the primary screen's bottom-left, y up; logical
        // positions are its points measured down from that screen's top.
        let screens: *mut Object = msg_send![class!(NSScreen), screens];
        let primary: *mut Object = msg_send![screens, firstObject];
        if primary.is_null() {
            return;
        }
        let screen: NSRect = msg_send![primary, frame];
        let frame = NSRect {
            origin: NSPoint {
                x,
                y: screen.size.height - y - height,
            },
            size: NSSize { width, height },
        };

        let context = class!(NSAnimationContext);
        let _: () = msg_send![context, beginGrouping];
        let current: *mut Object = msg_send![context, currentContext];
        let _: () = msg_send![current, setDuration: f64::from(duration_ms) / 1000.0];
        // QuartzCore comes with WebKit; look it up rather than assume it.
        if let Some(timing) = Class::get("CAMediaTimingFunction") {
            let name: *mut Object = msg_send![
                class!(NSString),
                stringWithUTF8String: c"easeOut".as_ptr()
            ];
            let curve: *mut Object = msg_send![timing, functionWithName: name];
            let _: () = msg_send![current, setTimingFunction: curve];
        }
        let animator: *mut Object = msg_send![w, animator];
        let _: () = msg_send![animator, setFrame: frame display: YES];
        let _: () = msg_send![context, endGrouping];
    }
}
