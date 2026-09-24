import { createElement, useCallback, useState, type ReactNode } from "react";

/** Rows mounted per page. Comfortably more than a tall window shows at once. */
const PAGE = 120;

/**
 * Mount a long list a page at a time instead of all at once.
 *
 * A library of a few thousand recordings used to mount every row on open, on
 * every re-list (window focus, a save landing) and on every keystroke in the
 * search box — each row with its own date formatting and toolbar. Only the
 * first screenful is ever seen right away, so that is all that gets mounted;
 * the next page mounts when the sentinel at the end of the list scrolls into
 * view.
 *
 * `resetKey` names what the list is a list OF (scope, node, query). A change
 * sends the window back to its first page, so opening a small folder after
 * scrolling deep into another doesn't mount a stale backlog.
 *
 * Without IntersectionObserver (tests, very old webviews) the whole list is
 * mounted, which is the old behaviour — never a list that can't be finished.
 */
export function useRenderWindow<T>(
  items: T[],
  resetKey: string,
): { shown: T[]; sentinel: ReactNode } {
  const [limit, setLimit] = useState(PAGE);
  const [key, setKey] = useState(resetKey);
  if (key !== resetKey) {
    // Adjusting state during render (React's documented alternative to an
    // effect) — the reset lands before this render commits, not one frame late.
    setKey(resetKey);
    setLimit(PAGE);
  }

  // Re-created whenever `limit` changes, so the sentinel is observed afresh
  // after each page: IntersectionObserver reports only CHANGES, and a sentinel
  // that is still on screen after a page mounts (a tall window, short rows)
  // would otherwise never trigger the next one.
  const sentinelRef = useCallback(
    (node: Element | null) => {
      if (!node || typeof IntersectionObserver === "undefined") return;
      const observer = new IntersectionObserver((records) => {
        if (records.some((r) => r.isIntersecting)) {
          observer.disconnect();
          setLimit((l) => l + PAGE);
        }
      });
      observer.observe(node);
      return () => observer.disconnect();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [limit],
  );

  if (typeof IntersectionObserver === "undefined" || limit >= items.length) {
    return { shown: items, sentinel: null };
  }
  return {
    shown: items.slice(0, limit),
    sentinel: createElement("div", { ref: sentinelRef, className: "h-px" }),
  };
}
