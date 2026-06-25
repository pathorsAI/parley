import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatClock, useStore } from "../lib/store";
import { log } from "../lib/log";
import { useThemePreference } from "../lib/theme";
import { listenForSettings } from "../lib/settingsSync";
import { useI18n } from "../i18n";
import { hasProviderKey } from "../lib/ai/settings";
import { FindingSolutionView } from "../components/analysis/FindingSolutionView";
import {
  closeFindingSolution,
  helloFindingSolution,
  listenForFindingSolutionState,
  requestFindingSolutionGenerate,
  type FindingSolutionState,
} from "../lib/findingSolutionSync";

/**
 * Standalone OS window (Tauri multi-window, like Settings) for the "how should I
 * reply" drilldown. Driven entirely by state pushed from the main window — it
 * holds no transcript itself; generation happens in the main window and the
 * result is synced here. Closing it (native X or the in-app button) clears the
 * main window's selection.
 */
export function FindingSolutionApp() {
  useThemePreference();
  const { t } = useI18n();
  const keyMissing = useStore((s) => !hasProviderKey(s.settings));
  const [state, setState] = useState<FindingSolutionState>({ finding: null, entry: null });
  const { finding, entry } = state;

  // Separate webview → own store; subscribe to cross-window settings so theme +
  // language changed in Settings apply here live too (mirrors App.tsx).
  useEffect(() => {
    const un = listenForSettings();
    return () => void un.then((fn) => fn());
  }, []);

  // Subscribe to main-window pushes; announce ourselves to pull current state.
  useEffect(() => {
    let un: (() => void) | undefined;
    void listenForFindingSolutionState(setState).then((fn) => (un = fn));
    void helloFindingSolution();
    return () => un?.();
  }, []);

  // Mirror a native window close (frame X) back to the main window's selection.
  useEffect(() => {
    let un: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      void getCurrentWindow()
        .onCloseRequested(() => void closeFindingSolution())
        .then((fn) => (un = fn));
    });
    return () => un?.();
  }, []);

  // Esc closes the window too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ask the main window to generate once we have a finding but no solution yet.
  useEffect(() => {
    if (!finding || keyMissing) return;
    if (!entry || entry.status === "idle") void requestFindingSolutionGenerate(finding.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finding?.id, entry?.status, keyMissing]);

  // Close the window. Await the FS_CLOSE emit FIRST (so the main window clears its
  // selection and the same finding can be reopened later — the emit must reach the
  // backend before we tear the webview down), then DESTROY the window. destroy()
  // is a hard close that bypasses the close-request flow, which `close()` did not
  // reliably complete from inside the window. Failures are logged, not swallowed.
  async function dismiss() {
    try {
      await closeFindingSolution();
    } catch (e) {
      log.warn("finding-solution: close-emit failed", { error: String(e) });
    }
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().destroy();
    } catch (e) {
      log.error("finding-solution: window destroy failed", { error: String(e) });
    }
  }

  if (!finding) {
    return (
      <div className="flex h-screen items-center justify-center bg-background px-6 text-center text-sm text-muted-foreground">
        {t("solution.selectHint")}
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <div className="flex items-start gap-2 border-b px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {t("solution.windowTitle")}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {formatClock(finding.atMs)}
            </span>
            <span
              className={cn(
                "truncate text-sm font-semibold",
                finding.side === "me" ? "text-sky-400" : "text-amber-400"
              )}
              title={finding.title}
            >
              {finding.title}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void dismiss()}
          className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
          title={t("solution.close")}
          aria-label={t("solution.close")}
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-3.5">
        <p className="mt-2.5 border-l-2 border-border pl-2 text-[11px] leading-snug text-muted-foreground">
          {finding.detail}
        </p>
        <FindingSolutionView
          status={entry?.status ?? "idle"}
          solution={entry?.solution ?? null}
          error={entry?.error ?? null}
          keyMissing={keyMissing}
          onRetry={() => void requestFindingSolutionGenerate(finding.id)}
        />
      </div>
    </div>
  );
}
