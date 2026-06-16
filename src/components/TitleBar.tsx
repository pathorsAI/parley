import { invoke } from "@tauri-apps/api/core";
import { Mic, Square, Settings, Circle } from "lucide-react";
import { useStore } from "../lib/store";
import { startMockStream, stopMockStream } from "../lib/mockStream";
import { isTauri } from "../lib/tauriEvents";
import { openSettingsWindow } from "../lib/settingsSync";
import { Button } from "@/components/ui/button";
import { LevelMeter } from "./LevelMeter";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Custom window titlebar. With macOS `titleBarStyle: Overlay`, the native
 * traffic lights float over the top-left of this bar — `pl-20` keeps our content
 * clear of them, and `data-tauri-drag-region` makes the empty areas draggable.
 * Interactive controls sit above the drag region and stay clickable.
 */
export function TitleBar() {
  const status = useStore((s) => s.meetingStatus);
  const provider = useStore((s) => s.settings.provider);
  const sonioxApiKey = useStore((s) => s.settings.sonioxApiKey);
  const inputDevice = useStore((s) => s.settings.inputDevice);
  const updateSettings = useStore((s) => s.updateSettings);
  const startMeeting = useStore((s) => s.startMeeting);
  const stopMeeting = useStore((s) => s.stopMeeting);

  const recording = status === "recording";
  const useRealPipeline = isTauri() && !!sonioxApiKey.trim();

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
        await invoke("start_meeting", { sonioxApiKey, inputDevice });
      } catch (e) {
        console.error("start_meeting failed", e);
        stopMeeting();
      }
    } else {
      startMockStream();
    }
  }

  return (
    <header
      data-tauri-drag-region
      className="flex h-12 shrink-0 items-center justify-between border-b bg-background/80 pl-20 pr-3 backdrop-blur"
    >
      <div data-tauri-drag-region className="flex items-center gap-2.5">
        <img src="/parley.svg" alt="" className="h-5 w-5 rounded-[5px]" />
        <span className="text-sm font-semibold tracking-tight">Parley</span>
        <span className="text-[11px] text-muted-foreground">
          {useRealPipeline ? "meeting copilot" : "demo"}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <div className="mr-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Circle
            className={`h-2 w-2 ${
              recording ? "animate-pulse fill-red-500 text-red-500" : "fill-muted-foreground/40 text-muted-foreground/40"
            }`}
          />
          {recording ? "Recording" : status === "stopped" ? "Stopped" : "Idle"}
        </div>
        {recording && <LevelMeter source="me" className="h-1.5 w-14" />}

        <Select
          value={provider}
          onValueChange={(v) => updateSettings({ provider: v as "anthropic" | "openrouter" })}
        >
          <SelectTrigger size="sm" className="h-8 w-[120px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="anthropic">Claude</SelectItem>
            <SelectItem value="openrouter">OpenRouter</SelectItem>
          </SelectContent>
        </Select>

        <Button
          size="sm"
          variant={recording ? "destructive" : "default"}
          onClick={toggle}
          className="h-8"
        >
          {recording ? <Square className="size-3.5" /> : <Mic className="size-3.5" />}
          {recording ? "Stop" : "Start meeting"}
        </Button>

        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => void openSettingsWindow()}>
          <Settings className="size-4" />
        </Button>
      </div>
    </header>
  );
}
