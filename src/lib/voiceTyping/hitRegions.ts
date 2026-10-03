//! Where the voice-typing overlay draws, as the native side needs to know it.
//!
//! The overlay is a transparent 460×180 window, and transparent webview pixels
//! still catch clicks — so the rest of that rectangle used to swallow every
//! click on whatever sat behind it. The overlay now reports the boxes of its
//! visible blocks (anything marked `data-overlay-hit`), and a native poller
//! lets clicks through everywhere else (see `start_hit_poller` in
//! src-tauri/src/voice_typing.rs).
//!
//! The boxes travel as fractions of the viewport rather than pixels. The
//! webview measures CSS px under whatever page zoom; the native side reads
//! Cocoa points (macOS) or physical px (Windows). A fraction means the same
//! thing to both, at any zoom and on any display's scale factor.

/** One hit block: viewport fractions in 0..1, origin at the top-left. */
export type HitRect = { x: number; y: number; w: number; h: number };

/** A measured box in CSS px — what `getBoundingClientRect()` returns. */
export type HitBox = { left: number; top: number; width: number; height: number };

/** Slack around each block, in CSS px, so a click on a block's very edge (or
 *  its shadow) lands on it rather than falling through to the app behind. */
export const HIT_PAD_PX = 4;

/** Two reports closer than this are the same layout (float noise from a
 *  sub-pixel re-layout should not cost an IPC round-trip). */
const SAME_EPSILON = 1e-4;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

/**
 * Convert measured boxes into padded viewport fractions. Boxes with no area
 * (an element not laid out, or `display: none`) or that fall outside the
 * viewport are dropped; the rest are clamped to the viewport and rounded to
 * four decimals — well under a pixel at the overlay's size.
 */
export function toHitRects(
  boxes: ReadonlyArray<HitBox>,
  viewport: { width: number; height: number },
  pad: number = HIT_PAD_PX,
): HitRect[] {
  const { width, height } = viewport;
  if (!(width > 0 && height > 0)) return [];
  const rects: HitRect[] = [];
  for (const b of boxes) {
    if (![b.left, b.top, b.width, b.height].every(Number.isFinite)) continue;
    if (b.width <= 0 || b.height <= 0) continue;
    const x = round4(clamp01((b.left - pad) / width));
    const y = round4(clamp01((b.top - pad) / height));
    const right = round4(clamp01((b.left + b.width + pad) / width));
    const bottom = round4(clamp01((b.top + b.height + pad) / height));
    const w = round4(right - x);
    const h = round4(bottom - y);
    if (w <= 0 || h <= 0) continue;
    rects.push({ x, y, w, h });
  }
  return rects;
}

/** Whether two reports describe the same layout, block for block. */
export function sameHitRects(a: ReadonlyArray<HitRect>, b: ReadonlyArray<HitRect>): boolean {
  if (a.length !== b.length) return false;
  return a.every((r, i) => {
    const s = b[i];
    return (
      Math.abs(r.x - s.x) < SAME_EPSILON &&
      Math.abs(r.y - s.y) < SAME_EPSILON &&
      Math.abs(r.w - s.w) < SAME_EPSILON &&
      Math.abs(r.h - s.h) < SAME_EPSILON
    );
  });
}

/**
 * Whether the viewport fraction `(fx, fy)` lands on a block: half-open on
 * every edge, and never for a point off the viewport or not a number. This is
 * the test the native poller runs (`over_hit_rect` in voice_typing.rs); it is
 * spelled out here so the contract the overlay reports against is pinned by a
 * test on this side too.
 */
export function hitAt(rects: ReadonlyArray<HitRect>, fx: number, fy: number): boolean {
  if (!(fx >= 0 && fx < 1 && fy >= 0 && fy < 1)) return false;
  return rects.some((r) => fx >= r.x && fx < r.x + r.w && fy >= r.y && fy < r.y + r.h);
}
