import { lazy, Suspense, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TitleBar } from "./components/TitleBar";
import { TranslateStrip } from "./components/TranslateStrip";
import { LiveScreen } from "./components/live/LiveScreen";
import { StudyScreen } from "./components/study/StudyScreen";

const AccountsScreen = lazy(() =>
  import("./components/accounts/AccountsScreen").then((m) => ({ default: m.AccountsScreen }))
);
import { Onboarding } from "./components/Onboarding";
import { AnalysisErrorDialog } from "./components/AnalysisErrorDialog";
import { ReleaseNotesDialog } from "./components/ReleaseNotesDialog";
import { Toaster } from "./components/ui/sonner";
import { IngestWizard } from "./components/IngestWizard";
import { FindingSolutionWindow } from "./components/analysis/FindingSolutionWindow";
import { useFindingSolutionHost } from "./components/analysis/useFindingSolutionHost";
import { DeliveryNudgeHost } from "./components/delivery/DeliveryNudgeHost";
import { useDeliveryCoach } from "./lib/analysis/useDelivery";
import { useStore } from "./lib/store";
import {
  isTauri,
  listenForMeetingError,
  listenForMeetingWarning,
  listenForProsody,
  listenForTranscript,
} from "./lib/tauriEvents";
import { listenForSettings } from "./lib/settingsSync";
import { listenForViewLogsMenu } from "./lib/diagnostics";
import { listenForLiveTranslateMenu } from "./lib/liveTranslate";
import { listenForSttUsage } from "./lib/usage/log";
import { initTemplatesSync } from "./lib/templatesSync";
import { initSessionSync } from "./lib/sessionSync";
import { initSessionCommands } from "./lib/sessionCommands";
import { useThemePreference } from "./lib/theme";
import { useAnalysisEngine, listenForCacheClear } from "./lib/analysis/engine";
import { initAccounts } from "./lib/accounts/store";
import { listenForSpeakerCacheClear } from "./lib/speakers/namesCache";
import {
  initHistoryPersistSync,
  listenForHistoryImport,
  listenForHistoryOpen,
  listenForHistoryOpenOrg,
  listenForRecordingSaved,
} from "./lib/history/history";
import { checkForUpdate } from "./lib/update";
import {
  getPendingInstalledReleaseNotes,
  markReleaseNotesSeen,
  type ReleaseNotes,
} from "./lib/releaseNotes";
import { refreshSession } from "./lib/cloud/client";
import { CLOUD_ENABLED } from "./lib/flags";
import { initVoiceTyping } from "./lib/voiceTyping/host";
import { preloadZhConverter } from "./lib/zhConvert";
import { log } from "./lib/log";

/**
 * Build the window-resize handler that re-syncs fullscreen state. Extracted to
 * module scope (rather than defined inline inside `connectFullscreenEvents`)
 * so the resize/catch callbacks don't push the surrounding closures past the
 * nested-function depth limit.
 */
function createFullscreenResizeHandler(sync: () => Promise<void>): () => void {
  return () => {
    sync().catch((error) => log.warn("window: fullscreen sync failed", { error: String(error) }));
  };
}

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
    async function connectFullscreenEvents() {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const sync = async () => {
        const fs = await win.isFullscreen();
        if (active) setFullscreen(fs);
      };
      await sync();
      const un = await win.onResized(createFullscreenResizeHandler(sync));
      if (active) unlisten = un;
      else un();
    }
    connectFullscreenEvents().catch((error) => log.warn("window: fullscreen listener failed", { error: String(error) }));
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);
  return fullscreen;
}

const App = () => {
  useThemePreference();
  const appMode = useStore((s) => s.appMode);
  const onboarded = useStore((s) => s.settings.onboarded);
  const fullscreen = useFullscreen();
  const rounded = isTauri() && !fullscreen;
  const [releaseNotes, setReleaseNotes] = useState<ReleaseNotes | null>(null);

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
      p.then((fn) => {
        if (active) live.push(fn);
        else fn();
      }).catch((error) => log.warn("app: listener registration failed", { error: String(error) }));
    };
    // Warm the S→T dictionary now: paying its load on the FIRST transcript
    // event delayed the opening caption of every meeting by the parse time.
    preloadZhConverter();
    track(listenForTranscript());
    track(listenForProsody());
    track(listenForMeetingError());
    track(listenForMeetingWarning());
    track(listenForSettings());
    track(listenForSttUsage());
    track(listenForCacheClear());
    track(listenForSpeakerCacheClear());
    track(listenForViewLogsMenu());
    track(listenForLiveTranslateMenu());
    track(listenForRecordingSaved());
    track(listenForHistoryOpen());
    track(listenForHistoryImport());
    if (CLOUD_ENABLED) track(listenForHistoryOpenOrg());
    // These return a synchronous UnlistenFn.
    const unTemplates = initTemplatesSync();
    const unSession = initSessionSync();
    const unSessionCmds = initSessionCommands();
    const unHistoryPersist = initHistoryPersistSync();
    const unVoiceTyping = initVoiceTyping();
    return () => {
      active = false;
      live.forEach((fn) => fn());
      live.length = 0;
      unTemplates();
      unSession();
      unSessionCmds();
      unHistoryPersist();
      unVoiceTyping();
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    getVersion()
      .then((version) => {
        const notes = getPendingInstalledReleaseNotes(version);
        if (notes) setReleaseNotes(notes);
      })
      .catch((error) => log.warn("update: installed release notes lookup failed", { error: String(error) }));
  }, []);

  // Check for an app update shortly after launch, then keep re-checking on a slow
  // interval so a long-running window still catches a release that lands while
  // it's open. Surfaces a dismissible banner only; applying is always
  // user-initiated, so it never interrupts a meeting. Also re-validate any stored
  // cloud sign-in on launch.
  useEffect(() => {
    if (CLOUD_ENABLED) {
      refreshSession().catch((error) => log.warn("cloud: session refresh failed", { error: String(error) }));
    }
    // Skip update checks in dev — there are no updater artifacts and the banner
    // just gets in the way while iterating.
    if (import.meta.env.DEV) return;
    const RECHECK_MS = 30 * 60 * 1000; // every 30 min while the app stays open
    const first = setTimeout(() => {
      checkForUpdate({ silent: true }).catch((error) => log.warn("update: check failed", { error: String(error) }));
    }, 3000);
    const recheck = setInterval(() => {
      checkForUpdate({ silent: true }).catch((error) => log.warn("update: check failed", { error: String(error) }));
    }, RECHECK_MS);
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
        invoke("stop_meeting").catch((error) => log.warn("meeting: stop on close failed", { error: String(error) }));
      }
    };
    window.addEventListener("beforeunload", stopIfRecording);
    getCurrentWindow()
      .onCloseRequested(stopIfRecording)
      .then((fn) => {
        if (active) {
          unlisten = fn;
        } else {
          fn();
        }
      })
      .catch((error) => log.warn("window: close listener failed", { error: String(error) }));
    return () => {
      active = false;
      window.removeEventListener("beforeunload", stopIfRecording);
      unlisten?.();
    };
  }, []);

  // Drop an audio file anywhere on the window → straight into the ingest
  // wizard (the header upload button's replacement).
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((e) => {
          if (e.payload.type !== "drop") return;
          const audio = e.payload.paths.find((p) =>
            /\.(mp3|m4a|wav|ogg|oga|flac|aac|mp4|webm|opus)$/i.test(p)
          );
          if (audio && useStore.getState().meetingStatus !== "recording") {
            log.info("replay: file dropped, opening ingest wizard");
            useStore.getState().openIngestWizard(audio);
          }
        })
      )
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      })
      .catch((error) => log.warn("app: drag-drop listener failed", { error: String(error) }));
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  // Accounts (mini-CRM): hydrate from accounts.json once, then persist changes.
  useEffect(() => {
    initAccounts();
  }, []);

  // LIVE background engine: optional auto-analyze interval + checklist auto-check.
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
      {releaseNotes && (
        <ReleaseNotesDialog
          notes={releaseNotes}
          onClose={() => {
            markReleaseNotesSeen(releaseNotes.version);
            setReleaseNotes(null);
          }}
        />
      )}
      <Toaster />
      <IngestWizard />
      {/* In the Tauri app the drilldown is its own OS window (see
          useFindingSolutionHost); in plain browser dev we fall back to the
          in-app overlay so the feature still works without multi-window. */}
      {!isTauri() && <FindingSolutionWindow />}
      <TitleBar fullscreen={fullscreen} />
      <DeliveryNudgeHost />
      {appMode === "replay" ? (
        <StudyScreen />
      ) : appMode === "accounts" ? (
        <Suspense fallback={null}>
          <AccountsScreen />
        </Suspense>
      ) : (
        <LiveScreen />
      )}
      {/* Interpreter strip: only during a translated live meeting. */}
      <TranslateStrip />
    </div>
  );
};

export default App;
