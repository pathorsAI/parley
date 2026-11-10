import { useCommandScope, useCommandShortcut } from "./bind";

/**
 * Give a tab strip the app's tab keys: ⌘1–⌘9 pick the Nth tab, ⌘← / ⌘→ (and
 * ⇧⌘[ / ⇧⌘]) step to the previous / next one, wrapping at either end.
 *
 * Every strip — the study page, 語境庫, the meeting window, Settings'
 * categories — calls this rather than binding its own keys, so the keys are the
 * same everywhere and the cheat sheet lists them once. While a strip is up it
 * takes ⌘1–⌘3 and ⌘← / ⌘→ over from Home / Library / Back / Forward (see
 * `shadows` in ./registry.ts).
 *
 * `tabs` is the strip's visible order; a number past its end does nothing.
 */
export function useTabShortcuts<T>(tabs: readonly T[], current: T, select: (tab: T) => void): void {
  useCommandScope("tabs");

  const step = (dir: 1 | -1) => {
    if (tabs.length === 0) return;
    const at = Math.max(0, tabs.indexOf(current));
    select(tabs[(at + dir + tabs.length) % tabs.length]);
  };

  useCommandShortcut("tabs.select", (e) => {
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= tabs.length) select(tabs[n - 1]);
  });
  useCommandShortcut("tabs.prev", () => step(-1));
  useCommandShortcut("tabs.next", () => step(1));
}
