//! Windows reads for correction watching, through UI Automation: the focused
//! element's text via `ValuePattern` (plain edits, browser inputs and
//! textareas) or `TextPattern` (rich documents), scoped to the process voice
//! typing pasted into. The polling schedule, diff and stop conditions are in
//! [`super::watch`]; this module only turns each poll into a [`Tick`].
//!
//! Everything UIA runs on a dedicated observer thread, never on the command's
//! (main) thread: UIA calls cross into the target process and can block for as
//! long as that process is busy, and the main thread already belongs to an STA
//! that WebView2 initialised.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;
use windows::core::{Interface, BSTR};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation8, IUIAutomation, IUIAutomation2, IUIAutomationElement, IUIAutomationTextPattern,
    IUIAutomationValuePattern, UIA_TextPatternId, UIA_ValuePatternId,
};

use super::watch::{self, Tick, Watch, MAX_VALUE_CHARS};

/// Upper bound on one cross-process UIA call. The default transaction timeout
/// is 20 s; a hung target app would otherwise freeze the observer that long
/// per tick. A read that times out is just a missed tick.
const UIA_TRANSACTION_TIMEOUT_MS: u32 = 2_000;

/// How often and how long to retry arming. Chromium (browsers, Electron)
/// builds its UIA tree lazily, the first time a UIA client asks — so the very
/// first query can see only the window, not the field inside it.
const ARM_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);
const ARM_RETRY_TRIES: u32 = 8;

/// `TextPattern` reads are capped at one UTF-16 unit past the limit, so a
/// whole Word document is never pulled across every second just to be thrown
/// away. A read that comes back longer than [`MAX_VALUE_CHARS`] units is
/// treated as too long (it may have been truncated).
const TEXT_READ_LIMIT: i32 = MAX_VALUE_CHARS as i32 + 1;

/// Latched the first time COM or UI Automation itself cannot be brought up in
/// this process. That is not a per-field condition — it will not fix itself on
/// the next dictation — so later calls return `false` immediately, and the
/// reason is logged once rather than once per dictation.
static UIA_UNAVAILABLE: AtomicBool = AtomicBool::new(false);

fn note_unavailable(step: &str, error: &windows::core::Error) {
    if !UIA_UNAVAILABLE.swap(true, Ordering::SeqCst) {
        log::debug!(
            "ax_observe: UI Automation unavailable ({step}: {error}); correction learning is off for this session"
        );
    }
}

/// This thread's membership in the COM multithreaded apartment, left on drop.
///
/// MTA rather than STA: the observer only polls — it registers no UIA event
/// handlers and runs no message loop. An STA thread that doesn't pump messages
/// can stall cross-apartment calls, and Microsoft's UIA threading guidance is
/// for clients to work from an MTA thread that owns no UI. MTA needs no pump
/// and gives exactly that.
struct Apartment;

impl Apartment {
    fn enter() -> windows::core::Result<Self> {
        // SAFETY: a fresh thread with no prior COM state; balanced by Drop
        // (S_FALSE, "already initialised", must be balanced too, and is,
        // because `.ok()` treats it as success).
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok()?;
        Ok(Self)
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        // SAFETY: pairs with the successful CoInitializeEx in `enter`. Every
        // COM object is a local declared after the Apartment, so all of them
        // are released before this runs.
        unsafe { CoUninitialize() };
    }
}

/// The UI Automation client for one observation.
struct Uia(IUIAutomation);

impl Uia {
    fn new() -> windows::core::Result<Self> {
        // CUIAutomation8 (Windows 8+; Tauri 2 needs 10) rather than the
        // original CUIAutomation: same interface, plus the hang handling and
        // the IUIAutomation2 timeouts used below.
        // SAFETY: called on a thread inside the MTA (see `Apartment`).
        let automation: IUIAutomation =
            unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }?;
        if let Ok(automation2) = automation.cast::<IUIAutomation2>() {
            // Best effort: the defaults still work, just with a longer worst case.
            // SAFETY: plain setter on a live interface.
            let _ = unsafe { automation2.SetTransactionTimeout(UIA_TRANSACTION_TIMEOUT_MS) };
        }
        Ok(Self(automation))
    }

    /// The system-wide focused element; `None` if the query fails.
    fn focused(&self) -> Option<IUIAutomationElement> {
        // SAFETY: live interface, called on its own apartment's thread.
        unsafe { self.0.GetFocusedElement() }.ok()
    }

    /// Whether two elements are the same UI element (runtime-id equality).
    /// `None` when the comparison itself fails, which is "unknown", not "no".
    fn same_element(&self, a: &IUIAutomationElement, b: &IUIAutomationElement) -> Option<bool> {
        // SAFETY: live interfaces, called on their apartment's thread.
        unsafe { self.0.CompareElements(a, b) }
            .ok()
            .map(|same| same.as_bool())
    }
}

fn process_id(element: &IUIAutomationElement) -> Option<i32> {
    // SAFETY: live interface; a stale element answers with an error.
    unsafe { element.CurrentProcessId() }.ok()
}

/// A UIA string, or `None` when it is longer than the watcher's limit.
/// Measured in UTF-16 units, which is never fewer than chars, so this is at
/// least as strict as the macOS char count.
fn bounded(text: BSTR) -> Option<String> {
    (text.len() <= MAX_VALUE_CHARS).then(|| text.to_string())
}

fn read_value_pattern(element: &IUIAutomationElement) -> Option<String> {
    // SAFETY: live interface; an unsupported pattern answers with an error
    // (or a null pointer, which the binding also turns into an error).
    let pattern: IUIAutomationValuePattern =
        unsafe { element.GetCurrentPatternAs(UIA_ValuePatternId) }.ok()?;
    unsafe { pattern.CurrentValue() }.ok().and_then(bounded)
}

fn read_text_pattern(element: &IUIAutomationElement) -> Option<String> {
    // SAFETY: as above.
    let pattern: IUIAutomationTextPattern =
        unsafe { element.GetCurrentPatternAs(UIA_TextPatternId) }.ok()?;
    let range = unsafe { pattern.DocumentRange() }.ok()?;
    unsafe { range.GetText(TEXT_READ_LIMIT) }
        .ok()
        .and_then(bounded)
}

/// The element's text: `ValuePattern` when it has a non-empty value, else
/// `TextPattern` (rich editors often implement ValuePattern with an empty
/// value and keep the real text behind TextPattern), else whatever
/// ValuePattern said. `None` when the element exposes neither — many Electron
/// widgets — and the observation quietly does not happen.
fn read_text(element: &IUIAutomationElement) -> Option<String> {
    let value = read_value_pattern(element);
    if value.as_deref().is_some_and(|v| !v.is_empty()) {
        return value;
    }
    read_text_pattern(element).or(value)
}

/// Focused element + readable text in the target process, or why not.
fn snapshot(uia: &Uia, target_pid: i32) -> Result<(IUIAutomationElement, String), &'static str> {
    let element = uia.focused().ok_or("no focused element")?;
    if process_id(&element) != Some(target_pid) {
        return Err("focus is not in the app we pasted into");
    }
    let baseline = read_text(&element).ok_or("field exposes no readable Value or Text pattern")?;
    Ok((element, baseline))
}

/// Retry [`snapshot`] briefly (see [`ARM_RETRY_TRIES`]). `None` when nothing
/// armed or a newer dictation took over; the reason is logged once.
fn arm(uia: &Uia, target_pid: i32, generation: u64) -> Option<(IUIAutomationElement, String)> {
    let mut reason = "no attempt";
    for attempt in 0..ARM_RETRY_TRIES {
        if attempt > 0 {
            std::thread::sleep(ARM_RETRY_INTERVAL);
        }
        if !watch::is_current(generation) {
            reason = "superseded by a newer dictation";
            break;
        }
        match snapshot(uia, target_pid) {
            Ok(armed) => return Some(armed),
            Err(why) => reason = why,
        }
    }
    log::info!("ax_observe: not armed ({reason})");
    None
}

/// Whether focus is demonstrably elsewhere: another process, or another
/// element in the target process. A focus query that fails is "unknown" and
/// NOT a departure — same rule as macOS, where Chromium often answers nothing.
fn focus_moved(uia: &Uia, armed: &IUIAutomationElement, target_pid: i32) -> bool {
    let Some(focused) = uia.focused() else {
        return false;
    };
    match process_id(&focused) {
        Some(pid) if pid != target_pid => true,
        Some(_) => uia.same_element(armed, &focused) == Some(false),
        None => false,
    }
}

fn read_tick(uia: &Uia, element: &IUIAutomationElement, target_pid: i32, generation: u64) -> Tick {
    if !watch::is_current(generation) {
        return Tick::Superseded;
    }
    if focus_moved(uia, element, target_pid) {
        return Tick::FocusAway;
    }
    // Only ever the element we armed on. Unlike macOS there is no fallback to
    // "whatever is focused in the app now": a different element is a
    // departure (above), and an armed element that went stale just misses.
    read_text(element).map_or(Tick::NoValue, Tick::Value)
}

/// The whole observation, on its own thread: join the MTA, create the UIA
/// client, arm on the focused field, then hand the ticks to the shared loop.
fn observe_on_thread(app: AppHandle, target_pid: i32, inserted_text: String, generation: u64) {
    let _apartment = match Apartment::enter() {
        Ok(apartment) => apartment,
        Err(error) => return note_unavailable("CoInitializeEx", &error),
    };
    let uia = match Uia::new() {
        Ok(uia) => uia,
        Err(error) => return note_unavailable("CoCreateInstance(CUIAutomation8)", &error),
    };
    let Some((element, baseline)) = arm(&uia, target_pid, generation) else {
        return;
    };
    log::info!(
        "ax_observe: armed via UI Automation (baseline {} chars, target pid {})",
        baseline.chars().count(),
        target_pid
    );
    watch::run(&app, Watch::new(baseline, inserted_text), || {
        read_tick(&uia, &element, target_pid, generation)
    });
}

/// Returns `true` once the observer thread is running. Arming itself happens
/// on that thread — UIA must stay off the main thread — so, like the macOS
/// Electron path, `true` means "watching if the field turns out readable";
/// a field that isn't just logs why and emits nothing.
pub fn observe(app: AppHandle, inserted_text: String) -> bool {
    if UIA_UNAVAILABLE.load(Ordering::SeqCst) {
        return false;
    }
    let generation = watch::claim_generation();
    // The process we pasted into — the foreground window's owner, sampled now
    // so a focus change during arming is caught rather than followed.
    let Some(target_pid) = crate::voice_typing::frontmost_app_pid() else {
        log::info!("ax_observe: not armed (no foreground window)");
        return false;
    };
    let spawned = std::thread::Builder::new()
        .name("ax-observe".into())
        .spawn(move || observe_on_thread(app, target_pid, inserted_text, generation));
    if let Err(error) = spawned {
        log::debug!("ax_observe: observer thread did not start ({error})");
        return false;
    }
    true
}
