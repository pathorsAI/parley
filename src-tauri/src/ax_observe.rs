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
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: CFTypeRef);
        fn CFEqual(a: CFTypeRef, b: CFTypeRef) -> bool;
        fn CFGetTypeID(cf: CFTypeRef) -> usize;
        fn CFStringGetTypeID() -> usize;
    }

    /// AX attribute names. Passed as plain CFStrings rather than linking the
    /// `kAX*Attribute` globals — same shortcut voice_typing.rs takes for the
    /// pasteboard UTI, and it keeps the extern block to the functions.
    const AX_FOCUSED_UI_ELEMENT: &str = "AXFocusedUIElement";
    const AX_VALUE: &str = "AXValue";

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

    pub fn observe(app: AppHandle, inserted_text: String) -> bool {
        // Auto-paste and this share the one permission: without Accessibility
        // there is no AX tree to read, so there is nothing to observe.
        if !crate::voice_typing::is_accessibility_trusted() {
            return false;
        }
        // Claim the newest generation before anything else. Even if this call
        // can't arm an observation, it means a fresh paste happened — any older
        // watcher is now stale and should stop rather than report on it.
        let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

        let (element, baseline) = unsafe {
            let Some(element) = copy_focused_element() else {
                return false;
            };
            let Some(baseline) = copy_value_string(element.0) else {
                return false;
            };
            (element, baseline)
        };

        std::thread::spawn(move || poll(app, element, baseline, inserted_text, generation));
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

    fn poll(
        app: AppHandle,
        element: OwnedElement,
        mut baseline: String,
        inserted_text: String,
        generation: u64,
    ) {
        let ticks = MAX_OBSERVATION.as_secs() / POLL_INTERVAL.as_secs();
        // The changed value we are waiting to see hold still, and for how many
        // consecutive ticks it has held.
        let mut candidate: Option<String> = None;
        let mut stable_ticks: u32 = 0;

        for _ in 0..ticks {
            std::thread::sleep(POLL_INTERVAL);
            // A newer paste owns the field now — stop without a word.
            if GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            // Focus must still be on the very element we pasted into. Comparing
            // the AX refs (rather than, say, the app) is what keeps us from
            // reporting on a different field that happens to look edited.
            let still_focused = unsafe {
                match copy_focused_element() {
                    Some(current) => CFEqual(current.0, element.0),
                    None => false,
                }
            };
            if !still_focused {
                return;
            }
            let Some(current) = (unsafe { copy_value_string(element.0) }) else {
                // Unreadable now (element went away, value stopped being a
                // string, grew past the cap) — give up silently.
                return;
            };

            if current == baseline {
                // Back to what we pasted: whatever edit was in flight was undone.
                candidate = None;
                stable_ticks = 0;
                continue;
            }
            match &candidate {
                Some(previous) if *previous == current => {
                    stable_ticks += 1;
                    if stable_ticks >= SETTLED_TICKS {
                        // The baseline is snapshotted right after the ⌘V is
                        // POSTED, not after the target app has PROCESSED it. If
                        // the app was slow, the paste itself shows up here as
                        // "the field changed" — adopt it as the real baseline
                        // and keep watching for the actual correction instead
                        // of spending our one event on it.
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
                }
                // First sighting of this value (or it changed again): restart
                // the settle count with this reading as tick one.
                _ => {
                    candidate = Some(current);
                    stable_ticks = 1;
                }
            }
        }
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
