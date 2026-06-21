import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "./tauriEvents";
import { log } from "./log";
import type { FindingSolutionEntry, TimelineEvent } from "./types";

// Cross-window protocol for the standalone "how to reply" window. The MAIN
// window is the source of truth and the only generator (it holds the transcript
// + settings); the solution window is a pure view that pulls state and asks for
// generation over these events. Mirrors the Settings multi-window pattern.
const FS_STATE = "finding-solution://state"; // main → window: the selected finding + its solution
const FS_HELLO = "finding-solution://hello"; // window → main: "I'm up, push me current state"
const FS_GENERATE = "finding-solution://generate"; // window → main: (re)generate this finding
const FS_CLOSE = "finding-solution://close"; // window → main: user closed the window

/** What the window renders: the selected finding and its (maybe pending) solution. */
export interface FindingSolutionState {
  finding: TimelineEvent | null;
  entry: FindingSolutionEntry | null;
}

/**
 * Open (or focus) the dedicated finding-solution window. Tauri only — in plain
 * browser dev the main window keeps rendering the in-app overlay instead, so
 * this is a no-op there.
 */
export async function openFindingSolutionWindow(): Promise<void> {
  if (!isTauri()) return;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel("finding-solution");
  if (existing) {
    await existing.setFocus();
    return;
  }
  log.info("finding-solution: open window");
  const win = new WebviewWindow("finding-solution", {
    url: "index.html#finding-solution",
    title: "Parley — How to reply",
    width: 420,
    height: 640,
    minWidth: 320,
    minHeight: 360,
    resizable: true,
  });
  win.once("tauri://error", (e) => log.error("finding-solution: window error", { error: String(e) }));
}

// ── Main-window (host) side ────────────────────────────────────────────────
/** Push the current selected finding + solution to the window. */
export async function broadcastFindingSolution(state: FindingSolutionState): Promise<void> {
  if (!isTauri()) return;
  await emit(FS_STATE, state);
}

/** Subscribe to the window's requests (hello / generate / close). */
export async function listenForFindingSolutionRequests(handlers: {
  onHello: () => void;
  onGenerate: (findingId: string) => void;
  onClose: () => void;
}): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  const un1 = await listen(FS_HELLO, () => handlers.onHello());
  const un2 = await listen<{ findingId: string }>(FS_GENERATE, (e) =>
    handlers.onGenerate(e.payload.findingId)
  );
  const un3 = await listen(FS_CLOSE, () => handlers.onClose());
  return () => {
    un1();
    un2();
    un3();
  };
}

// ── Window side ─────────────────────────────────────────────────────────────
/** Subscribe to state pushed from the main window. */
export async function listenForFindingSolutionState(
  onState: (s: FindingSolutionState) => void
): Promise<UnlistenFn> {
  if (!isTauri()) return () => {};
  return listen<FindingSolutionState>(FS_STATE, (e) => onState(e.payload));
}

/** Announce on mount so the main window pushes the current state (open race). */
export async function helloFindingSolution(): Promise<void> {
  if (isTauri()) await emit(FS_HELLO);
}

/** Ask the main window to (re)generate the solution for a finding. */
export async function requestFindingSolutionGenerate(findingId: string): Promise<void> {
  if (isTauri()) await emit(FS_GENERATE, { findingId });
}

/** Tell the main window the user dismissed the window → clear the selection. */
export async function closeFindingSolution(): Promise<void> {
  if (isTauri()) await emit(FS_CLOSE);
}
