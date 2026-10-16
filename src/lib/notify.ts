/**
 * User-facing notices from lib flows, rendered by the UI layer.
 *
 * A flow (saving a meeting, refiling a recording…) decides WHAT to tell the
 * user and when — the text is already translated — but it does not render it:
 * the app installs a {@link Notifier} at boot (main.tsx shows them as toasts).
 * Until one is installed, notices go nowhere.
 */
export interface Notifier {
  message(text: string): void;
  success(text: string): void;
  error(text: string): void;
}

const SILENT: Notifier = { message() {}, success() {}, error() {} };

let current: Notifier = SILENT;

/** Install how this window shows notices (null restores silence). */
export function setNotifier(notifier: Notifier | null): void {
  current = notifier ?? SILENT;
}

/** Tell the user something, through whatever this window installed. */
export const notify: Notifier = {
  message: (text) => current.message(text),
  success: (text) => current.success(text),
  error: (text) => current.error(text),
};
