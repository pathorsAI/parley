import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { exit } from "@tauri-apps/plugin-process";
import { TitleBar } from "./components/TitleBar";
import { AppShell } from "./components/shell/AppShell";
import { Onboarding } from "./components/Onboarding";
import { AnalysisErrorDialog } from "./components/AnalysisErrorDialog";
import { ReleaseNotesDialog } from "./components/ReleaseNotesDialog";
import { toast } from "sonner";
import { Toaster } from "./components/ui/sonner";
import { IngestWizard } from "./components/IngestWizard";
import { TranscriptImportDialog } from "./components/TranscriptImportDialog";
import { FindingSolutionWindow } from "./components/analysis/FindingSolutionWindow";
import { useFindingSolutionHost } from "./components/analysis/useFindingSolutionHost";
import { DeliveryNudgeHost } from "./components/delivery/DeliveryNudgeHost";
import { useDeliveryCoach } from "./lib/analysis/useDelivery";
import { useStore, isMeetingActive } from "./lib/store";
import {
  isTauri,
  listenForMeetingError,
  listenForMeetingWarning,
  listenForProsody,
  listenForTranscript,
} from "./lib/tauriEvents";
import { isMac, isWindows } from "./lib/platform";
import {
  showTrayNoticeOnce,
  syncTrayLabels,
  trayActive,
  TRAY_QUIT_EVENT,
} from "./lib/tray";
import { listenForSettings } from "./lib/settingsSync";
import { listenForViewLogsMenu } from "./lib/diagnostics";
import { listenForSttUsage } from "./lib/usage/log";
import { initTemplatesSync } from "./lib/templatesSync";
import { initSessionSync } from "./lib/sessionSync";
import { initSessionCommands } from "./lib/sessionCommands";
import { useThemePreference } from "./lib/theme";
import { useAnalysisEngine, listenForCacheClear } from "./lib/analysis/engine";
import { initStudyPipeline } from "./lib/analysis/studyPipeline";
import { listenForSpeakerCacheClear } from "./lib/speakers/namesCache";
import { initHistoryPersistSync, listenForRecordingSaved } from "./lib/history/history";
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
 * Run the drop-import flow for a set of dropped paths. Extracted to module
 * scope so the lazy-import `then`/`catch` callbacks don't push the surrounding
 * drag-drop listener closures past the nested-function depth limit.
 */
function importDroppedFiles(paths: string[]): void {
  import("./lib/replay/ingest")
    .then(({ importDroppedPaths }) => importDroppedPaths(paths))
    .catch((error) => {
      log.error("import: drop failed", { error: String(error) });
      toast.error(error instanceof Error ? error.message : String(error));
    });
}

/**
 * Quit the whole app. Used for the close button off macOS, where the main
 * window is the app's only presence: see `exitOnClose`. Extracted to module
 * scope so its `catch` callback doesn't push the close-request listener
 * closures past the nested-function depth limit.
 */
function exitApp(): void {
  exit(0).catch((error) => log.warn("window: exit on close failed", { error: String(error) }));
}

/**
 * Stop-then-quit: the tray's Quit item on Windows, and the close button where
 * there is nothing to hide to (Linux, or a Windows tray that failed to build).
 * The stop has to land before the process goes away — `exit` is immediate and
 * would cut the IPC mid-flight, leaving the native capture to die with the
 * process instead of finishing its teardown — so the exit is chained onto it,
 * on success and failure alike.
 */
function exitOnClose(stopIfRecording: () => Promise<void>): void {
  void stopIfRecording().then(exitApp, exitApp);
}

/**
 * Close-to-tray for Windows: stop an active meeting (a hidden window must
 * never keep recording), explain where the window went the first time, then
 * hide. Falls back to quitting when the tray icon does not exist — hiding the
 * window then would leave no way back to it. Extracted to module scope so its
 * awaits don't push the close-request listener past the nested-function depth
 * limit.
 */
async function hideToTray(stopIfRecording: () => Promise<void>): Promise<void> {
  if (!(await trayActive())) {
    exitOnClose(stopIfRecording);
    return;
  }
  void stopIfRecording();
  await showTrayNoticeOnce();
  await getCurrentWindow().hide();
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
  const onboarded = useStore((s) => s.settings.onboarded);
  const fullscreen = useFullscreen();
  // CSS-drawn rounded corners only make sense over the macOS transparent
  // window; the Windows main window is opaque and DWM handles its shape.
  const rounded = isTauri() && isMac() && !fullscreen;
  // The macOS main window sits on a native sidebar material (windowEffects in
  // tauri.macos.conf.json). The root stays transparent so the rail can let it
  // through; the titlebar and the route pane paint their own opaque page.
  const vibrant = isTauri() && isMac();
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
    track(listenForRecordingSaved());
    // The history://open + history://import listeners are gone with the standalone
    // History window (#195): the library is a route in THIS window now, so it
    // opens an entry by calling loadHistoryEntry directly.
    // These return a synchronous UnlistenFn.
    const unTemplates = initTemplatesSync();
    const unSession = initSessionSync();
    const unSessionCmds = initSessionCommands();
    const unHistoryPersist = initHistoryPersistSync();
    const unStudyPipeline = initStudyPipeline();
    const unVoiceTyping = initVoiceTyping();
    return () => {
      active = false;
      live.forEach((fn) => fn());
      live.length = 0;
      unTemplates();
      unSession();
      unSessionCmds();
      unHistoryPersist();
      unStudyPipeline();
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
  //
  // On macOS the close button HIDES the window instead of destroying it (the
  // platform convention — the app stays in the Dock and a Dock-icon click
  // brings the window back via Rust's RunEvent::Reopen handler). Destroying it
  // would also kill the voice-typing host that lives in this window, leaving
  // the global push-to-talk key dead until the app is relaunched. An active
  // meeting is still stopped first: a hidden window must never keep recording.
  //
  // Windows does the same, into the notification area: Rust puts a tray icon
  // there (src-tauri/src/tray.rs) whose click brings the window back and whose
  // Quit item is the real exit (TRAY_QUIT_EVENT, below). Before that icon
  // existed the close button had to QUIT on Windows — hiding needs somewhere to
  // hide to, and merely letting the window be destroyed left Parley running
  // invisibly (the prewarmed `voice-typing` window kept the process alive,
  // holding the global Ctrl+Alt+Space hotkey, reachable only by relaunching).
  // If the tray icon failed to build, `hideToTray` still quits for that reason.
  //
  // Anywhere else (Linux: not shipped, no tray) the close button QUITS.
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    const stopIfRecording = (): Promise<void> => {
      if (!isMeetingActive(useStore.getState().meetingStatus)) return Promise.resolve();
      return invoke<void>("stop_meeting").catch((error) =>
        log.warn("meeting: stop on close failed", { error: String(error) }),
      );
    };
    // Swallow the promise: a `beforeunload` handler that returns anything
    // non-null asks the webview for a "leave site?" confirmation, which would
    // stall an HMR reload behind a dialog nobody can answer.
    const stopOnUnload = () => void stopIfRecording();
    window.addEventListener("beforeunload", stopOnUnload);
    getCurrentWindow()
      .onCloseRequested((event) => {
        // Both paths hold the close: macOS to hide instead, elsewhere to let
        // the stop IPC land before the process goes away.
        event.preventDefault();
        if (isMac()) {
          void stopIfRecording();
          getCurrentWindow()
            .hide()
            .catch((error) => log.warn("window: hide on close failed", { error: String(error) }));
          return;
        }
        if (isWindows()) {
          hideToTray(stopIfRecording).catch((error) =>
            log.warn("window: hide to tray failed", { error: String(error) }),
          );
          return;
        }
        exitOnClose(stopIfRecording);
      })
      .then((fn) => {
        if (active) {
          unlisten = fn;
        } else {
          fn();
        }
      })
      .catch((error) => log.warn("window: close listener failed", { error: String(error) }));
    // The tray's Quit item (Windows): Rust asks, and the exit runs here so an
    // active meeting is stopped first — the same chain close-to-quit uses.
    let unlistenQuit: (() => void) | undefined;
    listen(TRAY_QUIT_EVENT, () => exitOnClose(stopIfRecording))
      .then((fn) => {
        if (active) {
          unlistenQuit = fn;
        } else {
          fn();
        }
      })
      .catch((error) => log.warn("window: tray quit listener failed", { error: String(error) }));
    return () => {
      active = false;
      window.removeEventListener("beforeunload", stopOnUnload);
      unlisten?.();
      unlistenQuit?.();
    };
  }, []);

  // The Windows tray menu speaks the app's language (no-op elsewhere).
  const language = useStore((s) => s.settings.language);
  useEffect(() => {
    syncTrayLabels(language);
  }, [language]);

  // Drop files anywhere on the window → the same import flow as every picker
  // door (R7): arbitration + STT gate live in lib/replay/ingest.ts, imported
  // lazily on drop so the ingest module (STT registry + dialog plugin) stays
  // out of the initial bundle.
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((e) => {
          if (e.payload.type !== "drop") return;
          if (isMeetingActive(useStore.getState().meetingStatus)) return;
          const { paths } = e.payload;
          log.info("import: files dropped", { count: paths.length });
          importDroppedFiles(paths);
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

  // One-shot folder hygiene: merge same-name folder twins left by older builds.
  useEffect(() => {
    import("./lib/history/history")
      .then(({ migrateDuplicateFolders }) => migrateDuplicateFolders())
      .catch((error) => log.warn("folders: dedupe failed", { error: String(error) }));
  }, []);

  // LIVE background engine: optional auto-analyze interval + checklist auto-check.
  useAnalysisEngine();

  // LIVE delivery coach: turns the prosody stream into pace/monotone/pause nudges.
  useDeliveryCoach();

  // Drive the standalone "how to reply" window (Tauri); no-op in browser dev.
  useFindingSolutionHost();

  return (
    <div
      className={`flex h-screen flex-col overflow-hidden text-foreground ${
        vibrant ? "" : "bg-background"
      } ${rounded ? "rounded-[12px]" : ""}`}
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
      <TranscriptImportDialog />
      {/* In the Tauri app the drilldown is its own OS window (see
          useFindingSolutionHost); in plain browser dev we fall back to the
          in-app overlay so the feature still works without multi-window. */}
      {!isTauri() && <FindingSolutionWindow />}
      <TitleBar fullscreen={fullscreen} />
      <DeliveryNudgeHost />
      <AppShell />
    </div>
  );
};

export default App;
