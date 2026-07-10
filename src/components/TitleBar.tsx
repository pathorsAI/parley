import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Circle, FileAudio, History, Languages, Loader2, LogOut, Mic, Minus, Settings, Square, X } from "lucide-react";
import { useStore } from "../lib/store";
import { log } from "../lib/log";
import { STT_BY_ID, sttApiKey, sttRelayUrl } from "../lib/transcription/providers";
import { toast } from "sonner";
import { startMockStream, stopMockStream } from "../lib/mockStream";
import { isTauri } from "../lib/tauriEvents";
import { openSettingsWindow } from "../lib/settingsSync";
import { openHistoryWindow } from "../lib/history/history";
import { openLiveTranslateWindow } from "../lib/liveTranslate";
import { useI18n } from "../i18n";
import { Button } from "@/components/ui/button";
import { LevelMeter } from "./LevelMeter";
import { SaveDestinationPicker } from "./SaveDestinationPicker";

type TFn = ReturnType<typeof useI18n>["t"];
type WindowAction = "close" | "minimize" | "fullscreen";

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
    async function connectFocusEvents() {
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
    }
    connectFocusEvents().catch((error) => log.warn("window: focus listener failed", { error: String(error) }));
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);
  return focused;
}


function TrafficLights({
  focused,
  onAction,
  t,
}: Readonly<{
  focused: boolean;
  onAction: (action: WindowAction) => void;
  t: TFn;
}>) {
  const closeColor = focused ? "bg-[#FF5F57]" : "bg-[#c7c7c9] group-hover/traffic:bg-[#FF5F57] dark:bg-[#565658]";
  const minimizeColor = focused ? "bg-[#FEBC2E]" : "bg-[#c7c7c9] group-hover/traffic:bg-[#FEBC2E] dark:bg-[#565658]";
  const fullscreenColor = focused ? "bg-[#28C840]" : "bg-[#c7c7c9] group-hover/traffic:bg-[#28C840] dark:bg-[#565658]";

  return (
    <div className="group/traffic absolute left-4 top-1/2 flex -translate-y-1/2 items-center gap-2">
      <button
        type="button"
        aria-label={t("titlebar.closeWindow")}
        onClick={() => onAction("close")}
        className={`grid size-3 place-items-center rounded-full shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.14)] transition-colors ${closeColor}`}
      >
        <X
          className="size-2 text-black/55 opacity-0 transition-opacity group-hover/traffic:opacity-100"
          strokeWidth={3}
        />
      </button>
      <button
        type="button"
        aria-label={t("titlebar.minimizeWindow")}
        onClick={() => onAction("minimize")}
        className={`grid size-3 place-items-center rounded-full shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.14)] transition-colors ${minimizeColor}`}
      >
        <Minus
          className="size-2 text-black/55 opacity-0 transition-opacity group-hover/traffic:opacity-100"
          strokeWidth={3}
        />
      </button>
      <button
        type="button"
        aria-label={t("titlebar.fullscreenWindow")}
        onClick={() => onAction("fullscreen")}
        className={`grid size-3 place-items-center rounded-full shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.14)] transition-colors ${fullscreenColor}`}
      >
        {/* Native zoom/fullscreen glyph: two filled triangles tucked into opposite corners. */}
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
  );
}

/**
 * Custom window titlebar. The main Tauri window is undecorated, so this header
 * owns both the draggable region and the window controls.
 *
 * In fullscreen there are no window controls (macOS hides the traffic lights and
 * reveals its own menu bar at the top edge), so we drop our traffic lights and
 * let the logo + brand sit at the leading edge.
 */
export function TitleBar({ fullscreen = false }: Readonly<{ fullscreen?: boolean }>) {
  const { t } = useI18n();
  const focused = useWindowFocused();
  const status = useStore((s) => s.meetingStatus);
  const transcriptionProvider = useStore((s) => s.settings.transcriptionProvider);
  const sttKey = useStore((s) => sttApiKey(s.settings, s.settings.transcriptionProvider));
  const inputDevice = useStore((s) => s.settings.inputDevice);
  const startMeeting = useStore((s) => s.startMeeting);
  const stopMeeting = useStore((s) => s.stopMeeting);
  const translateEnabled = useStore((s) => s.settings.meetingTranslateEnabled);
  const translateLanguage = useStore((s) => s.settings.translateTargetLanguage);
  const translateOutputDevice = useStore((s) => s.settings.translateOutputDevice);
  const geminiApiKey = useStore((s) => s.settings.geminiApiKey);
  const layout = useStore((s) => s.settings.layout);
  const updateSettings = useStore((s) => s.updateSettings);
  const saveLocation = useStore((s) => s.settings.defaultSaveLocation);
  const syncEnabled = useStore((s) => s.settings.syncEnabled);
  const meetingStartedAt = useStore((s) => s.meetingStartedAt);
  const [elapsed, setElapsed] = useState("00:00");
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

  // Vitals timer (top-left): elapsed since the meeting started, ticking 1 Hz.
  useEffect(() => {
    if (!recording) return;
    const tick = () => {
      const sec = Math.max(0, Math.floor((Date.now() - (meetingStartedAt ?? Date.now())) / 1000));
      setElapsed(
        `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [recording, meetingStartedAt]);
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
      // Meeting translation needs its own (Gemini) key on top of the STT key;
      // refuse loudly rather than silently starting an untranslated meeting.
      if (useRealPipeline && translateEnabled && !geminiApiKey.trim()) {
        toast.error(t("meeting.translate.noKey"));
        return;
      }
      startMeeting();
      if (useRealPipeline) {
        log.info("meeting: start requested", {
          provider: transcriptionProvider,
          model: STT_BY_ID[transcriptionProvider].label,
          diarization: STT_BY_ID[transcriptionProvider].diarization,
          inputDevice,
          translate: translateEnabled ? translateLanguage : "off",
          pipeline: "real",
        });
        try {
          // Hosted "parley" STT: relay audio through Parley Cloud (cloud WSS URL
          // + the session token as apiKey, via sttApiKey). BYOK providers send no
          // relay URL and connect straight to their vendor.
          const relayUrl = sttRelayUrl(transcriptionProvider);
          await invoke("start_meeting", {
            provider: transcriptionProvider,
            apiKey: sttKey,
            diarization: STT_BY_ID[transcriptionProvider].diarization,
            inputDevice,
            relayUrl,
            // Meeting translation (off → nulls): "me" runs through Gemini
            // live-translate; the voice goes out the translate output device.
            translateLanguage: translateEnabled ? translateLanguage : null,
            translateOutputDevice: translateEnabled ? translateOutputDevice || null : null,
            translateApiKey: translateEnabled ? geminiApiKey : null,
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

  async function controlWindow(action: WindowAction) {
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
      {!fullscreen && <TrafficLights focused={focused} onAction={controlWindow} t={t} />}

      {/* Top-left: information, not brand (macOS's menu bar already says
          Parley). Idle → where this meeting will save (org/folder menu, no
          Settings trip); recording → the session vitals (rec + elapsed + mic
          level + translation). */}
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-2">
        {!replayMode && !recording && (
          <SaveDestinationPicker
            compact
            value={saveLocation}
            syncOn={syncEnabled}
            onChange={(loc) => updateSettings({ defaultSaveLocation: loc })}
          />
        )}
        {recording && (
          <>
            <span className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
              <Circle className="h-2 w-2 animate-pulse fill-red-500 text-red-500" />
              {elapsed}
            </span>
            <LevelMeter source="me" className="h-1.5 w-14" />
            {translateEnabled && (
              <span className="flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <Languages className="size-3.5" />
                {translateLanguage.toUpperCase()}
              </span>
            )}
          </>
        )}
      </div>

      {/* Titlebar-center posture switcher (live only): coach / transcript /
          glance. Replaces the layout preference buried in Settings. */}
      {!replayMode && (
        <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-0.5 rounded-lg bg-muted p-0.5">
          {(["coach", "transcript"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => updateSettings({ layout: mode })}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                layout === mode
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t(`layout.${mode}`)}
            </button>
          ))}
        </div>
      )}

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
            {!recording && isTauri() && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => uploadRecording()}
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
          aria-label={t("titlebar.liveTranslate")}
          title={t("titlebar.liveTranslate")}
          onClick={() => openLiveTranslateWindow().catch((error) => log.error("live-translate: open window failed", { error: String(error) }))}
        >
          <Languages className="size-4" />
        </Button>

        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          aria-label={t("titlebar.history")}
          title={t("titlebar.history")}
          onClick={() => openHistoryWindow().catch((error) => log.error("history: open window failed", { error: String(error) }))}
        >
          <History className="size-4" />
        </Button>

        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          onClick={() => openSettingsWindow().catch((error) => log.error("settings: open window failed", { error: String(error) }))}
        >
          <Settings className="size-4" />
        </Button>
      </div>
    </header>
  );
};
