/**
 * A trailing-edge debouncer: each `schedule` replaces the pending call, which
 * runs `ms` after the last one. `cancel` drops a pending call.
 */
export interface Debouncer {
  schedule(fn: () => unknown): void;
  cancel(): void;
}

export function createDebouncer(ms: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule(fn) {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
