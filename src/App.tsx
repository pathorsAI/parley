import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TitleBar } from "./components/TitleBar";
import { LiveScreen } from "./components/live/LiveScreen";
import { ReplayScreen } from "./components/replay/ReplayScreen";
import { Onboarding } from "./components/Onboarding";
import { AnalysisErrorDialog } from "./components/AnalysisErrorDialog";
import { Toaster } from "./components/ui/sonner";
import { IngestWizard } from "./components/IngestWizard";
import { FindingSolutionWindow } from "./components/analysis/FindingSolutionWindow";
import { useFindingSolutionHost } from "./components/analysis/useFindingSolutionHost";
import { DeliveryNudgeHost } from "./components/delivery/DeliveryNudgeHost";
import { useDeliveryCoach } from "./lib/analysis/useDelivery";
import { useStore } from "./lib/store";
import { isTauri, listenForProsody, listenForTranscript } from "./lib/tauriEvents";
import { listenForSettings } from "./lib/settingsSync";
import { listenForViewLogsMenu } from "./lib/diagnostics";
import { listenForSttUsage } from "./lib/usage/log";
import { initTemplatesSync } from "./lib/templatesSync";
import { initSessionSync } from "./lib/sessionSync";
import { initSessionCommands } from "./lib/sessionCommands";
import { useThemePreference } from "./lib/theme";
import { useAnalysisEngine, listenForCacheClear } from "./lib/analysis/engine";
import { listenForSpeakerCacheClear } from "./lib/speakers/namesCache";
import {
  initHistoryPersistSync,
  listenForHistoryOpen,
  listenForHistoryOpenOrg,
  listenForRecordingSaved,
} from "./lib/history/history";
import { checkForUpdate } from "./lib/update";
import { refreshSession } from "./lib/cloud/client";
import { CLOUD_ENABLED } from "./lib/flags";

/**
 * Track main-window fullscreen state. Drives both the rounded corners (a
 * fullscreen window fills the display edge-to-edge, so it squares off; a
 * zoomed/maximized window is still a floating window and stays rounded) and the
 * auto-hiding titlebar.
 */
function useFullscreen(): boolean {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const sync = async () => {
        const fs = await win.isFullscreen();
        if (active) setFullscreen(fs);
      };
      await sync();
      const un = await win.onResized(() => void sync());
      if (active) unlisten = un;
      else un();
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);
  return fullscreen;
}

function App() {
  useThemePreference();
  const appMode = useStore((s) => s.appMode);
  const onboarded = useStore((s) => s.settings.onboarded);
  const fullscreen = useFullscreen();
  const rounded = isTauri() && !fullscreen;

  useEffect(() => {
    // StrictMode (dev) double-invokes this effect (mount→cleanup→mount) and Vite
    // HMR re-runs it on edits. The Tauri `listen()` calls resolve their UnlistenFn
    // on a LATER tick, so a naive `unX.then(fn => fn())` cleanup can fire its
    // unlisten AFTER the re-mount has already re-subscribed — leaving two live
    // handlers for `transcript://segment` / `audio://prosody` (the dev-only
    // "double" symptom). Guard with an `active` flag: collect each unlisten as it
    // resolves; if the effect is already torn down by then, unlisten immediately.
    let active = true;
    const live: Array<() => void> = [];
    const track = (p: Promise<() => void>) => {
      void p.then((fn) => {
        if (active) live.push(fn);
        else fn();
      });
    };
    track(listenForTranscript());
    track(listenForProsody());
    track(listenForSettings());
    track(listenForSttUsage());
    track(listenForCacheClear());
    track(listenForSpeakerCacheClear());
    track(listenForViewLogsMenu());
    track(listenForRecordingSaved());
    track(listenForHistoryOpen());
    if (CLOUD_ENABLED) track(listenForHistoryOpenOrg());
    // These return a synchronous UnlistenFn.
    const unTemplates = initTemplatesSync();
    const unSession = initSessionSync();
    const unSessionCmds = initSessionCommands();
    const unHistoryPersist = initHistoryPersistSync();
    return () => {
      active = false;
      live.forEach((fn) => fn());
      live.length = 0;
      unTemplates();
      unSession();
      unSessionCmds();
      unHistoryPersist();
    };
  }, []);

  // Check for an app update shortly after launch, then keep re-checking on a slow
  // interval so a long-running window still catches a release that lands while
  // it's open. Surfaces a dismissible banner only; applying is always
  // user-initiated, so it never interrupts a meeting. Also re-validate any stored
  // cloud sign-in on launch.
  useEffect(() => {
    if (CLOUD_ENABLED) void refreshSession();
    const RECHECK_MS = 30 * 60 * 1000; // every 30 min while the app stays open
    const first = setTimeout(() => void checkForUpdate({ silent: true }), 3000);
    const recheck = setInterval(() => void checkForUpdate({ silent: true }), RECHECK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(recheck);
    };
  }, []);

  // If the window is closed (or dev-reloaded via HMR) mid-meeting, tell Rust to
  // stop so the native capture/transcription session can't be orphaned. The only
  // other stop_meeting caller is the toolbar toggle, so without this a reload/close
  // leaves the backend recording. Best-effort: the IPC is dispatched even as the
  // webview tears down; stop_meeting is idempotent.
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    const stopIfRecording = () => {
      if (useStore.getState().meetingStatus === "recording") {
        void invoke("stop_meeting").catch(() => {});
      }
    };
    window.addEventListener("beforeunload", stopIfRecording);
    void getCurrentWindow()
      .onCloseRequested(stopIfRecording)
      .then((fn) => (active ? (unlisten = fn) : fn()));
    return () => {
      active = false;
      window.removeEventListener("beforeunload", stopIfRecording);
      unlisten?.();
    };
  }, []);

  // LIVE background engine: optional auto-analyze interval + TODO agenda auto-check.
  useAnalysisEngine();

  // LIVE delivery coach: turns the prosody stream into pace/monotone/pause nudges.
  useDeliveryCoach();

  // Drive the standalone "how to reply" window (Tauri); no-op in browser dev.
  useFindingSolutionHost();

  return (
    <div
      className={`flex h-screen flex-col overflow-hidden bg-background text-foreground ${
        rounded ? "rounded-[12px]" : ""
      }`}
    >
      {!onboarded && <Onboarding />}
      <AnalysisErrorDialog />
      <Toaster />
      <IngestWizard />
      {/* In the Tauri app the drilldown is its own OS window (see
          useFindingSolutionHost); in plain browser dev we fall back to the
          in-app overlay so the feature still works without multi-window. */}
      {!isTauri() && <FindingSolutionWindow />}
      <TitleBar fullscreen={fullscreen} />
      <DeliveryNudgeHost />
      {appMode === "replay" ? <ReplayScreen /> : <LiveScreen />}
    </div>
  );
}

export default App;
