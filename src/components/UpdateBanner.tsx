import { useState } from "react";
import { Download, Loader2, X } from "lucide-react";
import { useStore } from "../lib/store";
import { applyPendingUpdate } from "../lib/update";
import { useI18n } from "../i18n";

/**
 * Non-intrusive "update available" banner just under the TitleBar. Shown when an
 * update was found (on launch or via Settings); applying is always user-initiated
 * — it downloads, installs, and relaunches, so it never interrupts a meeting on
 * its own. Dismissible until the next check.
 */
export function UpdateBanner() {
  const { t } = useI18n();
  const update = useStore((s) => s.update);
  const setUpdate = useStore((s) => s.setUpdate);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);

  if (!update) return null;

  async function apply() {
    setBusy(true);
    try {
      await applyPendingUpdate(setPct); // relaunches on success — never returns
    } catch (e) {
      console.error("[update] apply failed", e);
      setBusy(false);
    }
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[60px] z-50 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-sky-500/40 bg-sky-500/10 px-3.5 py-1.5 text-xs font-medium text-sky-700 shadow-sm backdrop-blur animate-in fade-in-0 slide-in-from-top-2 dark:text-sky-200">
        <Download className="size-3.5 shrink-0" />
        <span>{t("update.available", { version: update.version })}</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void apply()}
          className="rounded-full bg-sky-600 px-2.5 py-0.5 text-[11px] font-semibold text-white transition-colors hover:bg-sky-500 disabled:opacity-60"
        >
          {busy ? (
            <span className="flex items-center gap-1">
              <Loader2 className="size-3 animate-spin" />
              {pct > 0 ? `${pct}%` : t("update.updating")}
            </span>
          ) : (
            t("update.restart")
          )}
        </button>
        {!busy && (
          <button
            type="button"
            onClick={() => setUpdate(null)}
            className="shrink-0 opacity-60 transition-opacity hover:opacity-100"
            aria-label={t("update.dismiss")}
          >
            <X className="size-3" />
          </button>
        )}
      </div>
    </div>
  );
}
