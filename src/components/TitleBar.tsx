import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Circle, FileAudio, Loader2, LogOut, Maximize2, Mic, Minus, Settings, Square, X } from "lucide-react";
import { useStore } from "../lib/store";
import { STT_BY_ID, sttApiKey } from "../lib/transcription/providers";
import { startMockStream, stopMockStream } from "../lib/mockStream";
import { isTauri } from "../lib/tauriEvents";
import { openSettingsWindow } from "../lib/settingsSync";
import { useI18n } from "../i18n";
import { Button } from "@/components/ui/button";
import { LevelMeter } from "./LevelMeter";

/**
 * Custom window titlebar. The main Tauri window is undecorated, so this header
 * owns both the draggable region and the window controls.
 */
export function TitleBar() {
  const { t } = useI18n();
  const status = useStore((s) => s.meetingStatus);
  const transcriptionProvider = useStore((s) => s.settings.transcriptionProvider);
  const sttKey = useStore((s) => sttApiKey(s.settings, s.settings.transcriptionProvider));
  const inputDevice = useStore((s) => s.settings.inputDevice);
  const startMeeting = useStore((s) => s.startMeeting);
  const stopMeeting = useStore((s) => s.stopMeeting);
  const appMode = useStore((s) => s.appMode);
  const replayName = useStore((s) => s.replay?.name ?? "");
  const enterReplay = useStore((s) => s.enterReplay);
  const exitReplay = useStore((s) => s.exitReplay);
  const [ingestMsg, setIngestMsg] = useState<string | null>(null);

  const recording = status === "recording";
  const replayMode = appMode === "replay";
  const useRealPipeline = isTauri() && !!sttKey.trim();

  async function uploadRecording() {
    if (ingestMsg) return;
    const { settings } = useStore.getState();
    setIngestMsg(t("replay.preparing"));
    try {
      const { ingestRecording } = await import("../lib/replay/ingest");
      const session = await ingestRecording(settings, {
        onProgress: (p) => setIngestMsg(t(`replay.stage.${p.stage}` as never)),
      });
      if (session) enterReplay(session);
    } catch (e) {
      console.error("ingestRecording failed", e);
      setIngestMsg(null);
      window.alert(t("replay.failed", { error: e instanceof Error ? e.message : String(e) }));
      return;
    }
    setIngestMsg(null);
  }

  async function toggle() {
    if (recording) {
      stopMeeting();
      if (useRealPipeline) {
        try {
          await invoke("stop_meeting");
        } catch (e) {
          console.error("stop_meeting failed", e);
        }
      } else {
        stopMockStream();
      }
      return;
    }
    startMeeting();
    if (useRealPipeline) {
      try {
        await invoke("start_meeting", {
          provider: transcriptionProvider,
          apiKey: sttKey,
          diarization: STT_BY_ID[transcriptionProvider].diarization,
          inputDevice,
        });
      } catch (e) {
        console.error("start_meeting failed", e);
        stopMeeting();
      }
    } else {
      startMockStream();
    }
  }

  async function controlWindow(action: "close" | "minimize" | "maximize") {
    if (!isTauri()) return;
    const appWindow = getCurrentWindow();
    try {
      if (action === "close") await appWindow.close();
      if (action === "minimize") await appWindow.minimize();
      if (action === "maximize") await appWindow.toggleMaximize();
    } catch (e) {
      console.error(`window ${action} failed`, e);
    }
  }

  return (
    <header
      data-tauri-drag-region
      className="relative flex h-[52px] shrink-0 items-center justify-between border-b bg-background/85 pl-[104px] pr-3 backdrop-blur"
    >
      <div className="absolute left-4 top-1/2 flex -translate-y-1/2 items-center gap-2">
        <button
          type="button"
          aria-label={t("titlebar.closeWindow")}
          onClick={() => void controlWindow("close")}
          className="group grid size-3.5 place-items-center rounded-full bg-red-500 text-red-950 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.18)] transition hover:bg-red-400"
        >
          <X className="size-2.5 opacity-0 transition-opacity group-hover:opacity-75" strokeWidth={3} />
        </button>
        <button
          type="button"
          aria-label={t("titlebar.minimizeWindow")}
          onClick={() => void controlWindow("minimize")}
          className="group grid size-3.5 place-items-center rounded-full bg-yellow-500 text-yellow-950 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.18)] transition hover:bg-yellow-400"
        >
          <Minus className="size-2.5 opacity-0 transition-opacity group-hover:opacity-75" strokeWidth={3} />
        </button>
        <button
          type="button"
          aria-label={t("titlebar.maximizeWindow")}
          onClick={() => void controlWindow("maximize")}
          className="group grid size-3.5 place-items-center rounded-full bg-emerald-500 text-emerald-950 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.18)] transition hover:bg-emerald-400"
        >
          <Maximize2 className="size-2 opacity-0 transition-opacity group-hover:opacity-75" strokeWidth={3} />
        </button>
      </div>

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
              disabled={!!ingestMsg}
              className="h-8"
            >
              {recording ? <Square className="size-3.5" /> : <Mic className="size-3.5" />}
              {recording ? t("titlebar.stop") : t("titlebar.startMeeting")}
            </Button>
          </>
        )}

        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => void openSettingsWindow()}>
          <Settings className="size-4" />
        </Button>
      </div>
    </header>
  );
}
