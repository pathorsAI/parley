//! Watch the text field that voice typing just pasted into, and notice when the
//! user immediately fixes what the transcriber got wrong.
//!
//! The premise of the phrase dictionary is that a correction made seconds after
//! a dictation is a free, high-quality label: whatever the user retyped is what
//! they wanted the STT to produce. Catching it needs no keylogging — the
//! Accessibility API can read the focused element's `AXValue`, so we snapshot it
//! right after the paste and poll it for a minute. If the value settles on
//! something other than the snapshot while focus stays put, we emit ONE
//! `voicetyping://correction-candidate` and stop; the frontend diffs baseline vs
//! current against the inserted text and decides whether to offer a phrase.
//!
//! Deliberately conservative — a false positive costs the user a dismissal, so
//! every ambiguous case (focus moved, value unreadable, absurdly long field,
//! a newer dictation started) ends the observation SILENTLY rather than guessing.

// The `objc` 0.2 macros emit `cfg(cargo-clippy)` checks newer compilers warn on.
#![allow(unexpected_cfgs)]

use tauri::AppHandle;

/// Event carrying a possible correction to the frontend. Emitted at most once
/// per [`observe_pasted_field`] call, to every window (the voice-typing overlay
/// is the one that listens).
pub const CORRECTION_CANDIDATE_EVENT: &str = "voicetyping://correction-candidate";

/// Start watching the field voice typing just pasted `inserted_text` into.
///
/// Returns whether an observation was actually armed: `false` when
/// Accessibility isn't granted, when there is no focused element, or when its
/// value can't be read as a reasonable string. Returning `true` promises only
/// that we are watching — most observations legitimately end with no event,
/// because most dictations are not corrected.
///
/// Non-blocking: the polling lives on a background thread, and a later call
/// supersedes an earlier one.
#[tauri::command]
pub fn observe_pasted_field(app: AppHandle, inserted_text: String) -> bool {
    imp::observe(app, inserted_text)
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicU64, Ordering};

    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::string::CFString;
    use serde_json::json;
    use tauri::{AppHandle, Emitter};

    use super::CORRECTION_CANDIDATE_EVENT;

    /// How often the focused field is re-read.
    const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);
    /// Total observation window. A correction that arrives later than this is
    /// no longer plausibly "about" the dictation that just happened.
    const MAX_OBSERVATION: std::time::Duration = std::time::Duration::from_secs(60);
    /// Consecutive identical reads before a changed value counts as settled —
    /// so mid-typing snapshots ("Parle", "Parl") don't fire a candidate.
    const SETTLED_TICKS: u32 = 2;
    /// Consecutive failed reads tolerated before giving up. AX queries fail
    /// transiently (kAXErrorCannotComplete) while the target app is busy; one
    /// hiccup must not end a legitimate observation.
    const MAX_MISSES: u32 = 3;
    /// Values longer than this are not worth diffing (a whole document, a code
    /// editor's buffer): reading them every second is wasteful and the diff
    /// would be meaningless. Counted in CHARS, not bytes.
    const MAX_VALUE_CHARS: usize = 32768;

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
    /// "no focused element" is what that looks like from outside. Setting this
    /// on the APP element asks it to turn the tree on; non-Electron apps answer
    /// with an AX error we ignore.
    const AX_MANUAL_ACCESSIBILITY: &str = "AXManualAccessibility";

    /// How often and how long to retry arming after the nudge — Chromium needs
    /// a beat to build the tree once asked.
    const ARM_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);
    const ARM_RETRY_TRIES: u32 = 12;

    /// Bumped by every call; a running observation compares against it and exits
    /// the moment it is no longer the newest. That makes back-to-back dictations
    /// safe: only the latest paste is ever being watched, so an older thread
    /// can't emit a candidate about a field the user has already moved on from.
    static GENERATION: AtomicU64 = AtomicU64::new(0);

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

    /// The system-wide focused UI element, or `None` if nothing is focused (or
    /// the focused thing isn't an AXUIElement).
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

    /// The element's `AXValue` as a string. `None` when the attribute is
    /// missing, isn't a string (a slider's number, an AXValue struct), or is
    /// longer than [`MAX_VALUE_CHARS`].
    unsafe fn copy_value_string(element: AXUIElementRef) -> Option<String> {
        let value = copy_attribute(element, AX_VALUE)?;
        if CFGetTypeID(value) != CFStringGetTypeID() {
            CFRelease(value);
            return None;
        }
        // wrap_under_create_rule takes ownership of the +1 copy, so it is
        // released when `s` drops — no explicit CFRelease here.
        let s = CFString::wrap_under_create_rule(value as _).to_string();
        if s.chars().count() > MAX_VALUE_CHARS {
            return None;
        }
        Some(s)
    }

    /// The pid of the app the element belongs to — the identity that decides
    /// whether "focus is still where we pasted". Element-ref equality (CFEqual)
    /// is NOT usable for that: Chromium-family apps (browsers, Electron) mint a
    /// fresh AX wrapper object per query, so ref equality false-negatives on
    /// the very apps people dictate into most.
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

    /// The element the target APP says has keyboard focus. App-scoped rather
    /// than system-wide, because Chromium apps often answer this while the
    /// system-wide query comes back empty.
    unsafe fn copy_app_focused_element(pid: i32) -> Option<OwnedElement> {
        let app = app_element(pid)?;
        let focused = copy_attribute(app.0, AX_FOCUSED_UI_ELEMENT)?;
        if CFGetTypeID(focused) != AXUIElementGetTypeID() {
            CFRelease(focused);
            return None;
        }
        Some(OwnedElement(focused))
    }

    /// Flip Electron's manual-accessibility switch on the target app.
    /// Best-effort; returns whether the app accepted it, so the observation
    /// can switch it back off when it ends.
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
    /// first (gated to the target pid — the user may have switched apps), then
    /// the app-scoped one.
    unsafe fn snapshot(pid: i32) -> Option<(OwnedElement, String)> {
        let sys = copy_focused_element().filter(|e| element_pid(e.0) == Some(pid));
        let element = sys.or_else(|| copy_app_focused_element(pid))?;
        let baseline = copy_value_string(element.0)?;
        Some((element, baseline))
    }

    pub fn observe(app: AppHandle, inserted_text: String) -> bool {
        // Auto-paste and this share the one permission: without Accessibility
        // there is no AX tree to read, so there is nothing to observe.
        if !crate::voice_typing::is_accessibility_trusted() {
            log::info!("ax_observe: not armed (accessibility not granted)");
            return false;
        }
        // Claim the newest generation before anything else. Even if this call
        // can't arm an observation, it means a fresh paste happened — any older
        // watcher is now stale and should stop rather than report on it.
        let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

        // The app we pasted into, from NSWorkspace — deliberately NOT derived
        // from the focused AX element, which is exactly the thing that's absent
        // when an Electron app's tree is still off.
        let Some(target_pid) = crate::voice_typing::frontmost_app_pid() else {
            log::info!("ax_observe: not armed (no frontmost app)");
            return false;
        };

        // Quick path: the tree is already on (native apps, previously-nudged
        // Electron apps).
        if let Some((element, baseline)) = unsafe { snapshot(target_pid) } {
            log::info!(
                "ax_observe: armed (baseline {} chars, target pid {})",
                baseline.chars().count(),
                target_pid
            );
            std::thread::spawn(move || {
                poll(
                    app,
                    element,
                    target_pid,
                    baseline,
                    inserted_text,
                    generation,
                    false,
                )
            });
            return true;
        }

        // No focused element: almost always Chromium's lazily-enabled tree.
        // Nudge it on and retry off-thread; the paste just happened, so a few
        // hundred ms of arming delay loses nothing.
        log::info!(
            "ax_observe: no focused element yet — nudging accessibility on pid {target_pid}"
        );
        std::thread::spawn(move || {
            let nudged = unsafe { set_manual_accessibility(target_pid, true) };
            for _ in 0..ARM_RETRY_TRIES {
                std::thread::sleep(ARM_RETRY_INTERVAL);
                if GENERATION.load(Ordering::SeqCst) != generation {
                    return; // a newer paste owns arming (and the nudge) now
                }
                if let Some((element, baseline)) = unsafe { snapshot(target_pid) } {
                    log::info!(
                        "ax_observe: armed after nudge (baseline {} chars, target pid {})",
                        baseline.chars().count(),
                        target_pid
                    );
                    poll(
                        app,
                        element,
                        target_pid,
                        baseline,
                        inserted_text,
                        generation,
                        nudged,
                    );
                    return;
                }
            }
            log::info!("ax_observe: not armed (no focused element after nudge)");
            if nudged && GENERATION.load(Ordering::SeqCst) == generation {
                unsafe { set_manual_accessibility(target_pid, false) };
            }
        });
        true
    }

    /// Poll the field until it settles on a changed value, focus leaves, the
    /// window expires, or a newer dictation supersedes us. Emits at most one
    /// event and then returns.
    /// Whether `current` is just `baseline` with `inserted` spliced in once —
    /// i.e. the paste finally landing, not a user edit.
    fn is_paste_landing(baseline: &str, current: &str, inserted: &str) -> bool {
        if inserted.is_empty() || current.len() != baseline.len() + inserted.len() {
            return false;
        }
        current.match_indices(inserted).any(|(i, _)| {
            let (head, rest) = current.split_at(i);
            let tail = &rest[inserted.len()..];
            head.len() + tail.len() == baseline.len()
                && baseline.starts_with(head)
                && baseline.ends_with(tail)
        })
    }

    /// What one polling tick saw.
    enum Tick {
        /// A readable value for the watched field.
        Value(String),
        /// Nothing readable this tick — transient AX failure or a stale ref.
        NoValue,
        /// The system-wide focus resolves to a DIFFERENT app. (Resolving to
        /// nothing is normal for Chromium apps and is NOT a departure signal.)
        FocusAway,
        /// A newer dictation owns the field now.
        Superseded,
    }

    fn read_tick(element: &OwnedElement, target_pid: i32, generation: u64) -> Tick {
        if GENERATION.load(Ordering::SeqCst) != generation {
            return Tick::Superseded;
        }
        if let Some(pid) = unsafe { copy_focused_element().and_then(|e| element_pid(e.0)) } {
            if pid != target_pid {
                return Tick::FocusAway;
            }
        }
        // Prefer the element we armed on, then the app-scoped focused element:
        // Chromium rebuilds the accessibility node when a contenteditable
        // re-renders — exactly what delete-and-retype does — so the armed ref
        // can go stale at the very moment the correction happens. Both reads
        // are scoped to the target app; nothing else is ever touched.
        let value = unsafe {
            copy_value_string(element.0).or_else(|| {
                copy_app_focused_element(target_pid).and_then(|e| copy_value_string(e.0))
            })
        };
        match value {
            Some(v) => Tick::Value(v),
            None => Tick::NoValue,
        }
    }

    /// Runs the tick loop, then — if this observation switched an Electron
    /// accessibility tree on — politely switches it back off, unless a newer
    /// observation has taken over in the meantime (it may still need the tree).
    #[allow(clippy::too_many_arguments)]
    fn poll(
        app: AppHandle,
        element: OwnedElement,
        target_pid: i32,
        baseline: String,
        inserted_text: String,
        generation: u64,
        nudged: bool,
    ) {
        poll_loop(
            app,
            element,
            target_pid,
            baseline,
            inserted_text,
            generation,
        );
        if nudged && GENERATION.load(Ordering::SeqCst) == generation {
            unsafe { set_manual_accessibility(target_pid, false) };
        }
    }

    fn poll_loop(
        app: AppHandle,
        element: OwnedElement,
        target_pid: i32,
        mut baseline: String,
        inserted_text: String,
        generation: u64,
    ) {
        let ticks = MAX_OBSERVATION.as_secs() / POLL_INTERVAL.as_secs();
        // The changed value we are waiting to see hold still, and for how many
        // consecutive ticks it has held.
        let mut candidate: Option<String> = None;
        let mut stable_ticks: u32 = 0;
        // Consecutive unreadable ticks / consecutive ticks focused on another
        // app. Counted separately: a glance at another window shouldn't spend
        // the budget that tolerates a busy target app, and vice versa.
        let mut misses: u32 = 0;
        let mut away: u32 = 0;

        for _ in 0..ticks {
            std::thread::sleep(POLL_INTERVAL);
            let current = match read_tick(&element, target_pid, generation) {
                Tick::Superseded => {
                    log::info!("ax_observe: stopped (superseded by a newer dictation)");
                    return;
                }
                Tick::FocusAway => {
                    away += 1;
                    if away > MAX_MISSES {
                        log::info!("ax_observe: stopped (focus left the app)");
                        return;
                    }
                    continue;
                }
                Tick::NoValue => {
                    misses += 1;
                    if misses > MAX_MISSES {
                        log::info!(
                            "ax_observe: stopped (no readable value for {misses} ticks — the field went stale or away)"
                        );
                        return;
                    }
                    continue;
                }
                Tick::Value(current) => current,
            };
            misses = 0;
            away = 0;

            if current == baseline {
                // Back to what we pasted: whatever edit was in flight was undone.
                candidate = None;
                stable_ticks = 0;
                continue;
            }
            // First sighting of this value (or it changed again): restart the
            // settle count with this reading as tick one.
            if candidate.as_deref() != Some(current.as_str()) {
                candidate = Some(current);
                stable_ticks = 1;
                continue;
            }
            stable_ticks += 1;
            if stable_ticks < SETTLED_TICKS {
                continue;
            }
            // The baseline is snapshotted right after the ⌘V is POSTED, not
            // after the target app has PROCESSED it. If the app was slow, the
            // paste itself shows up here as "the field changed" — adopt it as
            // the real baseline and keep watching for the actual correction
            // instead of spending our one event on it.
            if is_paste_landing(&baseline, &current, &inserted_text) {
                baseline = current;
                candidate = None;
                stable_ticks = 0;
                continue;
            }
            log::info!(
                "ax_observe: correction candidate (baseline {} chars, current {} chars)",
                baseline.chars().count(),
                current.chars().count()
            );
            let _ = app.emit(
                CORRECTION_CANDIDATE_EVENT,
                json!({
                    "baseline": baseline,
                    "current": current,
                    "insertedText": inserted_text,
                }),
            );
            return;
        }
        log::info!("ax_observe: window expired with no correction");
    }

    #[cfg(test)]
    mod tests {
        use super::is_paste_landing;

        #[test]
        fn paste_landing_detected_at_any_position() {
            assert!(is_paste_landing("", "hello", "hello"));
            assert!(is_paste_landing("a b", "a XY b", " XY"));
            assert!(is_paste_landing("前後", "前中後", "中"));
        }

        #[test]
        fn edits_are_not_paste_landings() {
            // Replacement, not insertion.
            assert!(!is_paste_landing("a 派勒 b", "a Parley b", "Parley"));
            // Insertion of something other than the pasted text.
            assert!(!is_paste_landing("ab", "aXb", "Y"));
            // Same length delta but content doesn't splice back to baseline.
            assert!(!is_paste_landing("abc", "abcX", "Y"));
            assert!(!is_paste_landing("abc", "aXbc", "X!"));
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use tauri::AppHandle;

    /// No Accessibility API outside macOS — voice typing itself is macOS-only,
    /// so there is nothing to observe here.
    pub fn observe(_app: AppHandle, _inserted_text: String) -> bool {
        false
    }
}
