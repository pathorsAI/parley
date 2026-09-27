/**
 * Motion for the first lap. The CSS half (keyframes, transitions, the
 * reduced-motion override) lives in ONE block in src/index.css, marked
 * "onboarding motion". This module is the script half: the Web Animations
 * API pieces that need measured positions (a card flying into a sidebar row,
 * the lap's confetti), a typewriter hook, and two tiny window events that let
 * one component poke another without prop-drilling through the shell.
 *
 * Every function here checks `prefersReducedMotion()` and jumps straight to
 * the end state when it is set.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** The one easing curve onboarding motion uses (mirrors --ob-ease in index.css). */
export const OB_EASE = "cubic-bezier(.2,.8,.2,1)";

/** Typing speed for the typewriter moments. */
export const TYPE_MS_PER_CHAR = 22;

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

// ── Folder row pulse ─────────────────────────────────────────────────────────

const PULSE_FOLDER_EVENT = "parley:pulse-folder";
export const FOLDER_PULSE_MS = 500;

/** Flash a folder's sidebar row once (the row listens via {@link usePulsingFolder}). */
export function pulseFolder(folderId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(PULSE_FOLDER_EVENT, { detail: folderId }));
}

/** The folder id whose row should be flashing right now, or null. */
export function usePulsingFolder(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onPulse = (e: Event) => {
      const next = (e as CustomEvent<string>).detail;
      clearTimeout(timer);
      // Re-trigger the CSS animation even for the same row: drop, then set.
      setId(null);
      requestAnimationFrame(() => setId(next));
      timer = setTimeout(() => setId(null), FOLDER_PULSE_MS + 50);
    };
    window.addEventListener(PULSE_FOLDER_EVENT, onPulse);
    return () => {
      window.removeEventListener(PULSE_FOLDER_EVENT, onPulse);
      clearTimeout(timer);
    };
  }, []);
  return id;
}

// ── Transcript seek → scrubber ───────────────────────────────────────────────

const TRANSCRIPT_SEEK_EVENT = "parley:transcript-seek";

/** A transcript line was clicked; the replay scrubber eases its playhead there
 *  and drops a ripple. Emit BEFORE the seek lands so the easing is in place. */
export function emitTranscriptSeek(ms: number): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<number>(TRANSCRIPT_SEEK_EVENT, { detail: ms }));
}

export function onTranscriptSeek(handler: (ms: number) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<number>).detail);
  window.addEventListener(TRANSCRIPT_SEEK_EVENT, listener);
  return () => window.removeEventListener(TRANSCRIPT_SEEK_EVENT, listener);
}

// ── Typewriter ───────────────────────────────────────────────────────────────

/**
 * `text` typed out from the first character at `msPerChar`, or all of it at
 * once when `enabled` is false, on the server, or under reduced motion. It
 * types ONCE: after the first run finishes (or is switched off), later
 * changes to `text` — an edit, say — show in full straight away.
 */
export function useTypewriter(text: string, enabled: boolean, msPerChar = TYPE_MS_PER_CHAR): string {
  const animate = enabled && typeof window !== "undefined" && !prefersReducedMotion();
  const [count, setCount] = useState(() => (animate ? 0 : Number.POSITIVE_INFINITY));
  const started = useRef(false);
  const spent = useRef(false);
  // Layout effect: a restart must blank the text before the browser paints it.
  useLayoutEffect(() => {
    if (!animate || spent.current) {
      if (started.current) spent.current = true;
      setCount(Number.POSITIVE_INFINITY);
      return;
    }
    started.current = true;
    setCount(0);
    const t0 = performance.now();
    const id = setInterval(() => {
      const n = Math.floor((performance.now() - t0) / msPerChar) + 1;
      setCount(n);
      if (n >= text.length) {
        clearInterval(id);
        spent.current = true;
      }
    }, msPerChar);
    return () => clearInterval(id);
  }, [text, animate, msPerChar]);
  return text.slice(0, count);
}

// ── A card flying into a sidebar row ─────────────────────────────────────────

export const FLY_MS = 700;

/** Resolve an element on a later frame (a just-created folder's row renders
 *  after the folder registry broadcast lands). Null after ~`frames` frames. */
function findSoon(selector: string, frames = 20): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const tick = (left: number) => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el && el.getBoundingClientRect().width > 0) resolve(el);
      else if (left <= 0) resolve(null);
      else requestAnimationFrame(() => tick(left - 1));
    };
    tick(frames);
  });
}

/**
 * Lift a copy of `source` off the page and fly it into the sidebar row of
 * `folderId` (shrinking as it goes), then flash that row. With the sidebar
 * hidden it just scales and fades where it is. The copy is fixed-position on
 * top of everything, so the real element can unmount the moment this starts.
 */
export async function flyToFolder(source: HTMLElement | null, folderId: string): Promise<void> {
  if (!source || prefersReducedMotion()) {
    pulseFolder(folderId);
    return;
  }
  const from = source.getBoundingClientRect();
  const ghost = source.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("id");
  Object.assign(ghost.style, {
    position: "fixed",
    left: `${from.left}px`,
    top: `${from.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
    margin: "0",
    zIndex: "60",
    pointerEvents: "none",
    transformOrigin: "top left",
    background: "var(--background)",
    borderRadius: "8px",
    overflow: "hidden",
  });
  document.body.appendChild(ghost);
  try {
    const row = await findSoon(`[data-folder-row="${CSS.escape(folderId)}"]`);
    let keyframes: Keyframe[];
    if (row) {
      const to = row.getBoundingClientRect();
      const scale = Math.max(0.08, Math.min(1, to.width / from.width));
      const dx = to.left - from.left;
      const dy = to.top + to.height / 2 - from.top - (from.height * scale) / 2;
      keyframes = [
        { transform: "translate(0, 0) scale(1)", opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0.2 },
      ];
    } else {
      keyframes = [
        { transform: "scale(1)", opacity: 1 },
        { transform: "scale(0.92)", opacity: 0 },
      ];
    }
    await ghost.animate(keyframes, { duration: FLY_MS, easing: OB_EASE, fill: "forwards" }).finished;
  } catch {
    /* animation interrupted — nothing to recover */
  } finally {
    ghost.remove();
    pulseFolder(folderId);
  }
}

// ── The lap's one confetti burst ─────────────────────────────────────────────

export const CONFETTI_MS = 1500;
export const CONFETTI_COUNT = 26;

/**
 * One restrained burst of small blue rectangles, rising from `origin`'s top
 * centre and falling away inside `container` (clipped to it). No-op under
 * reduced motion.
 */
export function confettiBurst(container: HTMLElement | null, origin: HTMLElement | null): void {
  if (!container || prefersReducedMotion()) return;
  const box = container.getBoundingClientRect();
  const from = origin?.getBoundingClientRect() ?? box;
  const x0 = from.left - box.left + from.width / 2;
  const y0 = from.top - box.top;

  const layer = document.createElement("div");
  Object.assign(layer.style, {
    position: "absolute",
    inset: "0",
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: "50",
  });
  container.appendChild(layer);

  const colors = ["var(--primary)", "var(--brand)"];
  const pieces: Promise<unknown>[] = [];
  for (let i = 0; i < CONFETTI_COUNT; i++) {
    const piece = document.createElement("span");
    const w = 4 + Math.round(Math.random() * 3);
    const h = 7 + Math.round(Math.random() * 4);
    Object.assign(piece.style, {
      position: "absolute",
      left: `${x0 - w / 2}px`,
      top: `${y0 - h / 2}px`,
      width: `${w}px`,
      height: `${h}px`,
      borderRadius: "1px",
      background: colors[i % colors.length],
    });
    layer.appendChild(piece);
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
    const dist = 90 + Math.random() * 150;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;
    const spin = (Math.random() - 0.5) * 720;
    pieces.push(
      piece.animate(
        [
          { transform: "translate(0, 0) rotate(0deg)", opacity: 1 },
          { transform: `translate(${dx}px, ${dy}px) rotate(${spin / 2}deg)`, opacity: 1, offset: 0.45 },
          { transform: `translate(${dx * 1.15}px, ${dy + 120}px) rotate(${spin}deg)`, opacity: 0 },
        ],
        { duration: CONFETTI_MS, easing: OB_EASE, fill: "forwards", delay: Math.random() * 80 },
      ).finished,
    );
  }
  void Promise.allSettled(pieces).then(() => layer.remove());
}
