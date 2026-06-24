import { useEffect } from "react";
import { RotateCw, TriangleAlert, X } from "lucide-react";
import { useStore } from "../lib/store";
import { useI18n } from "../i18n";

/**
 * App-wide transient notification. Errors stay until dismissed and can carry a
 * Retry action; info auto-dismisses. The point is that failures are SHOWN (with
 * the actual message) and recoverable, never swallowed into the console. Push one
 * with `useStore.getState().showToast({ kind, message, retry? })`.
 */
const AUTO_DISMISS_MS = 4_500;

export function Toast() {
  const { t } = useI18n();
  const toast = useStore((s) => s.toast);
  const dismiss = useStore((s) => s.dismissToast);

  useEffect(() => {
    if (!toast || toast.kind === "error") return; // errors persist until acted on
    const id = setTimeout(dismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(id);
  }, [toast?.id, toast?.kind, dismiss]);

  if (!toast) return null;
  const isError = toast.kind === "error";

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex justify-center px-4">
      <div
        className={`pointer-events-auto flex max-w-[92vw] items-center gap-2.5 rounded-lg border px-3.5 py-2 text-xs shadow-md backdrop-blur animate-in fade-in-0 slide-in-from-bottom-2 ${
          isError
            ? "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-200"
            : "border-border bg-background/90 text-foreground"
        }`}
      >
        {isError && <TriangleAlert className="size-3.5 shrink-0" />}
        <span className="min-w-0 break-words">{toast.message}</span>
        {toast.retry && (
          <button
            type="button"
            onClick={() => {
              const retry = toast.retry!;
              dismiss();
              retry();
            }}
            className="flex shrink-0 items-center gap-1 rounded-md bg-foreground/10 px-2 py-0.5 font-medium transition-colors hover:bg-foreground/20"
          >
            <RotateCw className="size-3" />
            {t("toast.retry")}
          </button>
        )}
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 opacity-60 transition-opacity hover:opacity-100"
          aria-label={t("toast.dismiss")}
        >
          <X className="size-3" />
        </button>
      </div>
    </div>
  );
}
