import { useEffect, useState } from "react";
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
import { initVoiceTyping } from "./lib/voiceTyping/host";

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
    const unTranscript = listenForTranscript();
    const unProsody = listenForProsody();
    const unSettings = listenForSettings();
    const unTemplates = initTemplatesSync();
    const unSession = initSessionSync();
    const unSessionCmds = initSessionCommands();
    const unSttUsage = listenForSttUsage();
    const unCacheClear = listenForCacheClear();
    const unSpeakerCacheClear = listenForSpeakerCacheClear();
    const unViewLogs = listenForViewLogsMenu();
    const unRecordingSaved = listenForRecordingSaved();
    const unHistoryOpen = listenForHistoryOpen();
    const unHistoryOpenOrg = CLOUD_ENABLED ? listenForHistoryOpenOrg() : null;
    const unHistoryPersist = initHistoryPersistSync();
    const unVoiceTyping = initVoiceTyping();
    return () => {
      unTranscript.then((fn) => fn());
      unProsody.then((fn) => fn());
      unSettings.then((fn) => fn());
      unTemplates();
      unSession();
      unSessionCmds();
      unSttUsage.then((fn) => fn());
      unCacheClear.then((fn) => fn());
      unSpeakerCacheClear.then((fn) => fn());
      unViewLogs.then((fn) => fn());
      unRecordingSaved.then((fn) => fn());
      unHistoryOpen.then((fn) => fn());
      unHistoryOpenOrg?.then((fn) => fn());
      unHistoryPersist();
      unVoiceTyping();
    };
  }, []);

  // Check for an app update shortly after launch, then keep re-checking on a slow
  // interval so a long-running window still catches a release that lands while
  // it's open. Surfaces a dismissible banner only; applying is always
  // user-initiated, so it never interrupts a meeting. Also re-validate any stored
  // cloud sign-in on launch.
  useEffect(() => {
    if (CLOUD_ENABLED) void refreshSession();
    // Skip update checks in dev — there are no updater artifacts and the banner
    // just gets in the way while iterating.
    if (import.meta.env.DEV) return;
    const RECHECK_MS = 30 * 60 * 1000; // every 30 min while the app stays open
    const first = setTimeout(() => void checkForUpdate({ silent: true }), 3000);
    const recheck = setInterval(() => void checkForUpdate({ silent: true }), RECHECK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(recheck);
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
