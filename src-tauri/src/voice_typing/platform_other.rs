use super::clipboard::Foreground;

pub fn paste_to_frontmost() -> bool {
    false
}
pub fn foreground() -> Foreground {
    Foreground::default()
}
pub fn frontmost_bundle_id() -> Option<String> {
    None
}
pub fn accessibility_trusted(_prompt: bool) -> bool {
    false
}

// No overlay window to drive here: `overlay_handle` is always None.
pub type OverlayHandle = *mut std::ffi::c_void;
pub const CLICK_THROUGH: bool = false;
pub fn present_overlay(_handle: OverlayHandle) {}
pub fn dismiss_overlay(_handle: OverlayHandle) {}
pub fn cursor_fraction(_handle: OverlayHandle) -> Option<(f64, f64)> {
    None
}
pub fn set_pass_through(_handle: OverlayHandle, _pass: bool) {}
pub fn is_pass_through(_handle: OverlayHandle) -> bool {
    false
}
