/**
 * The guided lap: the guide bar that walks a new user through their first
 * recording on the study page — see what Parley did (the rename-and-file
 * suggestion), replay it, hand it to their AI.
 *
 * v1 had only the Home checklist. It ticked correctly, but once its CTA had
 * taken the user to the Report or Replay page nothing there said what to do, so
 * it never felt like onboarding. The bar is that missing voice, on the page
 * where the action is.
 *
 * Nothing here is stored. The step is DERIVED from the same getting-started
 * flags the checklist reads (`filed → replayed → handedOff`, first not done), so
 * every route to an outcome — the bar's CTA, the titlebar, the library, an MCP
 * call — advances it. The only time-based state is the "✓ then advance" beat:
 * when a flag flips, the bar holds a confirmation of the step just done for
 * {@link LAP_CONFIRM_MS} before it teaches the next one.
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { GettingStartedState } from "../types";
import { isGettingStartedVisible, markGettingStarted } from "./gettingStarted";
import { isSampleEntry } from "./sample";

/** The three steps the bar teaches, in order. `recorded` is already true once
 *  there is an entry to be on. */
export type LapStep = "filed" | "replayed" | "handedOff";
/** What the bar is on: a step, or the closing "done" card. */
export type LapPhase = LapStep | "done";

export const LAP_STEPS: readonly LapStep[] = ["filed", "replayed", "handedOff"];
const LAP_ORDER: readonly LapPhase[] = [...LAP_STEPS, "done"];

/** How long the ✓ line for a just-finished step stays before the next step. */
export const LAP_CONFIRM_MS = 1500;

type LapFlags = Pick<GettingStartedState, LapStep>;

/** The first step not yet done, or "done". */
export function lapPhase(flags: LapFlags): LapPhase {
  return LAP_STEPS.find((step) => !flags[step]) ?? "done";
}

export interface LapEligibilityInput {
  gettingStarted: GettingStartedState;
  /** The open recording's id (null when nothing saved is open). */
  entryId: string | null;
  /** A read-only org copy, or a session with no local entry behind it. */
  readOnly: boolean;
  /** How many recordings are in the personal library. */
  libraryCount: number;
}

/**
 * Should the bar be on this page? Only while the checklist itself is live, and
 * only on the recording the lap is about: the sample, or the user's one and
 * only recording. With a second recording the user is past "first time", and a
 * bar on every page would be noise. Never on an org copy, which can't be filed.
 */
export function isLapEligible({
  gettingStarted,
  entryId,
  readOnly,
  libraryCount,
}: LapEligibilityInput): boolean {
  if (readOnly || !entryId) return false;
  if (!isGettingStartedVisible(gettingStarted)) return false;
  return isSampleEntry({ id: entryId }) || libraryCount <= 1;
}

export interface LapView {
  phase: LapPhase;
  /** The step that just finished; while set, the bar shows its ✓ line instead
   *  of teaching `phase`. Clears {@link LAP_CONFIRM_MS} after the flip. */
  justCompleted: LapStep | null;
}

export interface LapTimer {
  view(): LapView;
  /** Feed the latest flags; emits when the view changes. */
  update(flags: LapFlags): void;
  dispose(): void;
}

/**
 * The "✓ then advance" beat, framework-free so it can be tested with fake
 * timers. The initial flags never produce a ✓ — only a flip seen while the bar
 * is up does. The ✓ names the step the bar WAS teaching (steps done out of
 * order were already done). Advancing into "done" has no hold: the done card
 * is its own confirmation. Going backwards (a reset) just re-derives.
 */
export function createLapTimer(
  initial: LapFlags,
  onChange: (view: LapView) => void,
  holdMs: number = LAP_CONFIRM_MS,
): LapTimer {
  let phase = lapPhase(initial);
  let justCompleted: LapStep | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const emit = () => onChange({ phase, justCompleted });

  return {
    view: () => ({ phase, justCompleted }),
    update(flags) {
      const next = lapPhase(flags);
      if (next === phase) return;
      const advanced = LAP_ORDER.indexOf(next) > LAP_ORDER.indexOf(phase);
      clear();
      justCompleted = advanced && next !== "done" && phase !== "done" ? phase : null;
      phase = next;
      if (justCompleted) {
        timer = setTimeout(() => {
          timer = null;
          justCompleted = null;
          emit();
        }, holdMs);
      }
      emit();
    },
    dispose: clear,
  };
}

/** {@link createLapTimer} as React state. */
export function useLapView(flags: LapFlags): LapView {
  const [view, setView] = useState<LapView>(() => ({ phase: lapPhase(flags), justCompleted: null }));
  const timer = useRef<LapTimer | null>(null);
  const latest = useRef(flags);
  latest.current = flags;
  useEffect(() => {
    const t = createLapTimer(latest.current, setView);
    timer.current = t;
    return () => {
      t.dispose();
      timer.current = null;
    };
  }, []);
  const { filed, replayed, handedOff } = flags;
  useEffect(() => {
    timer.current?.update({ filed, replayed, handedOff });
  }, [filed, replayed, handedOff]);
  return view;
}

/** What the study page's pieces need to know about the lap. */
export interface LapState extends LapView {
  /** The bar is on screen. Hints that would repeat it stay quiet. */
  visible: boolean;
  /** Hide the bar for this recording (the done card's "close"). */
  close: () => void;
}

export const LAP_HIDDEN: LapState = {
  visible: false,
  phase: "done",
  justCompleted: null,
  close: () => {},
};

/**
 * Provided by StudyScreen, read by the guide bar and by the in-page hints and
 * the transcript pulse. Anything outside a study page (the ingest wizard's
 * transcript preview) reads {@link LAP_HIDDEN}.
 */
export const LapContext = createContext<LapState>(LAP_HIDDEN);

export function useLapContext(): LapState {
  return useContext(LapContext);
}

/**
 * The lap for the open recording. Visible while eligible; once the last step
 * lands, the checklist is complete and eligibility ends — but the bar that was
 * already up stays for its done card until the user closes it or leaves the
 * recording. Reopening afterwards shows nothing.
 */
export function useLapState(input: LapEligibilityInput): LapState {
  const { gettingStarted: gs, entryId } = input;
  const view = useLapView(gs);
  const eligible = isLapEligible(input);
  // The recording the bar has been up on, so completion doesn't yank it away.
  const [shownFor, setShownFor] = useState<string | null>(eligible ? entryId : null);
  const [closedFor, setClosedFor] = useState<string | null>(null);
  if (eligible && entryId && shownFor !== entryId) setShownFor(entryId);
  // A recording is open, so "recorded" is simply true — a checklist reset with
  // recordings already in the library would otherwise leave it unticked after
  // the lap, and the checklist would never finish.
  const needsRecorded = eligible && !gs.recorded;
  useEffect(() => {
    if (needsRecorded) markGettingStarted("recorded");
  }, [needsRecorded]);

  const finishing =
    !eligible &&
    !!entryId &&
    shownFor === entryId &&
    !input.readOnly &&
    gs.dismissedAt === null &&
    view.phase === "done";
  const visible = (eligible || finishing) && closedFor !== entryId;

  return {
    ...view,
    visible,
    close: () => setClosedFor(entryId),
  };
}
