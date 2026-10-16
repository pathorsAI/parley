// Store subscriptions that react to ONE derived value changing: the shape the
// background mirrors (session.json, templates.json, the dictionary sync) share.

import { useStore } from "../store";
import { createDebouncer, type Debouncer } from "../debounce";
import type { ParleyState } from "./types";

export interface SubscribeOptions<T> {
  /** When two selected values count as the same (default `Object.is`). */
  equals?: (a: T, b: T) => boolean;
  /** Checked on every change, after the new value is recorded: true drops this
   *  change without scheduling — an echo guard for a write the caller made
   *  itself. */
  skip?: () => boolean;
  /** Schedule once right away, as if the value had just changed. */
  fireImmediately?: boolean;
  /** Stopping also drops a call still pending (default true). */
  cancelOnStop?: boolean;
}

/**
 * Call `fn` with the selected value whenever it changes, synchronously from
 * the store update. Returns the unsubscribe.
 */
export function subscribeSelected<T>(
  selector: (state: ParleyState) => T,
  fn: (value: T) => void,
  opts: Pick<SubscribeOptions<T>, "equals" | "skip"> = {},
): () => void {
  const equals = opts.equals ?? Object.is;
  let last = selector(useStore.getState());
  return useStore.subscribe((state) => {
    const next = selector(state);
    if (equals(last, next)) return;
    last = next;
    if (opts.skip?.()) return;
    fn(next);
  });
}

/**
 * Like {@link subscribeSelected}, but `fn` runs `ms` after the LAST change in a
 * burst (trailing debounce) — for mirrors that would otherwise write on every
 * transcript tick. `fn` gets the value selected at the last change. Returns
 * the stop function.
 */
export function subscribeDebounced<T>(
  selector: (state: ParleyState) => T,
  ms: number,
  fn: (value: T) => unknown,
  opts: SubscribeOptions<T> = {},
): () => void {
  const debouncer: Debouncer = createDebouncer(ms);
  const schedule = (value: T) => debouncer.schedule(() => fn(value));
  const unsubscribe = subscribeSelected(selector, schedule, opts);
  if (opts.fireImmediately) schedule(selector(useStore.getState()));
  return () => {
    unsubscribe();
    if (opts.cancelOnStop ?? true) debouncer.cancel();
  };
}
