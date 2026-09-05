import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";

/**
 * Follow-the-tail scrolling for streaming panes (the live transcript, the coach
 * feed). Both used to scroll to the bottom unconditionally on every update, so
 * a transcript arriving every few seconds made reading anything further up
 * impossible: the view was yanked away mid-sentence. Here the pane only chases
 * the tail while the user is already standing at it.
 */

/** How close to the bottom still counts as being at the bottom, in CSS pixels. */
const BOTTOM_THRESHOLD_PX = 48;

/**
 * How long a scroll we started is allowed to stay in flight before we stop
 * treating incoming scroll events as our own. `scrollend` is the obvious
 * signal but WKWebView does not fire it reliably, so the timeout is the real
 * backstop and the guard is also released the moment the bottom is reached.
 */
const SETTLE_MS = 700;

/**
 * Whether a scroll container is parked at (or within `threshold` of) its
 * bottom. A container whose content is shorter than its viewport never
 * scrolls and is therefore always at the bottom.
 */
export function isAtBottom(
  m: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold: number
): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= threshold;
}

export interface StickToBottom<T extends HTMLElement> {
  /** Ref for the scroll container — the Radix ScrollArea viewport, in practice. */
  viewportRef: (el: T | null) => void;
  /** True while new content is being followed; false once the user scrolled up. */
  following: boolean;
  /** Jump to the tail and re-arm the follow (the "jump to latest" affordance). */
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  /**
   * Run a deliberate, user-initiated scroll somewhere other than the tail
   * (jump-to-timestamp). It is not mistaken for the user drifting off the
   * bottom while it travels, and once it lands the follow is re-derived from
   * where it actually ended up — so the next segment does not drag the view
   * back down and undo the jump.
   */
  programmaticScroll: (scroll: () => void) => void;
}

/**
 * @param deps content that, when it changes, should pull the view to the tail
 *   — exactly the dependency list the old unconditional effect was keyed on.
 */
export function useStickToBottom<T extends HTMLElement = HTMLDivElement>(
  deps: DependencyList
): StickToBottom<T> {
  const viewportRef = useRef<T | null>(null);
  // The same node as a state, so listeners re-attach when a pane that renders
  // an empty state first (the transcript does) finally mounts its viewport.
  const [viewport, setViewport] = useState<T | null>(null);
  const [following, setFollowing] = useState(true);
  // Mirror of `following` readable from effects that must not re-run on it.
  const followingRef = useRef(true);
  // Set while a scroll we started is still travelling.
  const inFlight = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const arm = useCallback((next: boolean) => {
    followingRef.current = next;
    setFollowing(next);
  }, []);

  const sync = useCallback(() => {
    const el = viewportRef.current;
    if (el) arm(isAtBottom(el, BOTTOM_THRESHOLD_PX));
  }, [arm]);

  /** Stop guarding our own scroll. `resync` is false when the user took over. */
  const release = useCallback(
    (resync: boolean) => {
      if (settleTimer.current !== null) clearTimeout(settleTimer.current);
      settleTimer.current = null;
      inFlight.current = false;
      if (resync) sync();
    },
    [sync]
  );

  const programmaticScroll = useCallback(
    (scroll: () => void) => {
      if (settleTimer.current !== null) clearTimeout(settleTimer.current);
      inFlight.current = true;
      settleTimer.current = setTimeout(() => release(true), SETTLE_MS);
      scroll();
    },
    [release]
  );

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const el = viewportRef.current;
      if (!el) return;
      arm(true); // the tail is where we are heading, so re-arm immediately
      programmaticScroll(() => el.scrollTo({ top: el.scrollHeight, behavior }));
    },
    [arm, programmaticScroll]
  );

  const attach = useCallback((el: T | null) => {
    viewportRef.current = el;
    setViewport(el);
  }, []);

  useEffect(() => {
    const el = viewport;
    if (!el) return;
    const onScroll = () => {
      if (inFlight.current) {
        // Positions passed through mid-flight say nothing about the user; only
        // arriving at the tail ends the guard early.
        if (isAtBottom(el, BOTTOM_THRESHOLD_PX)) release(true);
        return;
      }
      sync();
    };
    // A wheel, a swipe or a key is unambiguously the user: they own the
    // viewport from here, even if a scroll of ours is still in flight.
    const onUserInput = () => {
      if (inFlight.current) release(false);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onUserInput, { passive: true });
    el.addEventListener("touchmove", onUserInput, { passive: true });
    el.addEventListener("keydown", onUserInput);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onUserInput);
      el.removeEventListener("touchmove", onUserInput);
      el.removeEventListener("keydown", onUserInput);
    };
  }, [viewport, sync, release]);

  // Drop any pending settle timer on unmount.
  useEffect(() => () => {
    if (settleTimer.current !== null) clearTimeout(settleTimer.current);
  }, []);

  // New content pulls the view down only while the follow is armed; otherwise
  // it simply appends below and the reader keeps their place.
  useEffect(() => {
    if (followingRef.current) scrollToBottom();
  }, deps);

  return { viewportRef: attach, following, scrollToBottom, programmaticScroll };
}
