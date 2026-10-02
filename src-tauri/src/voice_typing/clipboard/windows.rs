//! Windows: the Win32 clipboard.
//!
//! The Win32 clipboard is a process-wide lock, not an object: while it is
//! open, no other process on the desktop can copy or paste. So every
//! operation here opens it, does its work and closes it again ([`Open`]
//! closes on every path out), and none of them keeps it across the paste.

use std::iter::once;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
    GetClipboardSequenceNumber, IsClipboardFormatAvailable, OpenClipboard,
    RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};

use super::{is_restorable_format, Pasteboard};

/// `CF_UNICODETEXT`, spelled out rather than imported from
/// `Win32::System::Ole` so one 16-bit constant doesn't drag the whole OLE
/// feature (and its compile time) into the build.
const CF_UNICODETEXT: u32 = 13;

/// `OpenClipboard` does not queue: it fails outright while another process
/// holds the clipboard, and something briefly does all the time (the app
/// the user just copied from, a clipboard manager sampling the change).
/// A dictation ends with a write that MUST land — when the paste is refused
/// the clipboard is the only copy of what the user just said — so a lost race
/// is retried rather than reported.
const CLIPBOARD_OPEN_ATTEMPTS: u32 = 5;
const CLIPBOARD_OPEN_RETRY: std::time::Duration = std::time::Duration::from_millis(20);

/// The registered format clipboard monitors are asked to leave alone. Password
/// managers put their secrets up with it; we put the dictation up with it.
const EXCLUDE_FROM_MONITORS: PCWSTR = w!("ExcludeClipboardContentFromMonitorProcessing");

/// The formats that keep the dictation out of the clipboard history (Win+V)
/// and off the cloud clipboard, each with a DWORD 0; the monitor exclusion
/// above goes up with them, with the same (ignored) data.
const TRANSIENT_MARKERS: [PCWSTR; 3] = [
    EXCLUDE_FROM_MONITORS,
    w!("CanIncludeInClipboardHistory"),
    w!("CanUploadToCloudClipboard"),
];

/// Every format on the clipboard whose data is a memory block, with that
/// block's bytes, in the order the clipboard listed them.
pub type Snapshot = Vec<(u32, Vec<u8>)>;

pub struct SystemPasteboard;

impl Pasteboard for SystemPasteboard {
    type Snapshot = Snapshot;

    /// Best effort by nature: formats that are not memory blocks are skipped
    /// (see `is_restorable_format`), and reading a format the copying app only
    /// promised makes it render that format now.
    fn snapshot(&mut self) -> Result<Snapshot, String> {
        let _open = Open::new()?;
        // Asked before a single byte is read: a password manager's secret is
        // not ours to hold, and putting it back would read as a new copy to
        // the password manager's timed clear.
        let concealed = registered(EXCLUDE_FROM_MONITORS);
        // SAFETY: only asks whether a format is present.
        if concealed != 0 && unsafe { IsClipboardFormatAvailable(concealed) }.is_ok() {
            log::info!(
                "voice-typing: the clipboard is marked private; it is cleared, not restored"
            );
            return Ok(Vec::new());
        }
        let mut saved = Vec::new();
        let mut format = 0;
        loop {
            // SAFETY: the clipboard is open on this thread, which is all
            // enumeration needs. 0 ends the list (or reports an error, which
            // ends it just the same).
            format = unsafe { EnumClipboardFormats(format) };
            if format == 0 {
                break;
            }
            if !is_restorable_format(format) {
                continue;
            }
            // SAFETY: the clipboard is open on this thread and `format` is
            // one it just listed as a memory-block format.
            if let Some(bytes) = unsafe { read_block(format) } {
                saved.push((format, bytes));
            }
        }
        Ok(saved)
    }

    fn write_transient(&mut self, text: &str) -> Result<(), String> {
        let _open = Open::new()?;
        empty()?;
        publish(CF_UNICODETEXT, &utf16_bytes(text))?;
        // Best effort: the paste works without them, they only keep the
        // dictation out of the history.
        let no = 0u32.to_ne_bytes();
        for marker in TRANSIENT_MARKERS {
            let format = registered(marker);
            if format == 0 {
                continue;
            }
            if let Err(e) = publish(format, &no) {
                log::warn!("voice-typing: clipboard history marker not set: {e}");
            }
        }
        Ok(())
    }

    /// Publish `text` on the clipboard as `CF_UNICODETEXT`.
    fn write_plain(&mut self, text: &str) -> Result<(), String> {
        let _open = Open::new()?;
        empty()?;
        publish(CF_UNICODETEXT, &utf16_bytes(text))
    }

    /// `GetClipboardSequenceNumber`: it moves whenever the clipboard is
    /// emptied or written, by anyone.
    fn change_mark(&mut self) -> i64 {
        // SAFETY: reads a counter; needs neither the clipboard nor any state.
        i64::from(unsafe { GetClipboardSequenceNumber() })
    }

    fn restore(&mut self, snapshot: &Snapshot) -> Result<(), String> {
        let _open = Open::new()?;
        empty()?;
        // One format that will not go back must not cost the others.
        for (format, bytes) in snapshot {
            if let Err(e) = publish(*format, bytes) {
                log::warn!("voice-typing: clipboard format {format:#x} not restored: {e}");
            }
        }
        Ok(())
    }
}

/// The open clipboard, closed again when this drops.
struct Open;

impl Open {
    /// Take the clipboard, retrying briefly while another process holds it
    /// (see [`CLIPBOARD_OPEN_ATTEMPTS`]). Passing no owner window is
    /// deliberate: we have no HWND worth associating and want no clipboard
    /// notifications.
    fn new() -> Result<Self, String> {
        let mut last = String::new();
        for attempt in 0..CLIPBOARD_OPEN_ATTEMPTS {
            // SAFETY: takes nothing from us and owns nothing of ours; the
            // only state it changes is the global clipboard lock, released
            // when the returned guard drops.
            match unsafe { OpenClipboard(None) } {
                Ok(()) => return Ok(Self),
                Err(e) => {
                    last = e.to_string();
                    if attempt + 1 < CLIPBOARD_OPEN_ATTEMPTS {
                        std::thread::sleep(CLIPBOARD_OPEN_RETRY);
                    }
                }
            }
        }
        Err(format!("clipboard is held by another process: {last}"))
    }
}

impl Drop for Open {
    fn drop(&mut self) {
        // SAFETY: `Open` exists only while this thread holds the clipboard,
        // and this is its single matching close.
        unsafe {
            let _ = CloseClipboard();
        }
    }
}

/// Empty the open clipboard. It frees only handles the clipboard already
/// owns; ours are published after it.
fn empty() -> Result<(), String> {
    // SAFETY: the caller holds the clipboard open on this thread.
    unsafe { EmptyClipboard() }.map_err(|e| format!("EmptyClipboard failed: {e}"))
}

/// `text` as CF_UNICODETEXT's bytes: a NUL-terminated wide string. Consumers
/// read up to the terminator, not to the allocation's length, so the
/// terminator is part of the payload rather than an afterthought.
fn utf16_bytes(text: &str) -> Vec<u8> {
    text.encode_utf16()
        .chain(once(0))
        .flat_map(u16::to_ne_bytes)
        .collect()
}

/// The id of a registered clipboard format (the same name gives the same id
/// in every process), or 0 when it could not be registered.
fn registered(name: PCWSTR) -> u32 {
    // SAFETY: `name` is a NUL-terminated wide string literal.
    unsafe { RegisterClipboardFormatW(name) }
}

/// The bytes of the open clipboard's `format` block; None when it has none,
/// or when its handle is not a memory block after all.
///
/// # Safety
/// The clipboard must be open on this thread.
unsafe fn read_block(format: u32) -> Option<Vec<u8>> {
    let handle = GetClipboardData(format).ok()?;
    let block = HGLOBAL(handle.0);
    let size = GlobalSize(block);
    if size == 0 {
        return None;
    }
    let src = GlobalLock(block);
    if src.is_null() {
        return None;
    }
    // The clipboard owns the block; it stays valid while the clipboard is
    // open and we hold the lock, and `size` is its whole extent.
    let bytes = std::slice::from_raw_parts(src.cast::<u8>(), size).to_vec();
    // FALSE on success when the lock count reaches zero; nothing to check.
    let _ = GlobalUnlock(block);
    Some(bytes)
}

/// Copy `bytes` into a fresh memory block and put it on the open clipboard
/// as `format`.
///
/// The ownership rule this function exists to get right: on SUCCESS
/// `SetClipboardData` takes the memory block and the OS frees it later, so
/// freeing it here would leave every subsequent paste reading freed memory.
/// On FAILURE the transfer never happened and the block is still ours, so
/// NOT freeing it leaks a global allocation on every dictation.
fn publish(format: u32, bytes: &[u8]) -> Result<(), String> {
    // GMEM_MOVEABLE is required, not preferred: `SetClipboardData` rejects
    // fixed memory, because the OS takes ownership and may relocate it. At
    // least one byte, since a zero-byte block is a discarded one.
    // SAFETY: a plain allocation request; the returned handle is either
    // handed to the OS below or freed on each failure path.
    let hglobal = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)) }
        .map_err(|e| format!("GlobalAlloc failed: {e}"))?;

    // SAFETY: `hglobal` is a live moveable block of at least `bytes.len()`
    // bytes that we just allocated and to which nobody else holds a pointer,
    // so locking it and writing `bytes` into it cannot overlap another object
    // or overrun the allocation.
    unsafe {
        let dst = GlobalLock(hglobal);
        if dst.is_null() {
            let _ = GlobalFree(Some(hglobal));
            return Err("GlobalLock failed".into());
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst.cast::<u8>(), bytes.len());
        // `GlobalUnlock` returns FALSE *on success* when the lock count
        // reaches zero (with a last-error of NO_ERROR), so the `windows`
        // wrapper hands back an Err on the normal path. Nothing to check.
        let _ = GlobalUnlock(hglobal);
    }

    // SAFETY: the caller holds the clipboard open on this thread and
    // `hglobal` is a valid moveable block holding `format`'s data.
    match unsafe { SetClipboardData(format, Some(HANDLE(hglobal.0))) } {
        // Ownership has moved to the OS — do NOT free.
        Ok(_) => Ok(()),
        Err(e) => {
            // The transfer did not happen, so the block is still ours.
            // SAFETY: `SetClipboardData` failed, so the OS did not take
            // `hglobal`, and nothing else holds it. (`GlobalFree` reports
            // success by returning NULL, which the `windows` wrapper maps to
            // Err, so its result is not worth inspecting either.)
            unsafe {
                let _ = GlobalFree(Some(hglobal));
            }
            Err(format!("SetClipboardData failed: {e}"))
        }
    }
}
