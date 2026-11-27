// The store adapter for the opening card (meeting/opening.ts holds the rules):
// while the card is up, watch the transcript and retire it once the user has
// said the opening — or a few minutes in, said or not. Runs in the MAIN window,
// against the live store; the meeting window mirrors the result.

import { useEffect } from "react";
import { log } from "../log";
import { useLiveStore } from "../store";
import { meetingElapsedMs } from "../store/meeting";
import { finalTurns } from "./liveSuggest";
import { OPENING_MAX_MS, openingSaid, openingShowing } from "./opening";

/** How often the transcript is checked. */
const TICK_MS = 1_000;

/** Retire the opening card when it has had its moment. Exported for tests. */
export function retireOpeningIfDone(): void {
  const s = useLiveStore.getState();
  if (!openingShowing(s)) return;
  if (openingSaid(s.meetingOpening, finalTurns(s.segments))) {
    log.info("opening: said, card retired");
    s.dismissOpening();
  } else if (meetingElapsedMs(s) >= OPENING_MAX_MS) {
    log.info("opening: not said in time, card retired");
    s.dismissOpening();
  }
}

/** Mounted once in the main window (App.tsx). */
export function useOpeningRetire(): void {
  const showing = useLiveStore(openingShowing);
  useEffect(() => {
    if (!showing) return;
    const id = setInterval(retireOpeningIfDone, TICK_MS);
    return () => clearInterval(id);
  }, [showing]);
}
