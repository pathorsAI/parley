import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Circle, FileAudio, History, Loader2, LogOut, Mic, Minus, Settings, Square, X } from "lucide-react";
import { useStore } from "../lib/store";
import { log } from "../lib/log";
import { STT_BY_ID, sttApiKey } from "../lib/transcription/providers";
import { CLOUD_URL } from "../lib/cloud/client";
import { toast } from "sonner";
import { startMockStream, stopMockStream } from "../lib/mockStream";
import { isTauri } from "../lib/tauriEvents";
import { openSettingsWindow } from "../lib/settingsSync";
import { openHistoryWindow } from "../lib/history/history";
import { useI18n } from "../i18n";
import { Button } from "@/components/ui/button";
import { LevelMeter } from "./LevelMeter";

/**
 * Track main-window focus so the traffic lights can dim to grey when the window
 * is inactive — matching native macOS behaviour. Defaults to focused (and stays
 * focused in browser dev, where there's no window to query).
 */
function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const win = getCurrentWindow();
      try {
        const initial = await win.isFocused();
        if (active) setFocused(initial);
      } catch {
        /* ignore — keep default */
      }
      const un = await win.onFocusChanged(({ payload }) => {
        if (active) setFocused(payload);
      });
      if (active) unlisten = un;
      else un();
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);
  return focused;
}

/**
 * Custom window titlebar. The main Tauri window is undecorated, so this header
 * owns both the draggable region and the window controls.
 *
 * In fullscreen there are no window controls (macOS hides the traffic lights and
 * reveals its own menu bar at the top edge), so we drop our traffic lights and
 * let the logo + brand sit at the leading edge.
 */
export function TitleBar({ fullscreen = false }: { fullscreen?: boolean }) {
  const { t } = useI18n();
  const focused = useWindowFocused();
  const status = useStore((s) => s.meetingStatus);
  const transcriptionProvider = useStore((s) => s.settings.transcriptionProvider);
  const sttKey = useStore((s) => sttApiKey(s.settings, s.settings.transcriptionProvider));
  const inputDevice = useStore((s) => s.settings.inputDevice);
  const startMeeting = useStore((s) => s.startMeeting);
  const stopMeeting = useStore((s) => s.stopMeeting);
  const appMode = useStore((s) => s.appMode);
  const replayName = useStore((s) => s.replay?.name ?? "");
  const exitReplay = useStore((s) => s.exitReplay);
  const [ingestMsg, setIngestMsg] = useState<string | null>(null);
  // Guard the start/stop toggle so a rapid double-click can't fire two overlapping
  // start/stop invokes (which is what could race two transcription sessions open,
  // or interleave a stop with a start). The ref blocks re-entry synchronously
  // (before any re-render); `toggleBusy` just disables the button visually.
  const toggleBusyRef = useRef(false);
  const [toggleBusy, setToggleBusy] = useState(false);

  const recording = status === "recording";
  const replayMode = appMode === "replay";
  const useRealPipeline = isTauri() && !!sttKey.trim();

  async function uploadRecording() {
    if (ingestMsg) return;
    const { settings, openIngestWizard } = useStore.getState();
    setIngestMsg(t("replay.preparing"));
    log.info("replay: upload started");
    try {
      // Only pick the file here — the ingest wizard then asks the speaker count
      // and runs transcription → diarization → review → analysis as one pipeline.
      const { pickRecordingFile } = await import("../lib/replay/ingest");
      const audioPath = await pickRecordingFile(settings);
      if (audioPath) {
        log.info("replay: file picked, opening ingest wizard");
        openIngestWizard(audioPath);
      } else {
        log.debug("replay: upload cancelled");
      }
    } catch (e) {
      log.error("replay: pick failed", { error: String(e) });
      window.alert(t("replay.failed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setIngestMsg(null);
    }
  }

  async function toggle() {
    // Re-entrancy guard: ignore clicks while a start/stop is already in flight.
    if (toggleBusyRef.current) return;
    toggleBusyRef.current = true;
    setToggleBusy(true);
    try {
      if (recording) {
        log.info("meeting: stop requested");
        stopMeeting();
        if (useRealPipeline) {
          try {
            await invoke("stop_meeting");
          } catch (e) {
            log.error("meeting: stop failed", { error: String(e) });
          }
        } else {
          stopMockStream();
        }
        return;
      }
      startMeeting();
      if (useRealPipeline) {
        log.info("meeting: start requested", {
          provider: transcriptionProvider,
          model: STT_BY_ID[transcriptionProvider].label,
          diarization: STT_BY_ID[transcriptionProvider].diarization,
          inputDevice,
          pipeline: "real",
        });
        try {
          // Hosted "parley" STT: relay audio through Parley Cloud (cloud WSS URL
          // + the session token as apiKey, via sttApiKey). BYOK providers send no
          // relay URL and connect straight to their vendor.
          const relayUrl =
            transcriptionProvider === "parley"
              ? `${CLOUD_URL.replace(/^http/, "ws")}/stt/stream`
              : undefined;
          await invoke("start_meeting", {
            provider: transcriptionProvider,
            apiKey: sttKey,
            diarization: STT_BY_ID[transcriptionProvider].diarization,
            inputDevice,
            relayUrl,
          });
        } catch (e) {
          log.error("meeting: start failed", {
            provider: transcriptionProvider,
            inputDevice,
            error: String(e),
          });
          stopMeeting();
        }
      } else if (transcriptionProvider === "parley") {
        // Hosted STT selected but no usable cloud session — never fake it with a
        // mock transcript; tell the user to sign in and back out of "recording".
        log.info("meeting: start blocked (parley, no session)");
        stopMeeting();
        toast.error(t("meeting.error.signin"));
      } else {
        log.info("meeting: start (mock stream)");
        startMockStream();
      }
    } finally {
      toggleBusyRef.current = false;
      setToggleBusy(false);
    }
  }

  async function controlWindow(action: "close" | "minimize" | "fullscreen") {
    if (!isTauri()) return;
    const appWindow = getCurrentWindow();
    try {
      if (action === "close") await appWindow.close();
      if (action === "minimize") await appWindow.minimize();
      // Native macOS maps the green button to full screen (not window zoom).
      if (action === "fullscreen") await appWindow.setFullscreen(!(await appWindow.isFullscreen()));
    } catch (e) {
      log.warn("window: action failed", { action, error: String(e) });
    }
  }

  return (
    <header
      data-tauri-drag-region
      className={`relative flex h-[52px] shrink-0 items-center justify-between border-b bg-background/85 pr-3 backdrop-blur ${
        fullscreen ? "pl-4" : "pl-[104px]"
      }`}
    >
      {/* macOS traffic lights: native sizing/colours, glyphs reveal on hover of
          the whole cluster (not per-button), and the trio dims to grey when the
          window loses focus — matching the system buttons. Hidden in fullscreen,
          where macOS shows no window controls. */}
      {!fullscreen && (
      <div className="group/traffic absolute left-4 top-1/2 flex -translate-y-1/2 items-center gap-2">
        <button
          type="button"
          aria-label={t("titlebar.closeWindow")}
          onClick={() => void controlWindow("close")}
          className={`grid size-3 place-items-center rounded-full shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.14)] transition-colors ${
            focused ? "bg-[#FF5F57]" : "bg-[#c7c7c9] group-hover/traffic:bg-[#FF5F57] dark:bg-[#565658]"
          }`}
        >
          <X
            className="size-2 text-black/55 opacity-0 transition-opacity group-hover/traffic:opacity-100"
            strokeWidth={3}
          />
        </button>
        <button
          type="button"
          aria-label={t("titlebar.minimizeWindow")}
          onClick={() => void controlWindow("minimize")}
          className={`grid size-3 place-items-center rounded-full shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.14)] transition-colors ${
            focused ? "bg-[#FEBC2E]" : "bg-[#c7c7c9] group-hover/traffic:bg-[#FEBC2E] dark:bg-[#565658]"
          }`}
        >
          <Minus
            className="size-2 text-black/55 opacity-0 transition-opacity group-hover/traffic:opacity-100"
            strokeWidth={3}
          />
        </button>
        <button
          type="button"
          aria-label={t("titlebar.fullscreenWindow")}
          onClick={() => void controlWindow("fullscreen")}
          className={`grid size-3 place-items-center rounded-full shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.14)] transition-colors ${
            focused ? "bg-[#28C840]" : "bg-[#c7c7c9] group-hover/traffic:bg-[#28C840] dark:bg-[#565658]"
          }`}
        >
          {/* Native zoom/fullscreen glyph: two filled triangles tucked into
              opposite corners, leaving a diagonal gap — not lucide's thin
              double-arrow, which reads wrong at this size. */}
          <svg
            viewBox="0 0 10 10"
            aria-hidden
            className="size-2 fill-current text-black/55 opacity-0 transition-opacity group-hover/traffic:opacity-100"
          >
            <path d="M1.4 1.4H6L1.4 6Z" />
            <path d="M8.6 8.6H4L8.6 4Z" />
          </svg>
        </button>
      </div>
      )}

      <div data-tauri-drag-region className="flex items-center gap-2.5">
        <img src="/parley.svg" alt="" className="h-5 w-5 rounded-[5px]" />
        <span className="text-sm font-semibold tracking-tight">{t("app.name")}</span>
        <span className="text-[11px] text-muted-foreground">
          {useRealPipeline ? t("app.subtitle.real") : t("app.subtitle.demo")}
        </span>
      </div>

      <div className="flex items-center gap-2">
        {replayMode ? (
          <>
            <div className="mr-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <FileAudio className="size-3.5 text-foreground/70" />
              <span className="max-w-[220px] truncate">{replayName}</span>
            </div>
            <Button size="sm" variant="outline" onClick={exitReplay} className="h-8">
              <LogOut className="size-3.5" />
              {t("replay.exit")}
            </Button>
          </>
        ) : (
          <>
            <div className="mr-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Circle
                className={`h-2 w-2 ${
                  recording ? "animate-pulse fill-red-500 text-red-500" : "fill-muted-foreground/40 text-muted-foreground/40"
                }`}
              />
              {recording
                ? t("titlebar.status.recording")
                : status === "stopped"
                ? t("titlebar.status.stopped")
                : t("titlebar.status.idle")}
            </div>
            {recording && <LevelMeter source="me" className="h-1.5 w-14" />}
            {!recording && isTauri() && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void uploadRecording()}
                disabled={!!ingestMsg}
                className="h-8"
              >
                {ingestMsg ? <Loader2 className="size-3.5 animate-spin" /> : <FileAudio className="size-3.5" />}
                {ingestMsg ?? t("replay.upload")}
              </Button>
            )}

            <Button
              size="sm"
              variant={recording ? "destructive" : "default"}
              onClick={toggle}
              disabled={!!ingestMsg || toggleBusy}
              className="h-8"
            >
              {recording ? <Square className="size-3.5" /> : <Mic className="size-3.5" />}
              {recording ? t("titlebar.stop") : t("titlebar.startMeeting")}
            </Button>
          </>
        )}

        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          aria-label={t("titlebar.history")}
          title={t("titlebar.history")}
          onClick={() => void openHistoryWindow()}
        >
          <History className="size-4" />
        </Button>

        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => void openSettingsWindow()}>
          <Settings className="size-4" />
        </Button>
      </div>
    </header>
  );
};
