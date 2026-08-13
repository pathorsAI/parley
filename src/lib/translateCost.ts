import { useEffect, useState } from "react";
import { useStore, meetingElapsedMs } from "./store";
import { isTauri } from "./tauriEvents";
import { TRANSLATE_USD_PER_MINUTE } from "./translateLanguages";

/**
 * Billed time of the current meeting's translate session, ticking at 1 Hz.
 *
 * The base is the meeting's pause-compacted clock ({@link meetingElapsedMs}):
 * the translate session opens with the meeting and uploads nothing while the
 * meeting is paused, so meeting elapsed IS translate elapsed. Reading the
 * store clock instead of keeping a private baseline keeps every surface
 * (interpreter strip, titlebar 🌐 menu, HUD seed) on the same number.
 */
export function useMeetingTranslateElapsed(): { active: boolean; elapsedSec: number } {
  const status = useStore((s) => s.meetingStatus);
  const enabled = useStore((s) => s.settings.meetingTranslateEnabled);
  // Meeting-paused counts as active: surfaces must survive a titlebar ⏸
  // (unmounting would reset their local state), they just freeze while paused.
  const active = (status === "recording" || status === "paused") && enabled && isTauri();
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (!active) {
      setElapsedSec(0);
      return;
    }
    const tick = () =>
      setElapsedSec(Math.floor(meetingElapsedMs(useStore.getState()) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [active]);

  return { active, elapsedSec };
}

/** "mm:ss" for a seconds count. */
export function formatElapsed(sec: number): string {
  const mm = String(Math.floor(sec / 60)).padStart(2, "0");
  const ss = String(sec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/** Estimated USD for `sec` seconds of translated audio, e.g. "0.123". */
export function translateCostUsd(sec: number): string {
  return ((sec / 60) * TRANSLATE_USD_PER_MINUTE).toFixed(3);
}
