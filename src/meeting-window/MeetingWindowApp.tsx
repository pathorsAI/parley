import { useEffect } from "react";
import { useThemePreference } from "../lib/theme";
import { listenForSettings } from "../lib/settingsSync";
import { initMeetingWindowClient } from "../lib/meeting/meetingWindow";
import { log } from "../lib/log";
import { Toaster } from "@/components/ui/sonner";
import { MeetingFloatingWindow } from "../components/live/MeetingFloatingWindow";

/**
 * The floating meeting window (its own OS window, opened by the main window's
 * initMeetingWindowHost). A view of the meeting the main window records:
 * state is mirrored in, and edits and commands go back.
 */
export function MeetingWindowApp() {
  useThemePreference();
  useEffect(() => {
    const unClient = initMeetingWindowClient();
    const unSettings = listenForSettings();
    return () => {
      unClient();
      void unSettings.then((fn) => fn()).catch((error) =>
        log.warn("meeting-window: settings unlisten failed", { error: String(error) }),
      );
    };
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden rounded-[12px] bg-background text-foreground">
      <Toaster />
      <MeetingFloatingWindow />
    </div>
  );
}
