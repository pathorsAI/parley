//! Windows: the Win32 clipboard.
//!
//! The Win32 clipboard is a process-wide lock, not an object: while it is
//! open, no other process on the desktop can copy or paste. So every
//! operation here opens it, does its work and closes it again ([`Open`]
//! closes on every path out), and none of them keeps it across the paste.
//! For the same reason none of it runs on the main thread: the insert and
//! copy commands hand it to a blocking worker, like the restore timer, so an
//! app slow to render what it copied stalls that worker, not every window.
//!
//! A snapshot reads only what a paste elsewhere uses (`is_saved_format`), so
//! a restore after an OLE copy (Office, most apps built on WPF or WinForms)
//! brings back its static formats — text, rich text, HTML, a picture — and
//! not the live object.

use std::iter::once;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
    GetClipboardFormatNameW, GetClipboardSequenceNumber, OpenClipboard, RegisterClipboardFormatW,
    SetClipboardData,
};
use windows::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};

use super::{
    plan_snapshot, Pasteboard, SavedAndWritten, SnapshotBudget, SnapshotPlan, CF_UNICODETEXT,
    EXCLUDE_FROM_MONITORS, PARLEY_TRANSIENT,
};

/// `OpenClipboard` does not queue: it fails outright while another process
/// holds the clipboard, and something briefly does all the time (the app
/// the user just copied from, a clipboard manager sampling the change).
/// A dictation ends with a write that MUST land — when the paste is refused
/// the clipboard is the only copy of what the user just said — so a lost race
/// is retried rather than reported.
const CLIPBOARD_OPEN_ATTEMPTS: u32 = 5;
const CLIPBOARD_OPEN_RETRY: std::time::Duration = std::time::Duration::from_millis(20);

/// The formats that keep the dictation out of the clipboard history (Win+V)
/// and off the cloud clipboard, each with a DWORD 0; the monitor exclusion
/// goes up with them, with the same (ignored) data, and our own marker first,
/// so that the exclusion is never there without it.
const TRANSIENT_MARKERS: [&str; 4] = [
    PARLEY_TRANSIENT,
    EXCLUDE_FROM_MONITORS,
    "CanIncludeInClipboardHistory",
    "CanUploadToCloudClipboard",
];

/// What a snapshot saved.
#[derive(Default)]
pub struct Snapshot {
    /// The formats read, each with its memory block's bytes, in the order
    /// the clipboard listed them.
    formats: Vec<(u32, Vec<u8>)>,
    /// It is a dictation Parley left on the clipboard (a restore that failed,
    /// a clipboard too slow to save). Every restore goes back up with
    /// TRANSIENT_MARKERS now; this one would even with nothing else to put
    /// back.
    transient: bool,
}

pub struct SystemPasteboard;

impl Pasteboard for SystemPasteboard {
    type Snapshot = Snapshot;

    /// Best effort by nature: only the formats `is_saved_format` names are
    /// read, and reading one the copying app only promised makes it render
    /// that format now — with the clipboard open, so no other app can copy or
    /// paste meanwhile. Hence the [`SnapshotBudget`]: it cannot cut a read
    /// short, but it stops the reads after one that took too long.
    fn snapshot(&mut self) -> Result<Snapshot, String> {
        let _open = Open::new()?;
        snapshot_open()
    }

    fn write_transient(&mut self, text: &str) -> Result<(), String> {
        let _open = Open::new()?;
        write_transient_open(text)
    }

    /// Under ONE hold of the clipboard: between two opens another process
    /// could copy, and the write would then replace that copy, which the
    /// restore never gives back (it saved the clipboard from before it).
    fn save_and_write_transient(&mut self, save: bool, text: &str) -> SavedAndWritten<Snapshot> {
        let _open = match Open::new() {
            Ok(open) => open,
            Err(e) => return (save.then(|| Err(e.clone())), Err(e)),
        };
        let saved = save.then(snapshot_open);
        (saved, write_transient_open(text))
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

    /// The sequence number is compared with the clipboard open: from then
    /// on no other process can empty or write it, so a copy that raced the
    /// open (while `Open::new` waited out whoever held it) has already moved
    /// the number, and nothing can move it between the check and our write.
    fn restore_if_unchanged(&mut self, snapshot: &Snapshot, mark: i64) -> Result<bool, String> {
        let _open = Open::new()?;
        if self.change_mark() != mark {
            return Ok(false);
        }
        empty()?;
        // One format that will not go back must not cost the others.
        for (format, bytes) in &snapshot.formats {
            if let Err(e) = publish(*format, bytes) {
                log::warn!("voice-typing: clipboard format {format:#x} not restored: {e}");
            }
        }
        // What goes back is what the user copied before: Win+V's history and
        // the cloud clipboard already have it from then, and clipboard
        // monitors already saw it. Unmarked, the restore read as a fresh copy
        // and listed it again after every dictation. (Our own marker goes up
        // too, so the next snapshot does not take the exclusion for a
        // password manager's.) An empty snapshot is a cleared clipboard.
        if snapshot.transient || !snapshot.formats.is_empty() {
            publish_markers();
        }
        Ok(true)
    }
}

/// [`SystemPasteboard::snapshot`]'s work, with the clipboard already open on
/// this thread.
fn snapshot_open() -> Result<Snapshot, String> {
    // Planned from the formats' ids and names, before a single byte is
    // read: a password manager's secret is not ours to hold.
    let listed = listed_formats();
    let (formats, transient) =
        match plan_snapshot(listed.iter().map(|(f, name)| (*f, name.as_deref()))) {
            SnapshotPlan::Concealed => {
                log::info!(
                    "voice-typing: the clipboard is marked private; it is cleared, not restored"
                );
                return Ok(Snapshot::default());
            }
            SnapshotPlan::Read { formats, transient } => (formats, transient),
        };
    let mut budget = SnapshotBudget::start();
    let mut saved = Vec::with_capacity(formats.len());
    for format in formats {
        budget.before_read()?;
        // SAFETY: the clipboard is open on this thread and `format` is
        // one it just listed as a memory-block format.
        if let Some(bytes) = unsafe { read_block(format, &mut budget) }? {
            saved.push((format, bytes));
        }
    }
    Ok(Snapshot {
        formats: saved,
        transient,
    })
}

/// Write `text` as the transient dictation, with the clipboard already open
/// on this thread.
fn write_transient_open(text: &str) -> Result<(), String> {
    empty()?;
    publish(CF_UNICODETEXT, &utf16_bytes(text))?;
    publish_markers();
    Ok(())
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

/// Put TRANSIENT_MARKERS up next to a dictation on the open clipboard, each
/// with a DWORD 0. Best effort: the paste works without them, they only keep
/// the dictation out of the history — but ours goes first, and when it does
/// not go up the exclusion does not either: without ours, it would make the
/// dictation look like a password to the next snapshot.
fn publish_markers() {
    let no = 0u32.to_ne_bytes();
    for marker in TRANSIENT_MARKERS {
        let set = match registered(marker) {
            0 => Err("the format could not be registered".to_string()),
            format => publish(format, &no),
        };
        if let Err(e) = set {
            log::warn!("voice-typing: clipboard marker {marker} not set: {e}");
            if marker == PARLEY_TRANSIENT {
                break;
            }
        }
    }
}

/// The id of a registered clipboard format (the same name gives the same id
/// in every process), or 0 when it could not be registered.
fn registered(name: &str) -> u32 {
    let wide: Vec<u16> = name.encode_utf16().chain(once(0)).collect();
    // SAFETY: `wide` is a NUL-terminated wide string that outlives the call.
    unsafe { RegisterClipboardFormatW(PCWSTR(wide.as_ptr())) }
}

/// Every format on the open clipboard, in the order it lists them, each with
/// its name when it is a registered one. Reads no data, so it costs the
/// owner nothing.
fn listed_formats() -> Vec<(u32, Option<String>)> {
    let mut listed = Vec::new();
    let mut format = 0;
    loop {
        // SAFETY: the caller holds the clipboard open on this thread, which
        // is all enumeration needs. 0 ends the list (or reports an error,
        // which ends it just the same).
        format = unsafe { EnumClipboardFormats(format) };
        if format == 0 {
            return listed;
        }
        listed.push((format, format_name(format)));
    }
}

/// A registered format's name. The predefined formats (below 0xC000) have
/// none.
fn format_name(format: u32) -> Option<String> {
    if format < 0xC000 {
        return None;
    }
    let mut name = [0u16; 256];
    // SAFETY: writes at most `name.len()` wide characters into `name`, which
    // the wrapper passes along with its length.
    let len = unsafe { GetClipboardFormatNameW(format, &mut name) };
    let len = usize::try_from(len).ok().filter(|&len| len > 0)?;
    Some(String::from_utf16_lossy(&name[..len]))
}

/// The bytes of the open clipboard's `format` block, counted against
/// `budget` before they are copied; None when it has none, or when its
/// handle is not a memory block after all.
///
/// # Safety
/// The clipboard must be open on this thread.
unsafe fn read_block(format: u32, budget: &mut SnapshotBudget) -> Result<Option<Vec<u8>>, String> {
    let Ok(handle) = GetClipboardData(format) else {
        return Ok(None);
    };
    let block = HGLOBAL(handle.0);
    let size = GlobalSize(block);
    if size == 0 {
        return Ok(None);
    }
    budget.take(size)?;
    let src = GlobalLock(block);
    if src.is_null() {
        return Ok(None);
    }
    // The clipboard owns the block; it stays valid while the clipboard is
    // open and we hold the lock, and `size` is its whole extent.
    let bytes = std::slice::from_raw_parts(src.cast::<u8>(), size).to_vec();
    // FALSE on success when the lock count reaches zero; nothing to check.
    let _ = GlobalUnlock(block);
    Ok(Some(bytes))
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
