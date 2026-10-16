//! Overlay click-through: the blocks the overlay draws catch clicks, the rest
//! of its window passes them to whatever is behind it.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, State};

use super::imp;
use super::overlay::overlay_handle;

// ── Click-through ───────────────────────────────────────────────────────────
//
// The overlay is a transparent 460×180 window, but what it draws — the pill,
// the transcript, a suggestion bubble — covers a fraction of that. Transparent
// webview pixels are not click-through at the window-server level, so the rest
// of the rectangle was a dead zone over whatever sat behind it (and on macOS,
// before the panel stopped activating Parley, a click there brought Parley
// forward). The webview reports where its blocks are; while the overlay is up
// a poller compares the cursor with them and makes the window ignore the mouse
// everywhere else. It fails open: with no report, the whole window is
// click-through. macOS only for now; Windows keeps the dead zone until its
// toggle is checked on hardware (see the Windows `imp::CLICK_THROUGH`).

/// One block of the overlay that catches clicks, as fractions (0..1) of the
/// overlay's viewport with the origin at its top-left — what `toHitRects`
/// (src/lib/voiceTyping/hitRegions.ts) reports. Fractions keep both sides out
/// of unit conversions: the webview measures CSS px under any page zoom, the
/// native side Cocoa points or physical px, and only a ratio means the same
/// thing to both — whatever the display's scale factor.
#[derive(serde::Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct HitRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl HitRect {
    fn is_finite(&self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.w.is_finite() && self.h.is_finite()
    }
}

/// Well past the handful of blocks the overlay ever shows at once; a bound so
/// a runaway report cannot lengthen every poll tick.
const MAX_HIT_RECTS: usize = 16;

/// How often the cursor is checked while the overlay is up. A flip is at most
/// this late, which is shorter than any deliberate move-and-click; each tick is
/// a few microseconds on the main thread.
const OVERLAY_HIT_POLL: Duration = Duration::from_millis(33);

/// Which hit poller is the live one. Every present begins a new generation and
/// a dismiss ends the current one, so an older poller — and any tick it has
/// already queued on the main thread — can tell it is stale.
#[derive(Default)]
pub(super) struct HitPoller(AtomicU64);

impl HitPoller {
    fn begin(&self) -> u64 {
        self.0.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn is_current(&self, generation: u64) -> bool {
        self.0.load(Ordering::SeqCst) == generation
    }

    pub(super) fn stop(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

/// The rects the overlay reported last, and which report they came from.
///
/// Reports can arrive out of order: the command is async, and Tauri runs each
/// async invoke as its own task on a multi-threaded runtime, so of two reports
/// sent a frame apart the older one can be the last to store. The webview only
/// sends a layout that changed — and the waveform re-renders the same one many
/// times a second — so it would never send the newer layout again, and clicks
/// would go by a stale one (a visible block passing them through, a vanished
/// one catching them) until a block moved. Each report is numbered, and an
/// older one than what is held is dropped.
#[derive(Default)]
struct HitReport {
    /// Which load of the overlay page sent it (a random id per load). A
    /// reloaded page counts its reports from 1 again, so its numbers are not
    /// comparable with the last page's — a report from a new page is always
    /// taken, rather than ignored until its count passes the old one.
    page: u32,
    /// That page's running count of reports.
    seq: u64,
    rects: Vec<HitRect>,
}

impl HitReport {
    /// Take a report unless it is older than the one held; true when taken.
    fn apply(&mut self, page: u32, seq: u64, rects: Vec<HitRect>) -> bool {
        if page == self.page && seq < self.seq {
            return false;
        }
        *self = HitReport {
            page,
            seq,
            rects: sanitize_hit_rects(rects),
        };
        true
    }
}

/// The overlay's reported hit rects and the poller that applies them.
#[derive(Default)]
pub struct OverlayHitState {
    /// The order check and the store happen under this one lock, so two
    /// reports cannot both pass the check and then store in the wrong order.
    report: Mutex<HitReport>,
    pub(super) poller: HitPoller,
    /// A tick is queued on the main thread and has not run yet. The poller
    /// skips a tick rather than stack a second one behind a busy main thread.
    tick_pending: AtomicBool,
}

/// Whether the overlay-relative point `(fx, fy)` falls on a reported block.
/// Half-open on every edge, like `hitAt` in hitRegions.ts. Anything off the
/// window — or not a number — is not a hit, so the window passes the click on.
fn over_hit_rect(rects: &[HitRect], fx: f64, fy: f64) -> bool {
    if !(0.0..1.0).contains(&fx) || !(0.0..1.0).contains(&fy) {
        return false;
    }
    rects
        .iter()
        .any(|r| fx >= r.x && fx < r.x + r.w && fy >= r.y && fy < r.y + r.h)
}

/// The cursor as a fraction of the window, from Cocoa's global coordinates:
/// points (no scale factor, so a mixed-DPI desktop is fine) with the origin at
/// the BOTTOM-left, hence the flip into the overlay's top-left fractions.
#[cfg(any(target_os = "macos", test))]
pub(super) fn fraction_bottom_left(
    mouse: (f64, f64),
    origin: (f64, f64),
    size: (f64, f64),
) -> Option<(f64, f64)> {
    let (w, h) = size;
    if w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0 {
        Some(((mouse.0 - origin.0) / w, (origin.1 + h - mouse.1) / h))
    } else {
        None
    }
}

/// The cursor as a fraction of the window, from Win32's screen coordinates:
/// physical px with the origin at the top-left.
#[cfg(any(target_os = "windows", test))]
pub(super) fn fraction_top_left(
    cursor: (f64, f64),
    origin: (f64, f64),
    size: (f64, f64),
) -> Option<(f64, f64)> {
    let (w, h) = size;
    if w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0 {
        Some(((cursor.0 - origin.0) / w, (cursor.1 - origin.1) / h))
    } else {
        None
    }
}

/// What a report keeps: finite rects only, at most MAX_HIT_RECTS of them.
fn sanitize_hit_rects(rects: Vec<HitRect>) -> Vec<HitRect> {
    rects
        .into_iter()
        .filter(HitRect::is_finite)
        .take(MAX_HIT_RECTS)
        .collect()
}

/// The overlay reports where its visible blocks are, whenever that changes.
/// Async so it runs off the main thread: the transcript bubble grows with every
/// few words, and a synchronous command would queue each report there. Which
/// is also why reports can land out of order, and carry `page` and `seq` (see
/// `HitReport`). The rects are kept across a dismiss — the webview owns them,
/// and it has already reported none by the time a done confirmation fades out.
#[tauri::command]
pub async fn set_voice_overlay_hit_rects(
    state: State<'_, OverlayHitState>,
    rects: Vec<HitRect>,
    page: u32,
    seq: u64,
) -> Result<(), String> {
    state.report.lock().unwrap().apply(page, seq, rects);
    Ok(())
}

/// Poll the cursor against the hit rects until the overlay is dismissed or
/// presented again, turning the window's mouse capture on over a block and off
/// everywhere else. Natively, rather than from the webview with Tauri's
/// `setIgnoreCursorEvents`: the cursor position the webview can get is scaled
/// by the PRIMARY display's factor (off by 2× on a Retina laptop next to a 1×
/// screen), and on Windows tao's setter rewrites the window's styles and hides
/// it (see the Windows `imp::present_overlay`).
pub(super) fn start_hit_poller(app: &AppHandle) {
    if !imp::CLICK_THROUGH {
        return;
    }
    let generation = app.state::<OverlayHitState>().poller.begin();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(OVERLAY_HIT_POLL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            let state = app.state::<OverlayHitState>();
            if !state.poller.is_current(generation) {
                break;
            }
            if state.tick_pending.swap(true, Ordering::SeqCst) {
                continue;
            }
            let main = app.clone();
            if app
                .run_on_main_thread(move || hit_tick(&main, generation))
                .is_err()
            {
                // The event loop is gone; nothing left to poll for.
                state.tick_pending.store(false, Ordering::SeqCst);
                break;
            }
        }
    });
}

/// One poll, on the main thread (where AppKit wants the window touched).
fn hit_tick(app: &AppHandle, generation: u64) {
    let state = app.state::<OverlayHitState>();
    state.tick_pending.store(false, Ordering::SeqCst);
    // Queued before a dismiss, or before the next present's poller took over:
    // the window is no longer this tick's to change.
    if !state.poller.is_current(generation) {
        return;
    }
    let Some(handle) = overlay_handle(app) else {
        return;
    };
    let over = imp::cursor_fraction(handle)
        .is_some_and(|(fx, fy)| over_hit_rect(&state.report.lock().unwrap().rects, fx, fy));
    // Against the window's real state, not a remembered one: anything that
    // rewrites it behind our back would leave a cached flag saying
    // "click-through" over a window that is catching clicks.
    if imp::is_pass_through(handle) == over {
        imp::set_pass_through(handle, !over);
    }
}

#[cfg(test)]
mod overlay_hit_tests {
    use super::{
        fraction_bottom_left, fraction_top_left, over_hit_rect, sanitize_hit_rects, HitPoller,
        HitRect, HitReport, MAX_HIT_RECTS,
    };

    fn rect(x: f64, y: f64, w: f64, h: f64) -> HitRect {
        HitRect { x, y, w, h }
    }

    fn close(a: Option<(f64, f64)>, b: (f64, f64)) -> bool {
        a.is_some_and(|(x, y)| (x - b.0).abs() < 1e-9 && (y - b.1).abs() < 1e-9)
    }

    /// The pill: centred, near the bottom of the 460×180 overlay.
    const PILL: (f64, f64, f64, f64) = (0.36, 0.7, 0.28, 0.2);

    #[test]
    fn a_point_on_a_block_is_a_hit_and_anywhere_else_passes_through() {
        let (x, y, w, h) = PILL;
        let rects = [rect(x, y, w, h)];
        assert!(over_hit_rect(&rects, 0.5, 0.8));
        assert!(!over_hit_rect(&rects, 0.1, 0.8), "beside the pill");
        assert!(!over_hit_rect(&rects, 0.5, 0.2), "above the pill");
    }

    #[test]
    fn edges_are_half_open_like_hit_at() {
        let rects = [rect(0.25, 0.5, 0.5, 0.25)];
        assert!(over_hit_rect(&rects, 0.25, 0.5), "left/top edge is inside");
        assert!(!over_hit_rect(&rects, 0.75, 0.6), "right edge is outside");
        assert!(!over_hit_rect(&rects, 0.5, 0.75), "bottom edge is outside");
    }

    #[test]
    fn no_report_means_the_whole_window_passes_clicks_through() {
        assert!(!over_hit_rect(&[], 0.5, 0.5));
    }

    #[test]
    fn a_cursor_off_the_window_or_not_a_number_is_never_a_hit() {
        let rects = [rect(0.0, 0.0, 1.0, 1.0)];
        assert!(over_hit_rect(&rects, 0.0, 0.0));
        for (fx, fy) in [
            (-0.01, 0.5),
            (0.5, -0.01),
            (1.0, 0.5),
            (0.5, 1.0),
            (f64::NAN, 0.5),
            (0.5, f64::NAN),
            (f64::INFINITY, 0.5),
            (0.5, f64::NEG_INFINITY),
        ] {
            assert!(!over_hit_rect(&rects, fx, fy), "({fx}, {fy})");
        }
    }

    #[test]
    fn cocoa_coordinates_flip_to_a_top_left_fraction() {
        // A 460×180 overlay whose frame starts at (100, 50), bottom-left origin.
        let at = |mouse| fraction_bottom_left(mouse, (100.0, 50.0), (460.0, 180.0));
        // The frame's TOP-left corner is (100, 50 + 180) in Cocoa.
        assert!(close(at((100.0, 230.0)), (0.0, 0.0)));
        // Its bottom-right corner.
        assert!(close(at((560.0, 50.0)), (1.0, 1.0)));
        // A point 45 pt up from the bottom edge sits at 3/4 of the height.
        assert!(close(at((330.0, 95.0)), (0.5, 0.75)));
    }

    #[test]
    fn cocoa_fractions_hold_on_a_display_left_of_or_below_the_primary() {
        let at = |mouse| fraction_bottom_left(mouse, (-1700.0, -900.0), (460.0, 180.0));
        assert!(close(at((-1470.0, -810.0)), (0.5, 0.5)));
    }

    #[test]
    fn windows_coordinates_are_already_top_left() {
        // 460×180 at 200 %, in physical px.
        let at = |cursor| fraction_top_left(cursor, (730.0, 836.0), (920.0, 360.0));
        assert!(close(at((730.0, 836.0)), (0.0, 0.0)));
        assert!(close(at((1190.0, 1106.0)), (0.5, 0.75)));
        // A monitor left of the primary has negative physical coordinates.
        let left = |cursor| fraction_top_left(cursor, (-1690.0, 836.0), (920.0, 360.0));
        assert!(close(left((-1230.0, 1016.0)), (0.5, 0.5)));
    }

    #[test]
    fn a_window_without_a_size_gives_no_fraction() {
        for size in [
            (0.0, 180.0),
            (460.0, 0.0),
            (f64::NAN, 180.0),
            (460.0, f64::INFINITY),
        ] {
            assert!(fraction_bottom_left((1.0, 1.0), (0.0, 0.0), size).is_none());
            assert!(fraction_top_left((1.0, 1.0), (0.0, 0.0), size).is_none());
        }
    }

    #[test]
    fn hit_rects_deserialize_from_what_the_overlay_sends() {
        let rects: Vec<HitRect> =
            serde_json::from_str(r#"[{"x":0.1,"y":0.8,"w":0.3,"h":0.2}]"#).unwrap();
        assert_eq!(rects, vec![rect(0.1, 0.8, 0.3, 0.2)]);
    }

    #[test]
    fn a_report_keeps_finite_rects_and_at_most_the_cap() {
        let kept = sanitize_hit_rects(vec![
            rect(f64::NAN, 0.0, 0.1, 0.1),
            rect(0.1, 0.2, 0.3, 0.4),
            rect(0.0, 0.0, f64::INFINITY, 0.1),
        ]);
        assert_eq!(kept, vec![rect(0.1, 0.2, 0.3, 0.4)]);

        let many = vec![rect(0.0, 0.0, 0.1, 0.1); MAX_HIT_RECTS + 5];
        assert_eq!(sanitize_hit_rects(many).len(), MAX_HIT_RECTS);
    }

    #[test]
    fn an_older_report_landing_last_does_not_replace_the_newer_layout() {
        let bubble = vec![rect(0.1, 0.3, 0.8, 0.4)];
        let done = vec![rect(0.1, 0.2, 0.8, 0.4), rect(0.3, 0.7, 0.4, 0.15)];
        let mut held = HitReport::default();
        // The newer report's task stores first…
        assert!(held.apply(7, 2, done.clone()));
        // …and the older one, run late on another worker, is dropped.
        assert!(!held.apply(7, 1, bubble.clone()));
        assert_eq!(held.rects, done);
        // The next report from the same page is taken as usual.
        assert!(held.apply(7, 3, bubble.clone()));
        assert_eq!(held.rects, bubble);
    }

    #[test]
    fn a_reloaded_overlay_page_is_heard_although_it_counts_from_one_again() {
        let mut held = HitReport::default();
        assert!(held.apply(7, 500, vec![rect(0.1, 0.3, 0.8, 0.4)]));
        // A new page id: its count starts over, and it still wins.
        assert!(held.apply(9, 1, vec![]));
        assert_eq!(held.rects, vec![]);
        assert!(held.apply(9, 2, vec![rect(0.3, 0.7, 0.4, 0.15)]));
        assert_eq!((held.page, held.seq), (9, 2));
    }

    #[test]
    fn the_first_report_is_taken_and_kept_sanitized() {
        let mut held = HitReport::default();
        assert!(held.apply(
            0,
            1,
            vec![rect(f64::NAN, 0.0, 0.1, 0.1), rect(0.1, 0.2, 0.3, 0.4)]
        ));
        assert_eq!(held.rects, vec![rect(0.1, 0.2, 0.3, 0.4)]);
    }

    #[test]
    fn a_dismiss_or_the_next_present_makes_an_older_poller_stale() {
        let poller = HitPoller::default();
        let first = poller.begin();
        assert!(poller.is_current(first));

        // Dismiss: the poller, and any tick it already queued, stand down.
        poller.stop();
        assert!(!poller.is_current(first));

        // The next present takes over; the old generation stays stale.
        let second = poller.begin();
        assert!(poller.is_current(second));
        assert!(!poller.is_current(first));

        // A present while one is still running replaces it outright.
        let third = poller.begin();
        assert!(poller.is_current(third));
        assert!(!poller.is_current(second));
    }
}
