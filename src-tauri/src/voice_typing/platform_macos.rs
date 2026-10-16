use super::clipboard::Foreground;
use core_foundation::base::TCFType;
use core_foundation::string::CFString;
use objc::runtime::{Class, Object};
use objc::{class, msg_send, sel, sel_impl};
use std::ffi::c_void;

#[link(name = "AppKit", kind = "framework")]
extern "C" {}

// libobjc — reassign an instance's class (used to turn the wry NSWindow into
// a non-activating NSPanel so it can float over full-screen Spaces).
extern "C" {
    fn object_setClass(obj: *mut Object, cls: *const Class) -> *const Class;
}

type CGEventRef = *const c_void;
type CFDictionaryRef = *const c_void;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreateKeyboardEvent(
        source: *const c_void,
        keycode: u16,
        keydown: bool,
    ) -> CGEventRef;
    fn CGEventSetFlags(event: CGEventRef, flags: u64);
    fn CGEventPost(tap: u32, event: CGEventRef);
    fn CGEventSourceFlagsState(state_id: i32) -> u64;
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
    static kAXTrustedCheckOptionPrompt: *const c_void;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const c_void);
}

const KVK_ANSI_V: u16 = 9;
const FLAG_COMMAND: u64 = 0x0010_0000; // kCGEventFlagMaskCommand
const HID_EVENT_TAP: u32 = 0; // kCGHIDEventTap
const HID_SYSTEM_STATE: i32 = 1; // kCGEventSourceStateHIDSystemState
/// Shift, Control, Option, Command and fn (kCGEventFlagMask*).
const MODIFIER_FLAGS: u64 = 0x0002_0000 | 0x0004_0000 | 0x0008_0000 | 0x0010_0000 | 0x0080_0000;

/// Bundle identifier of the frontmost application, via
/// `NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier`.
/// `None` when nothing is frontmost or the app has no bundle id (which some
/// helper/agent processes genuinely don't). Needs no permission — unlike the
/// AX APIs, NSWorkspace's app list is not TCC-gated.
pub fn frontmost_bundle_id() -> Option<String> {
    unsafe {
        let workspace: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
        if workspace.is_null() {
            return None;
        }
        let app: *mut Object = msg_send![workspace, frontmostApplication];
        if app.is_null() {
            return None;
        }
        // NSString is toll-free bridged to CFString, so we can read it
        // through core-foundation instead of hand-rolling UTF-8 extraction.
        let bundle_id: *const Object = msg_send![app, bundleIdentifier];
        if bundle_id.is_null() {
            return None;
        }
        // `bundleIdentifier` is a +0 (autoreleased) getter, so take a get-rule
        // reference — wrapping it under the create rule would over-release.
        let s = CFString::wrap_under_get_rule(bundle_id as _);
        Some(s.to_string())
    }
}

/// `NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier` —
/// same no-permission-needed source as `frontmost_bundle_id`.
pub fn frontmost_pid() -> Option<i32> {
    unsafe {
        let workspace: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
        if workspace.is_null() {
            return None;
        }
        let app: *mut Object = msg_send![workspace, frontmostApplication];
        if app.is_null() {
            return None;
        }
        let pid: i32 = msg_send![app, processIdentifier];
        (pid > 0).then_some(pid)
    }
}

/// Whether Parley itself is the frontmost app. macOS answers per app, not
/// per window, and has nothing like Windows' hidden tray window for the
/// paste to land on: Parley has no menu-bar icon, and the overlay never
/// activates it. So Parley in front means the user brought up one of its
/// windows, and the paste goes there.
pub fn foreground() -> Foreground {
    let own = frontmost_pid()
        .is_some_and(|pid| u32::try_from(pid).is_ok_and(|pid| pid == std::process::id()));
    Foreground { own, hidden: false }
}

pub fn paste_to_frontmost() -> bool {
    if !accessibility_trusted(false) {
        return false;
    }
    unsafe {
        // A quick re-press pastes the previous dictation while the trigger
        // (⌥Space, or a held right-modifier) is still physically down.
        // Windows lifts held modifiers before its Ctrl+V; here only the
        // Command flag is set on the posted events, and whether the window
        // server folds a held ⌥ into them is unverified. Logged only when
        // something is held, so an ordinary paste stays quiet.
        let held = CGEventSourceFlagsState(HID_SYSTEM_STATE) & MODIFIER_FLAGS;
        if held != 0 {
            log::info!("voice-typing: pasting with modifiers held (flags {held:#x})");
        }
        let down = CGEventCreateKeyboardEvent(std::ptr::null(), KVK_ANSI_V, true);
        let up = CGEventCreateKeyboardEvent(std::ptr::null(), KVK_ANSI_V, false);
        if down.is_null() || up.is_null() {
            return false;
        }
        CGEventSetFlags(down, FLAG_COMMAND);
        CGEventSetFlags(up, FLAG_COMMAND);
        CGEventPost(HID_EVENT_TAP, down);
        CGEventPost(HID_EVENT_TAP, up);
        CFRelease(down);
        CFRelease(up);
        true
    }
}

/// NSScreenSaverWindowLevel — high enough to float above native full-screen
/// apps (a popup-menu level is not).
const OVERLAY_WINDOW_LEVEL: isize = 1000;
/// canJoinAllSpaces (1<<0) | stationary (1<<4) | ignoresCycle (1<<6) |
/// fullScreenAuxiliary (1<<8): show on whatever Space is active, including
/// over a full-screen app, without joining window cycling.
const OVERLAY_COLLECTION_BEHAVIOR: usize = (1 << 0) | (1 << 4) | (1 << 6) | (1 << 8);
/// NSWindowStyleMaskNonactivatingPanel — the panel shows without activating
/// Parley or stealing focus.
const NONACTIVATING_PANEL: usize = 1 << 7;

pub fn present_overlay(ns_window: *mut std::ffi::c_void) {
    unsafe {
        let w = ns_window as *mut Object;
        // A plain NSWindow gets isolated to its own Space and can't float over
        // another app's full-screen Space. Turning it into a non-activating
        // NSPanel (+ fullScreenAuxiliary) is the native pattern for overlays.
        // Keyed off the window's own class — a process-wide one-shot flag
        // would skip the conversion forever if the overlay window is ever
        // destroyed and recreated.
        let is_panel: bool = msg_send![w, isKindOfClass: class!(NSPanel)];
        if !is_panel {
            object_setClass(w, class!(NSPanel) as *const Class);
            let style: usize = msg_send![w, styleMask];
            let _: () = msg_send![w, setStyleMask: style | NONACTIVATING_PANEL];
            // Only take key status when a view genuinely needs it — none
            // here does, and the panel is borderless, so it never asks.
            let _: () = msg_send![w, setBecomesKeyOnlyIfNeeded: true];
            // Once per window: a recreated overlay starts as a TaoWindow
            // again and comes back through this branch.
            prevent_activation(w);
            let _: () = msg_send![w, setFloatingPanel: true];
            let _: () = msg_send![w, setHidesOnDeactivate: false];
        }
        let _: () = msg_send![w, setCollectionBehavior: OVERLAY_COLLECTION_BEHAVIOR];
        let _: () = msg_send![w, setLevel: OVERLAY_WINDOW_LEVEL];
        let _: () = msg_send![w, orderFrontRegardless];
        // canJoinAllSpaces alone isn't enough over a long-running session:
        // see spaces::rejoin_all for why the flag and the window server's
        // actual placement drift apart.
        spaces::rejoin_all(w);
    }
    log::info!("voice-typing: overlay presented (panel)");
}

/// `-setStyleMask:` never propagates NSWindowStyleMaskNonactivatingPanel to
/// the activation flag AppKit sets only in NSPanel's own init (Wine's
/// cocoa_window.m documents the same bug), so a mouse-down on this converted
/// panel activated Parley: the menu bar switched, the main window came
/// forward, and the ⌘V that followed the release landed in Parley instead
/// of the field the user was dictating into. `_setPreventsActivation:` is
/// the private funnel the native init uses. It is idempotent and later
/// style-mask changes do not reset it. Guarded like the CGS calls in
/// `spaces`: a future macOS without it logs a warning instead of crashing.
/// The read-back puts the outcome in parley.log, so a report of "clicking
/// the overlay brings Parley up" can be checked against it.
unsafe fn prevent_activation(w: *mut Object) {
    let responds: bool = msg_send![w, respondsToSelector: sel!(_setPreventsActivation:)];
    if !responds {
        log::warn!(
            "voice-typing: _setPreventsActivation: unavailable; overlay clicks may activate Parley"
        );
        return;
    }
    let _: () = msg_send![w, _setPreventsActivation: true];
    let can_read: bool = msg_send![w, respondsToSelector: sel!(_preventsActivation)];
    if can_read {
        let on: bool = msg_send![w, _preventsActivation];
        log::info!("voice-typing: overlay panel preventsActivation={on}");
    }
}

/// Re-home the overlay whenever the active Space changes (a trackpad swipe,
/// Ctrl+←/→, Mission Control) while it is on screen. The present-time
/// rejoin covers every Space that existed when the dictation began; this
/// covers the rest, e.g. an app entering full screen mid-dictation, so
/// swiping to any Space mid-sentence keeps the overlay in front of the user.
pub fn install_space_observer(app: tauri::AppHandle) {
    use block2::RcBlock;
    use tauri::Manager;
    unsafe {
        let ws: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
        let nc: *mut Object = msg_send![ws, notificationCenter];
        let queue: *mut Object = msg_send![class!(NSOperationQueue), mainQueue];
        let block = RcBlock::<dyn Fn(*mut c_void)>::new(move |_note| {
            let Some(win) = app.get_webview_window("voice-typing") else {
                return;
            };
            let Ok(ns) = win.ns_window() else {
                return;
            };
            let w = ns as *mut Object;
            let visible: bool = msg_send![w, isVisible];
            if !visible {
                return; // idle — the next present rejoins anyway
            }
            spaces::rejoin_all(w);
            let _: () = msg_send![w, orderFrontRegardless];
        });
        let name = CFString::new("NSWorkspaceActiveSpaceDidChangeNotification");
        let name_obj = name.as_concrete_TypeRef() as *const Object;
        let nil: *mut Object = std::ptr::null_mut();
        let _observer: *mut Object = msg_send![nc, addObserverForName: name_obj object: nil queue: queue usingBlock: &*block];
        // Never removed — the center keeps the observer + block alive for
        // the app's lifetime; forget our handle so it isn't dropped under it.
        std::mem::forget(block);
    }
}

/// Keeping the overlay a member of every Space.
///
/// `canJoinAllSpaces` is supposed to make the window server show the
/// overlay on every Space. It does when the flag is first applied, but in a
/// long-running session the window server's actual placement drifts away
/// from it: a Parley that had been up for days had its overlay attached to
/// just the desktop Space and the one full-screen Space it was last shown
/// on, while the flag still read canJoinAllSpaces. Swiping to any other
/// full-screen app then left the overlay behind on Parley's Space. Nothing
/// public repairs that in place — re-applying the same collection
/// behaviour, clearing and re-setting it, round-tripping it through
/// moveToActiveSpace, re-ordering the window or changing its level all
/// leave the placement as it is — and recreating the window mid-dictation
/// would lose the transcript the overlay has already rendered.
///
/// So we reconcile the placement directly: ask the window server which
/// Spaces exist and which ones the overlay is on, and add it to the rest.
/// These are SkyLight's private CGS calls (the same ones window managers
/// use), so they are looked up at runtime with `dlsym` rather than linked:
/// if a future macOS drops or renames one, the lookup fails and this
/// becomes a no-op, rather than dyld refusing to launch the app over a
/// missing symbol.
mod spaces {
    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use objc::runtime::Object;
    use objc::{msg_send, sel, sel_impl};
    use std::collections::BTreeSet;
    use std::ffi::{c_char, c_void};
    use std::sync::OnceLock;

    extern "C" {
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    }
    /// `RTLD_DEFAULT` on Darwin: search every image already loaded (AppKit
    /// pulls in SkyLight, which exports the CGS symbols).
    const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;
    /// kCGSAllSpacesMask — user, full-screen and system Spaces alike.
    const ALL_SPACES_MASK: i32 = 0x7;

    type MainConnectionFn = unsafe extern "C" fn() -> i32;
    type CopyManagedDisplaySpacesFn = unsafe extern "C" fn(i32) -> CFArrayRef;
    type CopySpacesForWindowsFn = unsafe extern "C" fn(i32, i32, CFArrayRef) -> CFArrayRef;
    type AddWindowsToSpacesFn = unsafe extern "C" fn(i32, CFArrayRef, CFArrayRef);

    struct Api {
        main_connection: MainConnectionFn,
        copy_managed_display_spaces: CopyManagedDisplaySpacesFn,
        copy_spaces_for_windows: CopySpacesForWindowsFn,
        add_windows_to_spaces: AddWindowsToSpacesFn,
    }

    fn api() -> Option<&'static Api> {
        static API: OnceLock<Option<Api>> = OnceLock::new();
        API.get_or_init(|| unsafe {
            let sym = |name: &[u8]| dlsym(RTLD_DEFAULT, name.as_ptr() as *const c_char);
            let main = sym(b"CGSMainConnectionID\0");
            let managed = sym(b"CGSCopyManagedDisplaySpaces\0");
            let for_windows = sym(b"CGSCopySpacesForWindows\0");
            let add = sym(b"CGSAddWindowsToSpaces\0");
            if [main, managed, for_windows, add].iter().any(|p| p.is_null()) {
                log::warn!("voice-typing: CGS Spaces API unavailable; overlay Space repair disabled");
                return None;
            }
            Some(Api {
                main_connection: std::mem::transmute::<*mut c_void, MainConnectionFn>(main),
                copy_managed_display_spaces: std::mem::transmute::<
                    *mut c_void,
                    CopyManagedDisplaySpacesFn,
                >(managed),
                copy_spaces_for_windows: std::mem::transmute::<
                    *mut c_void,
                    CopySpacesForWindowsFn,
                >(for_windows),
                add_windows_to_spaces: std::mem::transmute::<*mut c_void, AddWindowsToSpacesFn>(
                    add,
                ),
            })
        })
        .as_ref()
    }

    /// Items of a CF array we got under the create rule, as owned CFTypes.
    unsafe fn items(raw: CFArrayRef) -> Vec<CFType> {
        if raw.is_null() {
            return Vec::new();
        }
        let arr: CFArray<*const c_void> = CFArray::wrap_under_create_rule(raw);
        arr.iter().map(|p| CFType::wrap_under_get_rule(*p)).collect()
    }

    /// `dict[key]` for an untyped CF dictionary.
    fn value(dict: &CFType, key: &CFString) -> Option<CFType> {
        let dict = dict.downcast::<CFDictionary>()?;
        let v = dict.find(key.as_CFTypeRef())?;
        Some(unsafe { CFType::wrap_under_get_rule(*v) })
    }

    fn as_i64(v: &CFType) -> Option<i64> {
        v.downcast::<CFNumber>()?.to_i64()
    }

    /// Every Space the window server manages, across all displays
    /// (`[{ "Spaces": [{ "ManagedSpaceID": n, … }], … }]`).
    unsafe fn all_space_ids(api: &Api, cid: i32) -> BTreeSet<i64> {
        let spaces_key = CFString::from_static_string("Spaces");
        let id_key = CFString::from_static_string("ManagedSpaceID");
        let mut ids = BTreeSet::new();
        for display in items((api.copy_managed_display_spaces)(cid)) {
            let Some(spaces) = value(&display, &spaces_key) else {
                continue;
            };
            let Some(spaces) = spaces.downcast::<CFArray>() else {
                continue;
            };
            for space in spaces.iter() {
                let space = CFType::wrap_under_get_rule(*space);
                if let Some(id) = value(&space, &id_key).as_ref().and_then(as_i64) {
                    ids.insert(id);
                }
            }
        }
        ids
    }

    /// Add the window to any Space it's missing from. Cheap when nothing is
    /// missing (two window-server queries), so it can run on every present.
    pub unsafe fn rejoin_all(w: *mut Object) {
        let Some(api) = api() else {
            return;
        };
        let wid: i64 = msg_send![w, windowNumber];
        if wid <= 0 {
            return; // no window-server window yet
        }
        let cid = (api.main_connection)();
        let all = all_space_ids(api, cid);
        if all.is_empty() {
            return;
        }
        let wids = CFArray::from_CFTypes(&[CFNumber::from(wid)]);
        let on: BTreeSet<i64> = items((api.copy_spaces_for_windows)(
            cid,
            ALL_SPACES_MASK,
            wids.as_concrete_TypeRef(),
        ))
        .iter()
        .filter_map(as_i64)
        .collect();
        let missing: Vec<CFNumber> = all.difference(&on).map(|&id| CFNumber::from(id)).collect();
        if missing.is_empty() {
            return;
        }
        log::info!(
            "voice-typing: overlay was on {} of {} Spaces; rejoining the other {}",
            on.len(),
            all.len(),
            missing.len()
        );
        let missing = CFArray::from_CFTypes(&missing);
        (api.add_windows_to_spaces)(cid, wids.as_concrete_TypeRef(), missing.as_concrete_TypeRef());
    }
}

pub fn dismiss_overlay(ns_window: *mut std::ffi::c_void) {
    unsafe {
        let w = ns_window as *mut Object;
        let nil: *mut Object = std::ptr::null_mut();
        let _: () = msg_send![w, orderOut: nil];
    }
}

/// The overlay's NSWindow, as `WebviewWindow::ns_window` hands it out.
pub type OverlayHandle = *mut c_void;

/// Click-through is live here (see `set_pass_through`).
pub const CLICK_THROUGH: bool = true;

// Foundation's geometry structs, for the two getters below that return
// them by value. CGFloat is f64 on every 64-bit Mac, and the build is
// arm64-only, where objc_msgSend returns these in registers.
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

/// Where the cursor is, as a fraction of the overlay window; None while the
/// window is not on screen. `+[NSEvent mouseLocation]` and `-frame` are
/// both global Cocoa points, so no scale factor enters into it — unlike
/// tao's cursor position, which a mixed-DPI desktop throws off.
pub fn cursor_fraction(ns_window: OverlayHandle) -> Option<(f64, f64)> {
    unsafe {
        let w = ns_window as *mut Object;
        let visible: bool = msg_send![w, isVisible];
        if !visible {
            return None;
        }
        let mouse: NSPoint = msg_send![class!(NSEvent), mouseLocation];
        let frame: NSRect = msg_send![w, frame];
        super::fraction_bottom_left(
            (mouse.x, mouse.y),
            (frame.origin.x, frame.origin.y),
            (frame.size.width, frame.size.height),
        )
    }
}

/// `pass` = let clicks through to whatever is behind the overlay.
pub fn set_pass_through(ns_window: OverlayHandle, pass: bool) {
    unsafe {
        let _: () = msg_send![ns_window as *mut Object, setIgnoresMouseEvents: pass];
    }
}

pub fn is_pass_through(ns_window: OverlayHandle) -> bool {
    unsafe { msg_send![ns_window as *mut Object, ignoresMouseEvents] }
}

pub fn accessibility_trusted(prompt: bool) -> bool {
    unsafe {
        if !prompt {
            let dict: CFDictionaryRef = std::ptr::null();
            return AXIsProcessTrustedWithOptions(dict);
        }
        // Build { kAXTrustedCheckOptionPrompt: true } so macOS shows the dialog.
        use core_foundation::boolean::CFBoolean;
        use core_foundation::dictionary::CFDictionary;
        let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt as _);
        let value = CFBoolean::true_value();
        let dict = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), value.as_CFType())]);
        AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef() as CFDictionaryRef)
    }
}
