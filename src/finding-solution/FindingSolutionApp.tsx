import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatClock, useStore } from "../lib/store";
import { useThemePreference } from "../lib/theme";
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

  // Ask the main window to generate once we have a finding but no solution yet.
  useEffect(() => {
    if (!finding || keyMissing) return;
    if (!entry || entry.status === "idle") void requestFindingSolutionGenerate(finding.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finding?.id, entry?.status, keyMissing]);

  // Await the FS_CLOSE emit BEFORE destroying the webview — otherwise the IPC
  // message can be dropped as the process tears down, leaving the main window's
  // selection stuck on this finding (so re-clicking it wouldn't reopen).
  async function dismiss() {
    await closeFindingSolution();
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
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
