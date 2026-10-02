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
//! in which case that newer content is the user's and is left alone.
//!
//! When no paste can be posted (macOS without Accessibility, Parley itself in
//! front, Windows refusing the injection) the clipboard IS the delivery: the
//! text goes there as an ordinary copy and stays, and the overlay names the
//! paste key. Explicit copies (the overlay's Copy, Esc's Undo) are never
//! restored over.
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
/// before most people would paste again.
const CLIPBOARD_RESTORE_DELAY: Duration = Duration::from_millis(1000);

/// A snapshot slower than this is logged: on both platforms reading a format
/// can make the app that copied it render that format on the spot.
const SLOW_SNAPSHOT: Duration = Duration::from_millis(50);

/// The clipboard operations an insert needs: the system clipboard on each
/// platform, a fake in the tests.
pub(super) trait Pasteboard {
    /// Everything on the clipboard, as faithfully as the platform allows.
    type Snapshot;

    /// Save what is on the clipboard now. Empty when there is nothing to save
    /// — or nothing we should (a password manager's concealed entry).
    fn snapshot(&mut self) -> Result<Self::Snapshot, String>;

    /// Replace the clipboard with `text`, marked so clipboard managers and
    /// the OS clipboard history skip it: it is only there for the paste.
    fn write_transient(&mut self, text: &str) -> Result<(), String>;

    /// Replace the clipboard with `text` as an ordinary copy.
    fn write_plain(&mut self, text: &str) -> Result<(), String>;

    /// The clipboard's change counter (macOS `changeCount`, Windows
    /// `GetClipboardSequenceNumber`): it moves on every write, ours or not.
    fn change_mark(&mut self) -> i64;

    /// Replace the clipboard with `snapshot` (an empty one clears it).
    fn restore(&mut self, snapshot: &Self::Snapshot) -> Result<(), String>;
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
    /// land on it. Returns that restore's snapshot: the user's clipboard from
    /// before the dictation whose text is still on it.
    fn supersede(&mut self) -> Option<S> {
        self.generation += 1;
        self.pending.take().map(|p| p.snapshot)
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

    /// The restore timer for `generation` fired: its snapshot and mark, or
    /// None when an insert or a copy has superseded it since.
    fn take_due(&mut self, generation: u64) -> Option<(S, i64)> {
        if self.pending.as_ref()?.generation != generation {
            return None;
        }
        self.pending.take().map(|p| (p.snapshot, p.mark))
    }
}

/// Why an insert posted no paste and left the text on the clipboard instead.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Blocked {
    /// macOS: a synthetic ⌘V needs Accessibility, and it is not granted.
    Accessibility,
    /// Parley itself is the frontmost app, so a paste would go to one of its
    /// own windows rather than the app the user is dictating into. Decided
    /// before the paste, not after: a paste followed by a restore would take
    /// the text back off the clipboard, which is where the user is about to
    /// be told to find it.
    Parley,
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

/// Put `text` into the focused field through the clipboard, via `paste`
/// (which posts the chord and says whether it went out). Runs with the ledger
/// locked, so neither the restore timer nor an explicit copy can interleave.
pub(super) fn insert<P: Pasteboard>(
    ledger: &mut RestoreLedger<P::Snapshot>,
    pb: &mut P,
    text: &str,
    blocked: Option<Blocked>,
    paste: impl FnOnce() -> bool,
) -> Result<Inserted, String> {
    // Whatever happens next replaces the clipboard, so a restore still
    // pending from the last dictation must not land on top of it. Its
    // snapshot is the user's clipboard from before THAT dictation — exactly
    // what this one has to give back too. Saving the clipboard now would save
    // the last dictation's text instead, and two quick dictations would leave
    // the first one on the clipboard.
    let earlier = ledger.supersede();
    if let Some(why) = blocked {
        log::info!("voice-typing: no paste ({why:?}); the dictation stays on the clipboard");
        pb.write_plain(text)?;
        return Ok(Inserted {
            pasted: false,
            restore: None,
        });
    }
    let snapshot = match earlier {
        Some(snapshot) => Some(snapshot),
        None => {
            let started = Instant::now();
            let saved = pb.snapshot();
            if started.elapsed() >= SLOW_SNAPSHOT {
                log::info!(
                    "voice-typing: saving the clipboard took {}ms",
                    started.elapsed().as_millis()
                );
            }
            match saved {
                Ok(snapshot) => Some(snapshot),
                Err(e) => {
                    // Still paste: the dictation matters more than the
                    // clipboard, which then simply keeps the text, as it
                    // always used to.
                    log::warn!(
                        "voice-typing: could not save the clipboard; it keeps the dictation: {e}"
                    );
                    None
                }
            }
        }
    };
    if let Err(e) = pb.write_transient(text) {
        // The write can fail after clearing the clipboard: put back what we
        // can before reporting it.
        if let Some(snapshot) = &snapshot {
            if let Err(restore) = pb.restore(snapshot) {
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
    /// The clipboard could not be written; it still holds the dictation.
    Failed(String),
}

/// The restore timer for `generation` fired.
pub(super) fn restore_due<P: Pasteboard>(
    ledger: &mut RestoreLedger<P::Snapshot>,
    pb: &mut P,
    generation: u64,
) -> RestoreOutcome {
    let Some((snapshot, mark)) = ledger.take_due(generation) else {
        return RestoreOutcome::Superseded;
    };
    // Not atomic with the write below — no clipboard API offers that — but
    // the gap is microseconds; the one that matters is the second before it.
    if pb.change_mark() != mark {
        return RestoreOutcome::ClipboardMoved;
    }
    match pb.restore(&snapshot) {
        Ok(()) => RestoreOutcome::Restored,
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
/// insert that armed `generation` is still the latest word on it.
pub(super) fn schedule_restore(app: &AppHandle, generation: u64) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CLIPBOARD_RESTORE_DELAY).await;
        let job_app = app.clone();
        let job = move || {
            let state = job_app.state::<ClipboardState>();
            let outcome = restore_due(&mut state.lock(), &mut SystemPasteboard, generation);
            match outcome {
                RestoreOutcome::Restored => log::info!("voice-typing: clipboard restored"),
                RestoreOutcome::ClipboardMoved => {
                    log::info!("voice-typing: clipboard changed after the paste; left as it is")
                }
                RestoreOutcome::Superseded => {}
                RestoreOutcome::Failed(e) => {
                    log::warn!("voice-typing: clipboard restore failed: {e}")
                }
            }
        };
        // AppKit wants the pasteboard on the main thread, where the insert
        // and the copies already run. The Win32 clipboard only needs one
        // thread to open and close it, and holding the main thread for a busy
        // clipboard's retries would stall every window.
        #[cfg(target_os = "macos")]
        if app.run_on_main_thread(job).is_err() {
            log::warn!("voice-typing: clipboard restore skipped: the event loop is gone");
        }
        #[cfg(not(target_os = "macos"))]
        if let Err(e) = tauri::async_runtime::spawn_blocking(job).await {
            log::warn!("voice-typing: clipboard restore did not run: {e}");
        }
    });
}

/// Whether a Win32 clipboard format holds a plain memory block (HGLOBAL)
/// that can be copied out byte for byte and handed back later. GDI objects
/// and owner-chosen handles cannot: copying one copies a handle that the
/// clipboard frees when it is emptied. Skipping them costs little — CF_BITMAP
/// comes back synthesized from CF_DIB, and nearly every app that puts a GDI
/// format up also puts up a memory-block one.
#[cfg(any(target_os = "windows", test))]
fn is_restorable_format(format: u32) -> bool {
    !matches!(
        format,
        // No format.
        0
        // CF_BITMAP, CF_PALETTE and CF_ENHMETAFILE are GDI objects; a
        // CF_METAFILEPICT block holds a metafile handle.
        | 2 | 3 | 9 | 14
        // CF_OWNERDISPLAY (the owner paints it; no data) and the private
        // display twins of the GDI formats.
        | 0x0080 | 0x0082 | 0x0083 | 0x008E
        // CF_PRIVATEFIRST..=CF_PRIVATELAST (whatever handle the owner chose)
        // and CF_GDIOBJFIRST..=CF_GDIOBJLAST (GDI objects).
        | 0x0200..=0x03FF
    )
}

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

        fn restore(&mut self, _snapshot: &()) -> Result<(), String> {
            Err(UNSUPPORTED.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        copy, insert, is_concealed, is_restorable_format, restore_due, Blocked, Inserted,
        Pasteboard, RestoreLedger, RestoreOutcome,
    };

    /// A clipboard holding one string, with a change mark that moves on every
    /// write like the real ones.
    #[derive(Default)]
    struct Board {
        text: String,
        transient: bool,
        mark: i64,
        fail_snapshot: bool,
        fail_write: bool,
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

        fn restore(&mut self, snapshot: &String) -> Result<(), String> {
            self.mark += 1;
            self.text = snapshot.clone();
            self.transient = false;
            Ok(())
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

        let done = insert(&mut ledger, &mut board, "你好", None, || {
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
        let first = insert(&mut ledger, &mut board, "第一句", None, || true).unwrap();
        let second = insert(&mut ledger, &mut board, "第二句", None, || true).unwrap();
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
    fn an_explicit_copy_calls_off_a_pending_restore() {
        let mut ledger = RestoreLedger::default();
        let mut board = Board::holding("old");
        let done = insert(&mut ledger, &mut board, "說的話", None, || true).unwrap();

        copy(&mut ledger, &mut board, "說的話").unwrap();
        assert!(!board.transient);
        assert_eq!(
            restore_due(&mut ledger, &mut board, done.restore.unwrap()),
            RestoreOutcome::Superseded
        );
        assert_eq!(board.text, "說的話");

        // The copy is the user's clipboard now: the next insert saves it.
        let next = insert(&mut ledger, &mut board, "下一句", None, || true).unwrap();
        restore_due(&mut ledger, &mut board, next.restore.unwrap());
        assert_eq!(board.text, "說的話");
    }

    #[test]
    fn a_copy_made_after_the_paste_is_never_restored_over() {
        let mut ledger = RestoreLedger::default();
        let mut board = Board::holding("old");
        let done = insert(&mut ledger, &mut board, "dictated", None, || true).unwrap();

        board.copied_elsewhere("copied during the second");
        assert_eq!(
            restore_due(&mut ledger, &mut board, done.restore.unwrap()),
            RestoreOutcome::ClipboardMoved
        );
        assert_eq!(board.text, "copied during the second");

        // Nothing is left pending: the next insert saves the new copy.
        let next = insert(&mut ledger, &mut board, "again", None, || true).unwrap();
        restore_due(&mut ledger, &mut board, next.restore.unwrap());
        assert_eq!(board.text, "copied during the second");
    }

    #[test]
    fn a_blocked_insert_posts_nothing_and_leaves_a_plain_copy() {
        for why in [Blocked::Accessibility, Blocked::Parley] {
            let mut ledger = RestoreLedger::default();
            let mut board = Board::holding("old");
            // A restore pending from an earlier dictation…
            let earlier = insert(&mut ledger, &mut board, "earlier", None, || true).unwrap();

            let done = insert(&mut ledger, &mut board, "dictated", Some(why), || {
                panic!("no paste may be posted")
            })
            .unwrap();
            assert_eq!(done, not_pasted());
            assert_eq!(board.text, "dictated");
            assert!(!board.transient);
            // …must not take the delivery off the clipboard.
            assert_eq!(
                restore_due(&mut ledger, &mut board, earlier.restore.unwrap()),
                RestoreOutcome::Superseded
            );
            assert_eq!(board.text, "dictated");
        }
    }

    #[test]
    fn a_refused_paste_leaves_the_text_as_a_plain_copy_with_nothing_pending() {
        let mut ledger = RestoreLedger::default();
        let mut board = Board::holding("old");
        let done = insert(&mut ledger, &mut board, "dictated", None, || false).unwrap();
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
        let done = insert(&mut ledger, &mut board, "dictated", None, || true).unwrap();
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
        let result = insert(&mut ledger, &mut board, "dictated", None, || {
            panic!("no paste may be posted")
        });
        assert!(result.is_err());
        assert_eq!(board.text, "old");
        assert!(ledger.pending.is_none());
    }

    #[test]
    fn only_memory_block_formats_are_saved() {
        // CF_TEXT, CF_DIB, CF_UNICODETEXT, CF_HDROP, CF_LOCALE, CF_DIBV5,
        // CF_DSPTEXT and registered formats ("HTML Format", "PNG", …).
        for format in [1, 7, 8, 13, 15, 16, 17, 0x0081, 0xC000, 0xC1F3, 0xFFFF] {
            assert!(is_restorable_format(format), "{format:#x}");
        }
        // Nothing, GDI objects, a metafile handle, owner-display and the
        // private / GDI-object ranges.
        for format in [
            0, 2, 3, 9, 14, 0x0080, 0x0082, 0x0083, 0x008E, 0x0200, 0x02FF, 0x0300, 0x03FF,
        ] {
            assert!(!is_restorable_format(format), "{format:#x}");
        }
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
}
