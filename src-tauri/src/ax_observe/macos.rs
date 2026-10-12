//! macOS reads for correction watching, through the Accessibility API: the
//! focused element's `AXValue`, scoped to the app voice typing pasted into.
//! The polling schedule, diff and stop conditions are in [`super::watch`].

// The `objc` 0.2 macros emit `cfg(cargo-clippy)` checks newer compilers warn on.
#![allow(unexpected_cfgs)]

use std::ffi::c_void;

use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::string::CFString;
use tauri::AppHandle;

use super::watch::{self, Tick, Watch};

type CFTypeRef = *const c_void;
type AXUIElementRef = *const c_void;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: *const c_void,
        value: *mut CFTypeRef,
    ) -> i32;
    fn AXUIElementGetTypeID() -> usize;
    fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut i32) -> i32;
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: *const c_void,
        value: CFTypeRef,
    ) -> i32;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: CFTypeRef);
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFStringGetTypeID() -> usize;
}

/// AX attribute names. Passed as plain CFStrings rather than linking the
/// `kAX*Attribute` globals — same shortcut voice_typing.rs takes for the
/// pasteboard UTI, and it keeps the extern block to the functions.
const AX_FOCUSED_UI_ELEMENT: &str = "AXFocusedUIElement";
const AX_VALUE: &str = "AXValue";
/// Electron's documented switch for its lazily-enabled accessibility tree.
/// Chromium ships with the tree OFF until an assistive client shows up, and
/// "no focused element" is what that looks like from outside. Setting this on
/// the APP element asks it to turn the tree on; non-Electron apps answer with
/// an AX error we ignore.
const AX_MANUAL_ACCESSIBILITY: &str = "AXManualAccessibility";

/// How often and how long to retry arming after the nudge — Chromium needs a
/// beat to build the tree once asked.
const ARM_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);
const ARM_RETRY_TRIES: u32 = 12;

/// An owned `AXUIElementRef` that may cross to the polling thread.
///
/// SAFETY: `AXUIElementRef` is a CoreFoundation type; CF objects are not
/// thread-affine, and the AX client APIs are documented as callable from any
/// thread (they marshal to the target process). This wrapper owns exactly one
/// retain, released in `Drop`, and is only ever touched by one thread at a
/// time (moved into the closure, never shared).
struct OwnedElement(AXUIElementRef);
unsafe impl Send for OwnedElement {}

impl Drop for OwnedElement {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) };
        }
    }
}

/// Copy an attribute off an AX element. `None` on any AX error or a null
/// result. The returned ref is owned by the caller (AX copy semantics).
unsafe fn copy_attribute(element: AXUIElementRef, attribute: &str) -> Option<CFTypeRef> {
    let name = CFString::new(attribute);
    let mut out: CFTypeRef = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(
        element,
        name.as_concrete_TypeRef() as *const c_void,
        &mut out,
    );
    if err != 0 || out.is_null() {
        return None;
    }
    Some(out)
}

/// The system-wide focused UI element, or `None` if nothing is focused (or the
/// focused thing isn't an AXUIElement).
unsafe fn copy_focused_element() -> Option<OwnedElement> {
    let system = AXUIElementCreateSystemWide();
    if system.is_null() {
        return None;
    }
    let focused = copy_attribute(system, AX_FOCUSED_UI_ELEMENT);
    CFRelease(system);
    let focused = focused?;
    if CFGetTypeID(focused) != AXUIElementGetTypeID() {
        CFRelease(focused);
        return None;
    }
    Some(OwnedElement(focused))
}

/// The element's `AXValue` as a string. `None` when the attribute is missing,
/// isn't a string (a slider's number, an AXValue struct), or is too long to be
/// worth watching.
unsafe fn copy_value_string(element: AXUIElementRef) -> Option<String> {
    let value = copy_attribute(element, AX_VALUE)?;
    if CFGetTypeID(value) != CFStringGetTypeID() {
        CFRelease(value);
        return None;
    }
    // wrap_under_create_rule takes ownership of the +1 copy, so it is released
    // when `s` drops — no explicit CFRelease here.
    let s = CFString::wrap_under_create_rule(value as _).to_string();
    watch::within_limit(&s).then_some(s)
}

/// The pid of the app the element belongs to — the identity that decides
/// whether "focus is still where we pasted". Element-ref equality (CFEqual) is
/// NOT usable for that: Chromium-family apps (browsers, Electron) mint a fresh
/// AX wrapper object per query, so ref equality false-negatives on the very
/// apps people dictate into most.
unsafe fn element_pid(element: AXUIElementRef) -> Option<i32> {
    let mut pid: i32 = 0;
    if AXUIElementGetPid(element, &mut pid) != 0 || pid <= 0 {
        return None;
    }
    Some(pid)
}

/// The target app's own AX element (owned).
unsafe fn app_element(pid: i32) -> Option<OwnedElement> {
    let element = AXUIElementCreateApplication(pid);
    if element.is_null() {
        return None;
    }
    Some(OwnedElement(element))
}

/// The element the target APP says has keyboard focus. App-scoped rather than
/// system-wide, because Chromium apps often answer this while the system-wide
/// query comes back empty.
unsafe fn copy_app_focused_element(pid: i32) -> Option<OwnedElement> {
    let app = app_element(pid)?;
    let focused = copy_attribute(app.0, AX_FOCUSED_UI_ELEMENT)?;
    if CFGetTypeID(focused) != AXUIElementGetTypeID() {
        CFRelease(focused);
        return None;
    }
    Some(OwnedElement(focused))
}

/// Flip Electron's manual-accessibility switch on the target app. Best-effort;
/// returns whether the app accepted it, so the observation can switch it back
/// off when it ends.
unsafe fn set_manual_accessibility(pid: i32, on: bool) -> bool {
    let Some(app) = app_element(pid) else {
        return false;
    };
    let name = CFString::new(AX_MANUAL_ACCESSIBILITY);
    let value = CFBoolean::from(on);
    AXUIElementSetAttributeValue(
        app.0,
        name.as_concrete_TypeRef() as *const c_void,
        value.as_CFTypeRef() as CFTypeRef,
    ) == 0
}

/// Focused element + readable value for the target app: system-wide query
/// first (gated to the target pid — the user may have switched apps), then the
/// app-scoped one.
unsafe fn snapshot(pid: i32) -> Option<(OwnedElement, String)> {
    let sys = copy_focused_element().filter(|e| element_pid(e.0) == Some(pid));
    let element = sys.or_else(|| copy_app_focused_element(pid))?;
    let baseline = copy_value_string(element.0)?;
    Some((element, baseline))
}

/// Everything one observation needs, moved onto its polling thread.
struct Armed {
    app: AppHandle,
    element: OwnedElement,
    target_pid: i32,
    baseline: String,
    inserted_text: String,
    generation: u64,
}

pub fn observe(app: AppHandle, inserted_text: String) -> bool {
    // Auto-paste and this share the one permission: without Accessibility
    // there is no AX tree to read, so there is nothing to observe.
    if !crate::voice_typing::is_accessibility_trusted() {
        log::info!("ax_observe: not armed (accessibility not granted)");
        return false;
    }
    let generation = watch::claim_generation();

    // The app we pasted into, from NSWorkspace — deliberately NOT derived from
    // the focused AX element, which is exactly the thing that's absent when an
    // Electron app's tree is still off.
    let Some(target_pid) = crate::voice_typing::frontmost_app_pid() else {
        log::info!("ax_observe: not armed (no frontmost app)");
        return false;
    };

    // Parley's own fields (the Ask box, a meeting's context, Settings) are
    // pasted into like any other app's. But this command runs on the main
    // thread, and the main thread is also where Parley answers AX queries
    // about its own elements: asking from here would wait on itself until the
    // AX messaging timeout, with every window frozen. Arm from a thread of its
    // own; its first look comes a beat later, after the ⌘V has landed.
    if u32::try_from(target_pid).is_ok_and(|pid| pid == std::process::id()) {
        std::thread::spawn(move || {
            arm_with_retries(app, target_pid, inserted_text, generation, false)
        });
        return true;
    }

    // Quick path: the tree is already on (native apps, previously-nudged
    // Electron apps).
    if let Some((element, baseline)) = unsafe { snapshot(target_pid) } {
        log::info!(
            "ax_observe: armed (baseline {} chars, target pid {})",
            baseline.chars().count(),
            target_pid
        );
        let armed = Armed {
            app,
            element,
            target_pid,
            baseline,
            inserted_text,
            generation,
        };
        std::thread::spawn(move || poll(armed, false));
        return true;
    }

    // No focused element: almost always Chromium's lazily-enabled tree. Nudge
    // it on and retry off-thread; the paste just happened, so a few hundred ms
    // of arming delay loses nothing.
    log::info!("ax_observe: no focused element yet — nudging accessibility on pid {target_pid}");
    std::thread::spawn(move || arm_with_retries(app, target_pid, inserted_text, generation, true));
    true
}

/// Off the main thread: wait for a focused element to appear, and observe it.
/// With `nudge`, first switch the target's accessibility tree on (Electron),
/// and back off if nothing ever armed.
fn arm_with_retries(
    app: AppHandle,
    target_pid: i32,
    inserted_text: String,
    generation: u64,
    nudge: bool,
) {
    let nudged = nudge && unsafe { set_manual_accessibility(target_pid, true) };
    let how = if nudge {
        "after nudge"
    } else {
        "off the main thread"
    };
    for _ in 0..ARM_RETRY_TRIES {
        std::thread::sleep(ARM_RETRY_INTERVAL);
        if !watch::is_current(generation) {
            return; // a newer paste owns arming (and the nudge) now
        }
        let Some((element, baseline)) = (unsafe { snapshot(target_pid) }) else {
            continue;
        };
        log::info!(
            "ax_observe: armed {how} (baseline {} chars, target pid {})",
            baseline.chars().count(),
            target_pid
        );
        let armed = Armed {
            app,
            element,
            target_pid,
            baseline,
            inserted_text,
            generation,
        };
        poll(armed, nudged);
        return;
    }
    log::info!("ax_observe: not armed (no focused element {how})");
    if nudged && watch::is_current(generation) {
        unsafe { set_manual_accessibility(target_pid, false) };
    }
}

fn read_tick(element: &OwnedElement, target_pid: i32, generation: u64) -> Tick {
    if !watch::is_current(generation) {
        return Tick::Superseded;
    }
    // The system-wide focus resolving to a DIFFERENT app is a departure;
    // resolving to nothing is normal for Chromium apps and is NOT.
    let focused_pid = unsafe { copy_focused_element().and_then(|e| element_pid(e.0)) };
    if focused_pid.is_some_and(|pid| pid != target_pid) {
        return Tick::FocusAway;
    }
    // Prefer the element we armed on, then the app-scoped focused element:
    // Chromium rebuilds the accessibility node when a contenteditable
    // re-renders — exactly what delete-and-retype does — so the armed ref can
    // go stale at the very moment the correction happens. Both reads are scoped
    // to the target app; nothing else is ever touched.
    let value = unsafe {
        copy_value_string(element.0)
            .or_else(|| copy_app_focused_element(target_pid).and_then(|e| copy_value_string(e.0)))
    };
    value.map_or(Tick::NoValue, Tick::Value)
}

/// Runs the shared polling loop, then — if this observation switched an
/// Electron accessibility tree on — politely switches it back off, unless a
/// newer observation has taken over in the meantime (it may still need the
/// tree).
fn poll(armed: Armed, nudged: bool) {
    let Armed {
        app,
        element,
        target_pid,
        baseline,
        inserted_text,
        generation,
    } = armed;
    watch::run(&app, Watch::new(baseline, inserted_text), || {
        read_tick(&element, target_pid, generation)
    });
    if nudged && watch::is_current(generation) {
        unsafe { set_manual_accessibility(target_pid, false) };
    }
}
