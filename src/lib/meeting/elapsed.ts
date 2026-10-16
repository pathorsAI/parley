// The titlebar's live-meeting clock.

import { useEffect, useState } from "react";
import { useStore, meetingElapsedMs } from "../store";

/** Recorded time as MM:SS (minutes keep growing past 99). Pure. */
export function formatElapsedClock(ms: number): string {
  const sec = Math.floor(ms / 1000);
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

/**
 * Elapsed RECORDED time of the live meeting (wall time minus pauses — matching
 * the pause-compacted recording), ticking 1 Hz while recording. While paused
 * the value is frozen, so ticking is pointless; the transition re-renders it
 * once. Outside a meeting it keeps its last value ("00:00" before the first).
 */
export function useMeetingElapsed(meetingActive: boolean, paused: boolean, meetingStartedAt: number | null): string {
  const [elapsed, setElapsed] = useState("00:00");
  useEffect(() => {
    if (!meetingActive) return;
    const tick = () => {
      setElapsed(formatElapsedClock(meetingElapsedMs(useStore.getState())));
    };
    tick();
    if (paused) return;
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [meetingActive, paused, meetingStartedAt]);
  return elapsed;
}
