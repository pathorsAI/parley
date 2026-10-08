//! Voice typing's clipboard round trip.
//!
//! A dictation reaches the focused field the way a person's paste does — on
//! the clipboard, then the paste chord — because that is the one insertion
//! every app accepts. But the clipboard belongs to the user, not to us: every
//! dictation used to leave its text there for good, so whatever they had
//! copied before (a link, an image, the snippet they were about to paste) was
//! gone, and copy → dictate → paste gave them their own sentence back.
//!
//! So an insert now borrows the clipboard: it saves what is on it, writes the
//! dictated text marked transient (clipboard managers and the OS history skip
//! it), posts the paste, and CLIPBOARD_RESTORE_DELAY later puts the saved
//! contents back — unless anything else has written to the clipboard since,
//! in which case that newer content is the user's and is left alone. Saving
//! has a budget (SNAPSHOT_TIME_BUDGET, SNAPSHOT_BYTE_BUDGET): a clipboard too
//! slow or too large to save is not borrowed, the paste goes out anyway, and
//! the dictation stays on the clipboard as it always used to.
//!
//! When no paste can be posted (macOS without Accessibility, Windows refusing
//! the injection) or none would land (Windows' hidden tray window in front,
//! see [`paste_block`]) the clipboard IS the delivery: the text goes there as
//! an ordinary copy and stays, and the overlay names the paste key. Explicit
//! copies (the overlay's Copy, Esc's Undo) are never restored over. Nor is a
//! paste into a remote-desktop or virtual-machine window
//! ([`reads_clipboard_late`]): those read the clipboard whenever their sync
//! gets to it, so the dictation goes up as an ordinary copy and stays.
//!
//! Split like ax_observe: the bookkeeping here is platform-neutral and tested
//! against a fake clipboard; `macos` and `windows` only read and write the
//! system one.

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub(super) use self::macos::SystemPasteboard;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub(super) use self::windows::SystemPasteboard;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(super) use self::other::SystemPasteboard;

/// How long after the paste chord the clipboard is put back.
///
/// The target app reads the clipboard when it HANDLES the ⌘V / Ctrl+V, not
/// when we post it: the key event queues behind whatever that app is busy
/// with, and Electron and Chromium apps hand the read to another process on
/// top of that. A restore that lands first makes the paste insert the user's
/// OLD clipboard into their document — far worse than a late restore, whose
/// only cost is that a paste of their own inside this window still gets the
/// dictation. A second covers a busy app with room to spare and is over
/// before most people would paste again; half a second more covers an app
/// that is slower still to get to the paste.
const CLIPBOARD_RESTORE_DELAY: Duration = Duration::from_millis(1500);

/// The waits before trying a failed restore again. A restore fails when the
/// clipboard cannot be taken — on Windows, another process holding it open
/// past `Open::new`'s own short retries — and that is usually over in a
/// moment; giving up at once would cost the user what they had copied. Each
/// attempt checks the change mark again, so a copy made meanwhile still wins.
const RESTORE_RETRY_BACKOFF: [Duration; 3] = [
    Duration::from_millis(250),
    Duration::from_millis(500),
    Duration::from_millis(1000),
];

/// A snapshot slower than this is logged: on both platforms reading a format
/// can make the app that copied it render that format on the spot.
const SLOW_SNAPSHOT: Duration = Duration::from_millis(50);

/// How long saving the clipboard may take before an insert gives up on it.
/// Reading a format the copying app only promised makes that app render it
/// now — an Excel range as a PDF and a bitmap of the cells, an image at full
/// resolution, an iPhone's copy fetched over the air — and the paste waits
/// for every read. Past this the dictation is pasted without the borrow.
#[cfg(any(target_os = "macos", target_os = "windows", test))]
const SNAPSHOT_TIME_BUDGET: Duration = Duration::from_millis(150);

/// How much clipboard data an insert holds on to until the restore; a larger
/// clipboard is not saved either.
#[cfg(any(target_os = "macos", target_os = "windows", test))]
const SNAPSHOT_BYTE_BUDGET: usize = 64 << 20;

/// What [`Pasteboard::save_and_write_transient`] did: the snapshot, when one
/// was asked for, and the write.
pub(super) type SavedAndWritten<S> = (Option<Result<S, String>>, Result<(), String>);

/// The clipboard operations an insert needs: the system clipboard on each
/// platform, a fake in the tests.
pub(super) trait Pasteboard {
    /// Everything on the clipboard, as faithfully as the platform allows.
    type Snapshot;

    /// Save what is on the clipboard now. Empty when there is nothing to save
    /// — or nothing we should (a password manager's concealed entry). Err
    /// when it cannot be read, or not within a [`SnapshotBudget`].
    fn snapshot(&mut self) -> Result<Self::Snapshot, String>;

    /// Replace the clipboard with `text`, marked so clipboard managers and
    /// the OS clipboard history skip it: it is only there for the paste.
    fn write_transient(&mut self, text: &str) -> Result<(), String>;

    /// [`snapshot`](Self::snapshot) (when `save`), then
    /// [`write_transient`](Self::write_transient), whatever the snapshot
    /// came to. A platform whose clipboard is a lock (Windows) does both under
    /// one hold of it, so no other process can copy between the save and the
    /// write — a copy that landed there would be overwritten and never come
    /// back.
    fn save_and_write_transient(
        &mut self,
        save: bool,
        text: &str,
    ) -> SavedAndWritten<Self::Snapshot> {
        let saved = save.then(|| self.snapshot());
        (saved, self.write_transient(text))
    }

    /// Replace the clipboard with `text` as an ordinary copy.
    fn write_plain(&mut self, text: &str) -> Result<(), String>;

    /// The clipboard's change counter (macOS `changeCount`, Windows
    /// `GetClipboardSequenceNumber`): it moves on every write, ours or not.
    fn change_mark(&mut self) -> i64;

    /// Replace the clipboard with `snapshot` (an empty one clears it), but
    /// only while its change mark is still `mark`: Ok(false), with nothing
    /// touched, when anything else has written to it. The mark is compared
    /// as close to the write as the platform allows — under the clipboard
    /// lock on Windows, right before clearing it on macOS.
    fn restore_if_unchanged(
        &mut self,
        snapshot: &Self::Snapshot,
        mark: i64,
    ) -> Result<bool, String>;
}

/// What a snapshot has spent so far, against SNAPSHOT_TIME_BUDGET and
/// SNAPSHOT_BYTE_BUDGET. The time is checked before each read, because a read
/// that is already running cannot be interrupted: one slow read (an app
/// rendering a picture, an iPhone's copy fetched over the air) still holds up
/// the paste for as long as it takes. Once a read has run past the budget,
/// the next one fails the whole snapshot — what was read so far is dropped
/// too — so only a slow read that happens to be the last one is kept.
#[cfg(any(target_os = "macos", target_os = "windows", test))]
struct SnapshotBudget {
    started: Instant,
    bytes: usize,
    formats: usize,
}

#[cfg(any(target_os = "macos", target_os = "windows", test))]
impl SnapshotBudget {
    fn start() -> Self {
        Self {
            started: Instant::now(),
            bytes: 0,
            formats: 0,
        }
    }

    /// Before reading another format: Err once the time is up.
    fn before_read(&self) -> Result<(), String> {
        if self.started.elapsed() > SNAPSHOT_TIME_BUDGET {
            return Err(self.exceeded());
        }
        Ok(())
    }

    /// Before copying out a format of `len` bytes: Err when it would go past
    /// the byte budget, otherwise it is counted.
    fn take(&mut self, len: usize) -> Result<(), String> {
        let bytes = self.bytes.saturating_add(len);
        if bytes > SNAPSHOT_BYTE_BUDGET {
            return Err(self.exceeded());
        }
        self.bytes = bytes;
        self.formats += 1;
        Ok(())
    }

    /// Why the snapshot stopped, in numbers only: never a byte of the data.
    fn exceeded(&self) -> String {
        format!(
            "too slow or too large to save ({} ms, {} bytes in {} formats read)",
            self.started.elapsed().as_millis(),
            self.bytes,
            self.formats
        )
    }
}

/// The one restore that can be pending at a time, process-wide.
pub(super) struct RestoreLedger<S> {
    /// Moves on every insert and explicit copy, so a restore timer can tell
    /// whether the restore it was set for is still the pending one.
    generation: u64,
    pending: Option<Pending<S>>,
}

struct Pending<S> {
    generation: u64,
    /// The user's clipboard from before the dictation.
    snapshot: S,
    /// The change mark right after our write: anything else means somebody
    /// wrote to the clipboard after us.
    mark: i64,
}

impl<S> Default for RestoreLedger<S> {
    fn default() -> Self {
        Self {
            generation: 0,
            pending: None,
        }
    }
}

impl<S> RestoreLedger<S> {
    /// Something new is about to own the clipboard, so no pending restore may
    /// land on it. Returns that restore's snapshot — the user's clipboard from
    /// before the last dictation — with the change mark that dictation's
    /// write left: while the clipboard still shows that mark, it still holds
    /// the dictation.
    fn supersede(&mut self) -> Option<(S, i64)> {
        self.generation += 1;
        self.pending.take().map(|p| (p.snapshot, p.mark))
    }

    /// Restore `snapshot` later, unless the clipboard moves past `mark`
    /// first. Returns the generation the restore timer has to present.
    fn arm(&mut self, snapshot: S, mark: i64) -> u64 {
        self.generation += 1;
        self.pending = Some(Pending {
            generation: self.generation,
            snapshot,
            mark,
        });
        self.generation
    }

    /// The restore the timer for `generation` was set for, or None when an
    /// insert or a copy has superseded it since.
    fn due(&self, generation: u64) -> Option<&Pending<S>> {
        self.pending.as_ref().filter(|p| p.generation == generation)
    }

    /// The restore for `generation` is done with — carried out, called off by
    /// a newer copy, or given up on. Nothing when it was superseded already.
    fn forget(&mut self, generation: u64) {
        if self.due(generation).is_some() {
            self.pending = None;
        }
    }
}

/// Why an insert posted no paste and left the text on the clipboard instead,
/// known before the paste (Windows' UIPI refusal only shows in the paste
/// itself: the `paste` callback's `false`). See [`paste_block`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Blocked {
    /// macOS: a synthetic ⌘V needs Accessibility, and it is not granted.
    Accessibility,
    /// Windows: the foreground window is Parley's own hidden one, so a Ctrl+V
    /// would land nowhere — while still counting as sent, so the clipboard
    /// would be put back over the only copy of the dictation.
    NoTarget,
}

/// The window a paste would go to, as far as deciding whether to post it
/// needs to know (each platform's `imp::foreground`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Foreground {
    /// It is one of Parley's own.
    pub own: bool,
    /// It is not on screen. Only ever true for a window of ours on Windows:
    /// tray-icon makes its hidden message window the foreground window to
    /// open the tray menu, and it stays there after the menu closes, so a
    /// dictation stopped from the tray settles with it in front.
    pub hidden: bool,
}

/// Whether to hold an insert's paste back, decided before it is posted.
///
/// Parley's own window in front is NOT a reason: the overlay never activates
/// Parley, so that is the user dictating into one of its fields (the Ask box,
/// a meeting's context, Settings), and the paste lands there like anywhere
/// else. Holding it back told them to paste by hand a text that was already
/// in the field, and doing so inserted it twice. A hidden window of ours is
/// another matter: nothing there takes a paste, and only the clipboard can
/// carry the text to where the user goes next.
pub(super) fn paste_block(accessibility_trusted: bool, foreground: Foreground) -> Option<Blocked> {
    if !accessibility_trusted {
        return Some(Blocked::Accessibility);
    }
    (foreground.own && foreground.hidden).then_some(Blocked::NoTarget)
}

/// What an insert did.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Inserted {
    /// The paste chord went out. False: the text is on the clipboard to stay.
    pub pasted: bool,
    /// The generation to restore the clipboard for, when there is something
    /// to put back.
    pub restore: Option<u64>,
}

/// Remote-desktop and virtual-machine clients, by macOS bundle id (a prefix,
/// lower-cased) — the app a dictation is pasted into when the field is on
/// another machine.
const LATE_READER_BUNDLE_PREFIXES: [&str; 13] = [
    "com.microsoft.rdc",         // Microsoft Remote Desktop / Windows App
    "com.parallels.",            // Parallels Desktop
    "com.vmware.",               // VMware Fusion
    "org.virtualbox.",           // VirtualBox
    "com.utmapp.",               // UTM
    "com.citrix.",               // Citrix Workspace / Viewer
    "com.teamviewer.",           // TeamViewer
    "com.philandro.anydesk",     // AnyDesk
    "com.realvnc.",              // RealVNC Viewer
    "com.apple.screensharing",   // Screen Sharing (VNC)
    "com.google.chrome.app.",    // Chrome apps, Chrome Remote Desktop's included
    "com.jumpdesktop.",          // Jump Desktop
    "com.p5sys.jump",            // Jump Desktop (older id)
];

/// The same clients on Windows, by executable name (lower-cased).
const LATE_READER_EXES: [&str; 17] = [
    "mstsc.exe",        // Remote Desktop Connection
    "msrdc.exe",        // Remote Desktop client / Windows App sessions
    "msrdcw.exe",       // Remote Desktop client
    "windows365.exe",   // Windows App
    "vmconnect.exe",    // Hyper-V
    "vmware.exe",       // VMware Workstation
    "vmplayer.exe",     // VMware Player
    "virtualbox.exe",   // VirtualBox
    "virtualboxvm.exe", // VirtualBox VM window
    "cdviewer.exe",     // Citrix Workspace
    "wfica32.exe",      // Citrix ICA client
    "teamviewer.exe",   // TeamViewer
    "anydesk.exe",      // AnyDesk
    "vncviewer.exe",    // RealVNC / TigerVNC
    "tvnviewer.exe",    // TightVNC
    "remoting_desktop.exe", // Chrome Remote Desktop
    "parsecd.exe",      // Parsec
];

/// Whether the app a paste goes to (`insert_text`'s frontmost app: a macOS
/// bundle id, or a Windows executable name) reads the clipboard late: a
/// remote-desktop or virtual-machine client, which forwards the clipboard to
/// the other machine when its own sync gets to it — after the paste chord
/// has gone through, sometimes seconds later. The restore would hand those
/// the user's OLD clipboard to paste, so for them the dictation is not
/// borrowed: it goes up as an ordinary copy (a transient one could be
/// skipped by the very sync that has to carry it) and stays, as when no
/// paste can go out. Matched leniently ("vnc" anywhere, "chromoting"), since
/// a missed client costs a wrong paste and a false match only a clipboard
/// that keeps the dictation.
pub(super) fn reads_clipboard_late(app: &str) -> bool {
    let app = app.to_ascii_lowercase();
    LATE_READER_EXES.contains(&app.as_str())
        || LATE_READER_BUNDLE_PREFIXES
            .iter()
            .any(|prefix| app.starts_with(prefix))
        || app.contains("vnc")
        || app.contains("chromoting")
        || app.contains("remotedesktop")
}

/// Put `text` into the focused field through the clipboard, via `paste`
/// (which posts the chord and says whether it went out). Runs with the ledger
/// locked, so neither the restore timer nor an explicit copy can interleave.
/// `reads_late`: the target is a remote-desktop or VM client (see
/// [`reads_clipboard_late`]), so the dictation is pasted and left on the
/// clipboard.
pub(super) fn insert<P: Pasteboard>(
    ledger: &mut RestoreLedger<P::Snapshot>,
    pb: &mut P,
    text: &str,
    blocked: Option<Blocked>,
    reads_late: bool,
    paste: impl FnOnce() -> bool,
) -> Result<Inserted, String> {
    // Whatever happens next replaces the clipboard, so a restore still
    // pending from the last dictation must not land on top of it.
    let earlier = ledger.supersede();
    if let Some(why) = blocked {
        log::info!("voice-typing: no paste ({why:?}); the dictation stays on the clipboard");
        pb.write_plain(text)?;
        return Ok(Inserted {
            pasted: false,
            restore: None,
        });
    }
    if reads_late {
        log::info!(
            "voice-typing: pasting into a remote or virtual machine; the dictation stays on the clipboard"
        );
        pb.write_plain(text)?;
        return Ok(Inserted {
            pasted: paste(),
            restore: None,
        });
    }
    // While the clipboard still holds the last dictation, that restore's
    // snapshot is exactly what this one has to give back too: saving the
    // clipboard now would save the last dictation's text, and two quick
    // dictations would leave the first one on the clipboard. Once the mark
    // has moved, someone (the user, another app) copied in between; that copy
    // is theirs, and it is what gets saved and given back.
    let earlier =
        earlier.and_then(|(snapshot, mark)| (pb.change_mark() == mark).then_some(snapshot));
    let started = Instant::now();
    let (saved, written) = pb.save_and_write_transient(earlier.is_none(), text);
    let snapshot = match (earlier, saved) {
        (Some(snapshot), _) => Some(snapshot),
        (None, Some(saved)) => keep_snapshot(saved, started.elapsed()),
        (None, None) => None,
    };
    if let Err(e) = written {
        // The write can fail after clearing the clipboard: put back what we
        // can before reporting it — unless something wrote to it since.
        if let Some(snapshot) = &snapshot {
            let mark = pb.change_mark();
            if let Err(restore) = pb.restore_if_unchanged(snapshot, mark) {
                log::warn!(
                    "voice-typing: clipboard restore after a failed write failed: {restore}"
                );
            }
        }
        return Err(e);
    }
    let mark = pb.change_mark();
    if !paste() {
        // Refused (Windows UIPI) or never built (macOS): the clipboard is the
        // delivery now, so the text stays — as an ordinary copy, which a
        // clipboard manager may keep like any other.
        if let Err(e) = pb.write_plain(text) {
            log::warn!(
                "voice-typing: rewriting the unpasted dictation as a plain copy failed: {e}"
            );
        }
        return Ok(Inserted {
            pasted: false,
            restore: None,
        });
    }
    Ok(Inserted {
        pasted: true,
        restore: snapshot.map(|s| ledger.arm(s, mark)),
    })
}

/// The clipboard as an insert saved it; None when it could not be (unreadable,
/// or over the snapshot budget). `took`: the save and the write together.
fn keep_snapshot<S>(saved: Result<S, String>, took: Duration) -> Option<S> {
    if took >= SLOW_SNAPSHOT {
        log::info!(
            "voice-typing: saving the clipboard took {}ms",
            took.as_millis()
        );
    }
    match saved {
        Ok(snapshot) => Some(snapshot),
        Err(e) => {
            // Still paste: the dictation matters more than the clipboard,
            // which then keeps the dictation, as it always used to — still
            // marked transient, so clipboard histories skip it, and the next
            // dictation saves it and gives it back still marked so.
            log::warn!("voice-typing: could not save the clipboard; it keeps the dictation: {e}");
            None
        }
    }
}

/// An explicit copy the user asked for. Never restored over: a restore still
/// pending from the last insert is called off.
pub(super) fn copy<P: Pasteboard>(
    ledger: &mut RestoreLedger<P::Snapshot>,
    pb: &mut P,
    text: &str,
) -> Result<(), String> {
    ledger.supersede();
    pb.write_plain(text)
}

/// What a restore timer found when it fired.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum RestoreOutcome {
    /// The user's clipboard is back.
    Restored,
    /// An insert or an explicit copy came first; nothing to do.
    Superseded,
    /// Something wrote to the clipboard after the paste. That is the user's
    /// now, and stays.
    ClipboardMoved,
    /// The clipboard could not be written; it still holds the dictation. The
    /// restore stays pending, for the timer to try again.
    Failed(String),
}

/// The restore timer for `generation` fired.
pub(super) fn restore_due<P: Pasteboard>(
    ledger: &mut RestoreLedger<P::Snapshot>,
    pb: &mut P,
    generation: u64,
) -> RestoreOutcome {
    let Some(pending) = ledger.due(generation) else {
        return RestoreOutcome::Superseded;
    };
    // The mark is compared inside the restore, as late as the platform
    // allows: on Windows under the clipboard lock, where no other write can
    // slip between the check and ours, even while `Open::new` waits out
    // another process; on macOS, which has no lock, right before clearing.
    match pb.restore_if_unchanged(&pending.snapshot, pending.mark) {
        Ok(restored) => {
            ledger.forget(generation);
            if restored {
                RestoreOutcome::Restored
            } else {
                RestoreOutcome::ClipboardMoved
            }
        }
        Err(e) => RestoreOutcome::Failed(e),
    }
}

type SystemSnapshot = <SystemPasteboard as Pasteboard>::Snapshot;

/// The restore bookkeeping, shared by inserts, explicit copies and the
/// restore timer. Each holds the lock across its clipboard work, so none of
/// them can land in the middle of another.
#[derive(Default)]
pub struct ClipboardState(Mutex<RestoreLedger<SystemSnapshot>>);

impl ClipboardState {
    /// The ledger. A panic mid-operation leaves it consistent (every change
    /// is a single assignment), so a poisoned lock is not a reason to stop
    /// dictating.
    pub(super) fn lock(&self) -> MutexGuard<'_, RestoreLedger<SystemSnapshot>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Put the user's clipboard back CLIPBOARD_RESTORE_DELAY from now, if the
/// insert that armed `generation` is still the latest word on it — trying
/// again after RESTORE_RETRY_BACKOFF when the clipboard cannot be written.
pub(super) fn schedule_restore(app: &AppHandle, generation: u64) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CLIPBOARD_RESTORE_DELAY).await;
        let mut retries = RESTORE_RETRY_BACKOFF.iter();
        loop {
            let Some(outcome) = attempt_restore(&app, generation).await else {
                return;
            };
            match outcome {
                RestoreOutcome::Restored => log::info!("voice-typing: clipboard restored"),
                RestoreOutcome::ClipboardMoved => {
                    log::info!("voice-typing: clipboard changed after the paste; left as it is")
                }
                RestoreOutcome::Superseded => {}
                RestoreOutcome::Failed(e) => {
                    if let Some(&wait) = retries.next() {
                        log::info!(
                            "voice-typing: clipboard restore failed; trying again in {}ms: {e}",
                            wait.as_millis()
                        );
                        // Waits without the ledger: an insert or a copy in
                        // the meantime supersedes the restore as usual, and
                        // the next attempt finds nothing to do.
                        tokio::time::sleep(wait).await;
                        continue;
                    }
                    app.state::<ClipboardState>().lock().forget(generation);
                    log::warn!(
                        "voice-typing: clipboard restore failed; the clipboard keeps the dictation: {e}"
                    );
                }
            }
            return;
        }
    });
}

/// One restore attempt, run where the platform wants clipboard work done.
/// None when it could not run at all.
async fn attempt_restore(app: &AppHandle, generation: u64) -> Option<RestoreOutcome> {
    let job_app = app.clone();
    let job = move || {
        let state = job_app.state::<ClipboardState>();
        let mut ledger = state.lock();
        restore_due(&mut ledger, &mut SystemPasteboard, generation)
    };
    // AppKit wants the pasteboard on the main thread, where the insert and
    // the copies run too. The Win32 clipboard only needs one thread to open
    // and close it, and holding the main thread for a busy clipboard's
    // retries would stall every window — so on Windows the insert and the
    // copies run on a blocking worker as well.
    #[cfg(target_os = "macos")]
    {
        let (done, outcome) = tokio::sync::oneshot::channel();
        if app
            .run_on_main_thread(move || {
                let _ = done.send(job());
            })
            .is_err()
        {
            log::warn!("voice-typing: clipboard restore skipped: the event loop is gone");
            return None;
        }
        outcome.await.ok()
    }
    #[cfg(not(target_os = "macos"))]
    match tauri::async_runtime::spawn_blocking(job).await {
        Ok(outcome) => Some(outcome),
        Err(e) => {
            log::warn!("voice-typing: clipboard restore did not run: {e}");
            None
        }
    }
}

// --- Windows: which formats a snapshot reads -------------------------------

/// The predefined Win32 clipboard formats a snapshot reads. Spelled out
/// rather than imported from `Win32::System::Ole`, so a handful of 16-bit
/// constants don't drag the whole OLE feature (and its compile time) into
/// the build.
#[cfg(any(target_os = "windows", test))]
const CF_TEXT: u32 = 1;
#[cfg(any(target_os = "windows", test))]
const CF_DIB: u32 = 8;
#[cfg(any(target_os = "windows", test))]
const CF_UNICODETEXT: u32 = 13;
#[cfg(any(target_os = "windows", test))]
const CF_HDROP: u32 = 15;
#[cfg(any(target_os = "windows", test))]
const CF_LOCALE: u32 = 16;
#[cfg(any(target_os = "windows", test))]
const CF_DIBV5: u32 = 17;

/// The registered format clipboard monitors are asked to leave alone.
/// Password managers put their secrets up with it; we put the dictation up
/// with it.
#[cfg(any(target_os = "windows", test))]
const EXCLUDE_FROM_MONITORS: &str = "ExcludeClipboardContentFromMonitorProcessing";

/// Our own registered format, published with every transient write next to
/// EXCLUDE_FROM_MONITORS so the next snapshot can tell a dictation Parley
/// left behind (a restore that failed, a clipboard too slow to save) from a
/// password manager's secret: it is saved and given back still marked
/// transient, not cleared as a secret.
#[cfg(any(target_os = "windows", test))]
const PARLEY_TRANSIENT: &str = "ParleyTransientDictation";

/// The registered formats a snapshot reads, besides the predefined ones in
/// [`is_saved_format`]: rich text, HTML, images and Explorer's file copies —
/// what a paste somewhere else actually uses.
#[cfg(any(target_os = "windows", test))]
const SAVED_FORMAT_NAMES: [&str; 6] = [
    "HTML Format",
    "Rich Text Format",
    "PNG",
    "Preferred DropEffect",
    "Shell IDList Array",
    "UniformResourceLocatorW",
];

/// Whether a snapshot reads `format` (`name`: its registered name, for ids
/// from 0xC000 up).
///
/// An allow-list, because reading a format an app only promised makes it
/// render the format there and then, and Office and every other OLE app
/// promise nearly all of theirs: "Embed Source" serializes the whole source
/// document, "Link Source", "Object Descriptor", "Ole Private Data",
/// "Native", "Biff12" and the like are each another round trip into the
/// owner. Those only mean anything while the owner still owns the clipboard
/// anyway, so a restore after an OLE copy brings back the static formats (the
/// text, rich text, HTML, a picture) and not the live object. Everything read
/// here is a plain memory block: GDI formats (CF_BITMAP, CF_ENHMETAFILE, …)
/// would copy a handle the clipboard frees when emptied, and Windows rebuilds
/// them from CF_DIB and the text anyway. FileGroupDescriptorW is left out on
/// purpose: without its "FileContents" streams, which are no memory block, it
/// would promise files that a paste then fails to find.
#[cfg(any(target_os = "windows", test))]
fn is_saved_format(format: u32, name: Option<&str>) -> bool {
    match format {
        CF_TEXT | CF_UNICODETEXT | CF_LOCALE | CF_DIB | CF_DIBV5 | CF_HDROP => true,
        0xC000..=0xFFFF => name.is_some_and(|name| {
            SAVED_FORMAT_NAMES
                .iter()
                .any(|saved| saved.eq_ignore_ascii_case(name))
        }),
        _ => false,
    }
}

/// What a Windows snapshot does with the formats on the clipboard.
#[cfg(any(target_os = "windows", test))]
#[derive(Debug, PartialEq, Eq)]
enum SnapshotPlan {
    /// A password manager's secret: neither read nor put back. Holding a copy
    /// of a password is not ours to do, and a restore would read as a new
    /// copy to the password manager's timed clear; the dictation's restore
    /// clears the clipboard instead.
    Concealed,
    /// Read `formats`, in this order. `transient`: the clipboard holds a
    /// dictation Parley left behind, which goes back up with the markers it
    /// came with (none of them is a saved format), so the restore does not
    /// hand it to the clipboard history, the cloud clipboard and clipboard
    /// managers one dictation late.
    Read { formats: Vec<u32>, transient: bool },
}

/// Plan a snapshot from the formats the clipboard lists (in its order, each
/// with its registered name), before a single byte is read.
#[cfg(any(target_os = "windows", test))]
fn plan_snapshot<'a>(listed: impl IntoIterator<Item = (u32, Option<&'a str>)>) -> SnapshotPlan {
    let is =
        |name: Option<&str>, marker: &str| name.is_some_and(|n| n.eq_ignore_ascii_case(marker));
    let (mut excluded, mut ours, mut dib) = (false, false, false);
    let mut read = Vec::new();
    for (format, name) in listed {
        excluded |= is(name, EXCLUDE_FROM_MONITORS);
        ours |= is(name, PARLEY_TRANSIENT);
        if !is_saved_format(format, name) {
            continue;
        }
        // CF_DIB and CF_DIBV5 are the same picture, one synthesized from the
        // other: the first listed is read, and Windows rebuilds the other
        // from it after a restore.
        if format == CF_DIB || format == CF_DIBV5 {
            if dib {
                continue;
            }
            dib = true;
        }
        read.push(format);
    }
    if excluded && !ours {
        SnapshotPlan::Concealed
    } else {
        SnapshotPlan::Read {
            formats: read,
            transient: ours,
        }
    }
}

// --- macOS: which types a snapshot reads -----------------------------------

/// The nspasteboard.org marker password managers put on a secret. Such a
/// clipboard is not saved or put back: holding a copy of a password is not
/// ours to do, and a restore would count as a new copy, which can stop the
/// password manager's own timed clear. The dictation's restore clears the
/// clipboard instead.
#[cfg(any(target_os = "macos", test))]
const CONCEALED_TYPE: &str = "org.nspasteboard.ConcealedType";

/// Whether a pasteboard item's types mark it concealed.
#[cfg(any(target_os = "macos", test))]
fn is_concealed<'a>(mut types: impl Iterator<Item = &'a str>) -> bool {
    types.any(|t| t == CONCEALED_TYPE)
}

/// The pasteboard types a snapshot reads: what a paste somewhere else
/// actually uses — text, rich text, HTML, a picture, files and links.
#[cfg(any(target_os = "macos", test))]
const SAVED_TYPES: [&str; 9] = [
    "public.utf8-plain-text",
    "public.utf16-external-plain-text",
    "public.rtf",
    "public.html",
    "public.png",
    "public.tiff",
    "public.file-url",
    "public.url",
    "com.apple.flat-rtfd",
];

/// Whether a snapshot reads `ty` from a pasteboard item carrying `item`'s
/// types.
///
/// An allow-list, because the snapshot runs on the main thread and a read
/// cannot be interrupted: reading a type the copying app only promised makes
/// it render that type there and then, and an app's own types (Office's,
/// Excel's native sheet, a design tool's document) are exactly the ones it
/// renders slowly — one such read could hold every window and the paste for
/// seconds, whatever the time budget says. So `dyn.…` aliases, pre-UTI names,
/// file-promise bookkeeping, PDF and every app-private type are skipped, and
/// such a copy comes back as the plain formats it also carries.
///
/// TIFF only when the item has neither a PNG (the same picture again) nor
/// plain text: then it is a picture OF that text — an Excel or Numbers range,
/// a selection in a document — which its owner renders on the spot, for
/// seconds on a big range. Such a copy comes back as text and rich text, and
/// no longer pastes as a picture into an app that only takes pictures. HTML or
/// RTF alone does not count as text here: a browser's image copy is a TIFF
/// with an HTML `<img>` tag beside it, and the TIFF is the picture.
#[cfg(any(target_os = "macos", test))]
fn is_saved_type(ty: &str, item: &[&str]) -> bool {
    if ty == "public.tiff" {
        return !item
            .iter()
            .any(|t| matches!(*t, "public.png" | "public.utf8-plain-text"));
    }
    SAVED_TYPES.contains(&ty)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod other {
    use super::Pasteboard;

    /// No clipboard is wired up off macOS and Windows.
    pub struct SystemPasteboard;

    const UNSUPPORTED: &str = "clipboard only implemented on macOS and Windows";

    impl Pasteboard for SystemPasteboard {
        type Snapshot = ();

        fn snapshot(&mut self) -> Result<(), String> {
            Err(UNSUPPORTED.into())
        }

        fn write_transient(&mut self, _text: &str) -> Result<(), String> {
            Err(UNSUPPORTED.into())
        }

        fn write_plain(&mut self, _text: &str) -> Result<(), String> {
            Err(UNSUPPORTED.into())
        }

        fn change_mark(&mut self) -> i64 {
            0
        }

        fn restore_if_unchanged(&mut self, _snapshot: &(), _mark: i64) -> Result<bool, String> {
            Err(UNSUPPORTED.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{
        copy, insert, is_concealed, is_saved_format, is_saved_type, paste_block, plan_snapshot,
        reads_clipboard_late, restore_due, Blocked, Foreground, Inserted, Pasteboard,
        RestoreLedger, RestoreOutcome,
        SnapshotBudget, SnapshotPlan, CF_DIB, CF_DIBV5, CF_HDROP, CF_LOCALE, CF_TEXT,
        CF_UNICODETEXT, EXCLUDE_FROM_MONITORS, PARLEY_TRANSIENT, SNAPSHOT_BYTE_BUDGET,
        SNAPSHOT_TIME_BUDGET,
    };

    /// A clipboard holding one string, with a change mark that moves on every
    /// write like the real ones.
    #[derive(Default)]
    struct Board {
        text: String,
        transient: bool,
        mark: i64,
        fail_snapshot: bool,
        /// How many snapshots were taken.
        snapshots: u32,
        fail_write: bool,
        /// How many restores fail to take the clipboard before one gets it.
        fail_restores: u32,
        /// Another app copies this while a restore is taking the clipboard:
        /// after the timer fired, before the mark is compared.
        copy_during_restore: Option<String>,
    }

    impl Board {
        fn holding(text: &str) -> Self {
            Self {
                text: text.into(),
                ..Self::default()
            }
        }

        /// Another app (or the user) copies something.
        fn copied_elsewhere(&mut self, text: &str) {
            self.text = text.into();
            self.transient = false;
            self.mark += 1;
        }
    }

    impl Pasteboard for Board {
        type Snapshot = String;

        fn snapshot(&mut self) -> Result<String, String> {
            self.snapshots += 1;
            if self.fail_snapshot {
                return Err("snapshot failed".into());
            }
            Ok(self.text.clone())
        }

        fn write_transient(&mut self, text: &str) -> Result<(), String> {
            self.mark += 1;
            if self.fail_write {
                // Cleared, then refused.
                self.text.clear();
                return Err("write failed".into());
            }
            self.text = text.into();
            self.transient = true;
            Ok(())
        }

        fn write_plain(&mut self, text: &str) -> Result<(), String> {
            self.mark += 1;
            self.text = text.into();
            self.transient = false;
            Ok(())
        }

        fn change_mark(&mut self) -> i64 {
            self.mark
        }

        fn restore_if_unchanged(&mut self, snapshot: &String, mark: i64) -> Result<bool, String> {
            if let Some(text) = self.copy_during_restore.take() {
                self.copied_elsewhere(&text);
            }
            if self.fail_restores > 0 {
                self.fail_restores -= 1;
                return Err("clipboard is held by another process".into());
            }
            if self.mark != mark {
                return Ok(false);
            }
            self.mark += 1;
            self.text = snapshot.clone();
            self.transient = false;
            Ok(true)
        }
    }

    fn not_pasted() -> Inserted {
        Inserted {
            pasted: false,
            restore: None,
        }
    }

    #[test]
    fn an_insert_pastes_a_transient_copy_and_gives_the_clipboard_back() {
        let mut ledger = RestoreLedger::default();
        let mut board = Board::holding("https://example.com");
        let mut posted = false;

        let done = insert(&mut ledger, &mut board, "你好", None, false, || {
            posted = true;
            true
        })
        .unwrap();
        assert!(posted);
        assert_eq!(board.text, "你好");
        assert!(
            board.transient,
            "clipboard managers must skip the dictation"
        );

        let generation = done.restore.unwrap();
        assert_eq!(
            restore_due(&mut ledger, &mut board, generation),
            RestoreOutcome::Restored
        );
        assert_eq!(board.text, "https://example.com");
        assert!(!board.transient);
    }

    #[test]
    fn a_second_insert_reuses_the_first_snapshot_and_supersedes_its_restore() {
        let mut ledger = RestoreLedger::default();
        let mut board = Board::holding("the user's link");
        let first = insert(&mut ledger, &mut board, "第一句", None, false, || true).unwrap();
        let second = insert(&mut ledger, &mut board, "第二句", None, false, || true).unwrap();
        let (first, second) = (first.restore.unwrap(), second.restore.unwrap());

        // The first restore must not put the user's link back under the
        // second paste, nor the second restore bring back the first dictation.
        assert_eq!(
            restore_due(&mut ledger, &mut board, first),
            RestoreOutcome::Superseded
        );
        assert_eq!(board.text, "第二句");
        assert_eq!(
            restore_due(&mut ledger, &mut board, second),
            RestoreOutcome::Restored
        );
        assert_eq!(board.text, "the user's link");

        // Once done, a restore is spent: firing again changes nothing.
        board.copied_elsewhere("later");
        assert_eq!(
            restore_due(&mut ledger, &mut board, second),
            RestoreOutcome::Superseded
        );
        assert_eq!(board.text, "later");
    }

    #[test]
    fn a_copy_made_between_two_inserts_is_what_the_second_gives_back() {
        let mut ledger = RestoreLedger::default();
        let mut board = Board::holding("the user's link");
        let first = insert(&mut ledger, &mut board, "第一句", None, false, || true).unwrap();
        // ⌘X in the document while the next dictation is still on its way.
        board.copied_elsewhere("the cut word");
        let second = insert(&mut ledger, &mut board, "第二句", None, false, || true).unwrap();

        assert_eq!(
            restore_due(&mut ledger, &mut board, first.restore.unwrap()),
            RestoreOutcome::Superseded
        );
        assert_eq!(
            restore_due(&mut ledger, &mut board, second.restore.unwrap()),
            RestoreOutcome::Restored
        );
        // Not the link from before the first dictation: that would wipe out
        // the cut for good.
        assert_eq!(board.text, "the cut word");
    }

    #[test]
    fn an_explicit_copy_calls_off_a_pending_restore() {
        let mut ledger = RestoreLedger::default();
        let mut board = Board::holding("old");
        let done = insert(&mut ledger, &mut board, "說的話", None, false, || true).unwrap();

        copy(&mut ledger, &mut board, "說的話").unwrap();
        assert!(!board.transient);
        assert_eq!(
            restore_due(&mut ledger, &mut board, done.restore.unwrap()),
            RestoreOutcome::Superseded
        );
        assert_eq!(board.text, "說的話");

        // The copy is the user's clipboard now: the next insert saves it.
        let next = insert(&mut ledger, &mut board, "下一句", None, false, || true).unwrap();
        restore_due(&mut ledger, &mut board, next.restore.unwrap());
        assert_eq!(board.text, "說的話");
    }

    #[test]
    fn a_copy_made_after_the_paste_is_never_restored_over() {
        let mut ledger = RestoreLedger::default();
        let mut board = Board::holding("old");
        let done = insert(&mut ledger, &mut board, "dictated", None, false, || true).unwrap();

        board.copied_elsewhere("copied during the second");
        assert_eq!(
            restore_due(&mut ledger, &mut board, done.restore.unwrap()),
            RestoreOutcome::ClipboardMoved
        );
        assert_eq!(board.text, "copied during the second");

        // Nothing is left pending: the next insert saves the new copy.
        let next = insert(&mut ledger, &mut board, "again", None, false, || true).unwrap();
        restore_due(&mut ledger, &mut board, next.restore.unwrap());
        assert_eq!(board.text, "copied during the second");
    }

    #[test]
    fn a_copy_landing_while_the_restore_takes_the_clipboard_is_kept() {
        let mut ledger = RestoreLedger::default();
        let mut board = Board::holding("old");
        let done = insert(&mut ledger, &mut board, "dictated", None, false, || true).unwrap();

        // The mark was still ours when the timer fired; the copy lands while
        // the restore waits for the clipboard.
        board.copy_during_restore = Some("copied just then".into());
        assert_eq!(
            restore_due(&mut ledger, &mut board, done.restore.unwrap()),
            RestoreOutcome::ClipboardMoved
        );
        assert_eq!(board.text, "copied just then");
        assert!(ledger.pending.is_none());
    }

    #[test]
    fn a_failed_restore_stays_pending_and_a_retry_gives_the_clipboard_back() {
        let mut ledger = RestoreLedger::default();
        let mut board = Board::holding("the user's image");
        let generation = insert(&mut ledger, &mut board, "dictated", None, false, || true)
            .unwrap()
            .restore
            .unwrap();

        board.fail_restores = 2;
        for _ in 0..2 {
            assert!(matches!(
                restore_due(&mut ledger, &mut board, generation),
                RestoreOutcome::Failed(_)
            ));
            assert_eq!(board.text, "dictated");
        }
        assert_eq!(
            restore_due(&mut ledger, &mut board, generation),
            RestoreOutcome::Restored
        );
        assert_eq!(board.text, "the user's image");
    }

    #[test]
    fn a_failed_restore_is_not_retried_over_a_later_copy_or_insert() {
        let mut ledger = RestoreLedger::default();
        let mut board = Board::holding("the user's link");
        let first = insert(&mut ledger, &mut board, "第一句", None, false, || true)
            .unwrap()
            .restore
            .unwrap();
        board.fail_restores = 1;
        assert!(matches!(
            restore_due(&mut ledger, &mut board, first),
            RestoreOutcome::Failed(_)
        ));

        // The next dictation takes the pending restore over: the clipboard
        // still holds the first one, so the link is what it gives back.
        let second = insert(&mut ledger, &mut board, "第二句", None, false, || true)
            .unwrap()
            .restore
            .unwrap();
        assert_eq!(
            restore_due(&mut ledger, &mut board, first),
            RestoreOutcome::Superseded
        );
        assert_eq!(board.text, "第二句");

        // A failed restore called off by an explicit copy stays off.
        board.fail_restores = 1;
        assert!(matches!(
            restore_due(&mut ledger, &mut board, second),
            RestoreOutcome::Failed(_)
        ));
        copy(&mut ledger, &mut board, "第二句").unwrap();
        assert_eq!(
            restore_due(&mut ledger, &mut board, second),
            RestoreOutcome::Superseded
        );
        assert_eq!(board.text, "第二句");
    }

    #[test]
    fn a_restore_given_up_on_is_dropped() {
        let mut ledger = RestoreLedger::default();
        let mut board = Board::holding("old");
        let generation = insert(&mut ledger, &mut board, "dictated", None, false, || true)
            .unwrap()
            .restore
            .unwrap();
        board.fail_restores = 1;
        assert!(matches!(
            restore_due(&mut ledger, &mut board, generation),
            RestoreOutcome::Failed(_)
        ));

        ledger.forget(generation);
        assert!(ledger.pending.is_none());
        assert_eq!(
            restore_due(&mut ledger, &mut board, generation),
            RestoreOutcome::Superseded
        );
        assert_eq!(board.text, "dictated");
    }

    #[test]
    fn a_blocked_insert_posts_nothing_and_leaves_a_plain_copy() {
        for why in [Blocked::Accessibility, Blocked::NoTarget] {
            let mut ledger = RestoreLedger::default();
            let mut board = Board::holding("old");
            // A restore pending from an earlier dictation…
            let earlier = insert(&mut ledger, &mut board, "earlier", None, false, || true).unwrap();

            let done = insert(&mut ledger, &mut board, "dictated", Some(why), false, || {
                panic!("no paste may be posted")
            })
            .unwrap();
            assert_eq!(done, not_pasted(), "{why:?}");
            assert_eq!(board.text, "dictated");
            assert!(!board.transient);
            // …must not take the delivery off the clipboard.
            assert_eq!(
                restore_due(&mut ledger, &mut board, earlier.restore.unwrap()),
                RestoreOutcome::Superseded
            );
            assert_eq!(board.text, "dictated");
            assert!(ledger.pending.is_none());
        }
    }

    #[test]
    fn parleys_own_window_in_front_is_pasted_into_unless_it_is_hidden() {
        let own = Foreground {
            own: true,
            hidden: false,
        };
        let tray = Foreground {
            own: true,
            hidden: true,
        };
        let elsewhere = Foreground::default();
        // The user dictating into the Ask box or Settings: held back, the
        // overlay would say to paste by hand a text already in the field, and
        // doing so would insert it twice.
        assert_eq!(paste_block(true, own), None);
        assert_eq!(paste_block(true, elsewhere), None);
        // Another app's hidden window is not ours to judge.
        assert_eq!(
            paste_block(
                true,
                Foreground {
                    own: false,
                    hidden: true
                }
            ),
            None
        );
        // Windows' tray menu leaves its hidden window in front: a Ctrl+V
        // there lands nowhere, so the text stays on the clipboard.
        assert_eq!(paste_block(true, tray), Some(Blocked::NoTarget));
        for foreground in [own, tray, elsewhere] {
            assert_eq!(paste_block(false, foreground), Some(Blocked::Accessibility));
        }
    }

    #[test]
    fn the_reasons_to_hold_a_paste_back_are_these_two() {
        // No wildcard: a new reason fails to compile here, next to the test
        // above. "Parley is in front" used to be one, and must not come back.
        let known = |why: Blocked| match why {
            Blocked::Accessibility | Blocked::NoTarget => true,
        };
        assert!(known(Blocked::Accessibility) && known(Blocked::NoTarget));
    }

    #[test]
    fn a_refused_paste_leaves_the_text_as_a_plain_copy_with_nothing_pending() {
        let mut ledger = RestoreLedger::default();
        let mut board = Board::holding("old");
        let done = insert(&mut ledger, &mut board, "dictated", None, false, || false).unwrap();
        assert_eq!(done, not_pasted());
        assert_eq!(board.text, "dictated");
        assert!(!board.transient);
        assert!(ledger.pending.is_none());
    }

    #[test]
    fn an_unreadable_clipboard_still_pastes_and_keeps_the_dictation() {
        let mut ledger = RestoreLedger::default();
        let mut board = Board::holding("old");
        board.fail_snapshot = true;
        let done = insert(&mut ledger, &mut board, "dictated", None, false, || true).unwrap();
        assert_eq!(
            done,
            Inserted {
                pasted: true,
                restore: None
            }
        );
        assert_eq!(board.text, "dictated");
    }

    #[test]
    fn a_failed_write_puts_the_clipboard_back_and_posts_nothing() {
        let mut ledger = RestoreLedger::default();
        let mut board = Board::holding("old");
        board.fail_write = true;
        let result = insert(&mut ledger, &mut board, "dictated", None, false, || {
            panic!("no paste may be posted")
        });
        assert!(result.is_err());
        assert_eq!(board.text, "old");
        assert!(ledger.pending.is_none());
    }

    #[test]
    fn a_snapshot_stops_once_its_time_is_up() {
        let fresh = SnapshotBudget::start();
        assert!(fresh.before_read().is_ok());

        let late = SnapshotBudget {
            started: Instant::now() - SNAPSHOT_TIME_BUDGET - Duration::from_millis(1),
            ..SnapshotBudget::start()
        };
        let why = late.before_read().unwrap_err();
        assert!(why.starts_with("too slow or too large to save ("), "{why}");
    }

    #[test]
    fn a_snapshot_stops_before_copying_past_its_byte_budget() {
        let mut budget = SnapshotBudget::start();
        budget.take(SNAPSHOT_BYTE_BUDGET - 10).unwrap();
        budget.take(10).unwrap();
        // Refused before the copy, and counted only in numbers.
        let why = budget.take(1).unwrap_err();
        assert!(
            why.contains(&format!("{SNAPSHOT_BYTE_BUDGET} bytes in 2 formats")),
            "{why}"
        );
        assert!(budget.take(usize::MAX).is_err());
    }

    #[test]
    fn windows_snapshots_read_only_the_formats_a_paste_uses() {
        // Predefined memory-block formats a paste reads.
        for format in [
            CF_TEXT,
            CF_UNICODETEXT,
            CF_LOCALE,
            CF_DIB,
            CF_DIBV5,
            CF_HDROP,
        ] {
            assert!(is_saved_format(format, None), "{format:#x}");
        }
        // GDI objects (CF_BITMAP, CF_METAFILEPICT, CF_PALETTE,
        // CF_ENHMETAFILE), CF_OEMTEXT (synthesized from the text), the
        // owner-display and private ranges.
        for format in [0, 2, 3, 7, 9, 14, 0x0080, 0x0081, 0x0200, 0x0300, 0x03FF] {
            assert!(!is_saved_format(format, None), "{format:#x}");
        }
        for name in [
            "HTML Format",
            "Rich Text Format",
            "PNG",
            "Shell IDList Array",
        ] {
            assert!(is_saved_format(0xC0A0, Some(name)), "{name}");
        }
        // Registered names compare case-insensitively, as Windows does.
        assert!(is_saved_format(0xC0A0, Some("html format")));
        // OLE plumbing and native formats an owner renders on demand, and
        // file descriptors whose contents are no memory block.
        for name in [
            "Embed Source",
            "Link Source",
            "Object Descriptor",
            "Ole Private Data",
            "Native",
            "Biff12",
            "FileGroupDescriptorW",
            EXCLUDE_FROM_MONITORS,
            PARLEY_TRANSIENT,
        ] {
            assert!(!is_saved_format(0xC0A0, Some(name)), "{name}");
        }
        assert!(!is_saved_format(0xC0A0, None));
    }

    #[test]
    fn a_windows_snapshot_of_an_office_copy_reads_one_of_each_picture() {
        let listed = [
            (0xC101, Some("Biff12")),
            (0xC102, Some("Embed Source")),
            (0xC103, Some("HTML Format")),
            (CF_UNICODETEXT, None),
            (2, None),
            (CF_DIB, None),
            (0xC104, Some("Rich Text Format")),
            (CF_DIBV5, None),
            (CF_TEXT, None),
            (CF_LOCALE, None),
        ];
        assert_eq!(
            plan_snapshot(listed),
            SnapshotPlan::Read {
                formats: vec![0xC103, CF_UNICODETEXT, CF_DIB, 0xC104, CF_TEXT, CF_LOCALE],
                transient: false,
            }
        );
    }

    #[test]
    fn a_password_managers_secret_is_not_saved_but_parleys_own_dictation_is() {
        let secret = [
            (CF_UNICODETEXT, None),
            (0xC201, Some(EXCLUDE_FROM_MONITORS)),
        ];
        assert_eq!(plan_snapshot(secret), SnapshotPlan::Concealed);

        // What a restore that failed leaves behind: our transient write, with
        // the same exclusion marker plus our own. It is saved, and goes back
        // marked transient again: given back as an ordinary copy, it would
        // reach Win+V history, the cloud clipboard and clipboard managers
        // one dictation late.
        let leftover = [
            (CF_UNICODETEXT, None),
            (0xC202, Some(PARLEY_TRANSIENT)),
            (0xC201, Some(EXCLUDE_FROM_MONITORS)),
            (0xC203, Some("CanIncludeInClipboardHistory")),
            (0xC204, Some("CanUploadToCloudClipboard")),
        ];
        let expected = SnapshotPlan::Read {
            formats: vec![CF_UNICODETEXT],
            transient: true,
        };
        assert_eq!(plan_snapshot(leftover), expected);
        // Whatever order the clipboard lists them in.
        let markers_first = [
            (0xC201, Some(EXCLUDE_FROM_MONITORS)),
            (0xC203, Some("CanIncludeInClipboardHistory")),
            (0xC202, Some(PARLEY_TRANSIENT)),
            (CF_UNICODETEXT, None),
        ];
        assert_eq!(plan_snapshot(markers_first), expected);
    }

    #[test]
    fn a_password_managers_secret_is_recognised() {
        assert!(is_concealed(
            ["public.utf8-plain-text", "org.nspasteboard.ConcealedType"].into_iter()
        ));
        assert!(!is_concealed(
            ["public.utf8-plain-text", "org.nspasteboard.TransientType"].into_iter()
        ));
        assert!(!is_concealed(std::iter::empty()));
    }

    #[test]
    fn mac_snapshots_read_only_the_allow_listed_types() {
        let image = ["public.tiff", "public.png", "public.html"];
        assert!(is_saved_type("public.png", &image));
        assert!(is_saved_type("public.html", &image));
        assert!(!is_saved_type("public.tiff", &image));
        // An Excel or Numbers range: the picture of the cells is skipped,
        // the cells' text and rich text are saved.
        let range = [
            "public.utf8-plain-text",
            "public.html",
            "public.rtf",
            "com.adobe.pdf",
            "public.tiff",
            "com.microsoft.Excel.sheet",
        ];
        for ty in ["com.adobe.pdf", "public.tiff", "com.microsoft.Excel.sheet"] {
            assert!(!is_saved_type(ty, &range), "{ty}");
        }
        for ty in ["public.utf8-plain-text", "public.html", "public.rtf"] {
            assert!(is_saved_type(ty, &range), "{ty}");
        }
        // Without a PNG or text, the TIFF is the picture, and is kept — also
        // next to a browser's HTML `<img>` tag or rich text.
        for item in [&["public.tiff"][..], &["public.tiff", "public.html"][..]] {
            assert!(is_saved_type("public.tiff", item), "{item:?}");
        }

        for ty in [
            "dyn.ah62d4rv4gu8yc6durvwwaznwmuuha2pxsvw0e55bsmwca7d3sbwu",
            "NSStringPboardType",
            "Apple PNG pasteboard type",
            "NeXT Rich Text Format v1.0 pasteboard type",
            "CorePasteboardFlavorType 0x75726C20",
            "com.apple.pasteboard.promised-file-url",
            "com.apple.pasteboard.promised-file-content-type",
            "com.apple.NSFilePromiseItemMetaData",
            "com.adobe.pdf",
            "com.microsoft.Excel.sheet",
            "com.figma.document",
            "org.nspasteboard.TransientType",
        ] {
            assert!(!is_saved_type(ty, &[ty]), "{ty}");
        }
        for ty in [
            "public.utf8-plain-text",
            "public.utf16-external-plain-text",
            "public.rtf",
            "public.html",
            "public.png",
            "public.file-url",
            "public.url",
            "com.apple.flat-rtfd",
        ] {
            assert!(is_saved_type(ty, &[ty]), "{ty}");
        }
    }

    #[test]
    fn remote_desktop_and_vm_clients_read_the_clipboard_late() {
        for app in [
            "com.microsoft.rdc.macos",
            "com.parallels.desktop.console",
            "com.vmware.fusion",
            "org.virtualbox.app.VirtualBoxVM",
            "com.utmapp.UTM",
            "com.citrix.receiver.icaviewer.mac",
            "com.teamviewer.TeamViewer",
            "com.philandro.anydesk",
            "com.realvnc.vncviewer",
            "com.apple.ScreenSharing",
            "mstsc.exe",
            "MSTSC.EXE",
            "msrdc.exe",
            "vmconnect.exe",
            "vmware.exe",
            "VirtualBoxVM.exe",
            "CDViewer.exe",
            "TeamViewer.exe",
            "AnyDesk.exe",
            "vncviewer.exe",
            "tvnviewer.exe",
        ] {
            assert!(reads_clipboard_late(app), "{app}");
        }
        for app in [
            "com.apple.Notes",
            "com.tinyspeck.slackmacgap",
            "com.microsoft.Word",
            "com.google.Chrome",
            "notepad.exe",
            "WINWORD.EXE",
            "chrome.exe",
        ] {
            assert!(!reads_clipboard_late(app), "{app}");
        }
    }

    /// A remote or VM window reads the clipboard when its sync gets to it, so
    /// the restore would hand it the old clipboard: the dictation goes up as
    /// an ordinary copy, is pasted, and stays.
    #[test]
    fn a_paste_into_a_remote_session_leaves_the_dictation_on_the_clipboard() {
        let mut ledger = RestoreLedger::default();
        let mut board = Board::holding("https://example.com");
        let done = insert(&mut ledger, &mut board, "遠端", None, true, || true).unwrap();
        assert_eq!(
            done,
            Inserted {
                pasted: true,
                restore: None
            }
        );
        assert_eq!(board.text, "遠端");
        assert!(!board.transient, "the remote sync must not skip it");
        assert_eq!(board.snapshots, 0, "nothing to save when nothing is restored");
    }
}
