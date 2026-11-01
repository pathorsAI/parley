import { isTauri } from "../platform";
import { log } from "../log";
import { isMeetingActive, useStore } from "../store";
import type { ParleyState } from "../store/types";
import { emitEvent, listenEvent, type UnlistenFn } from "../ipc/events";
import { floatingFrame, FLOATING_SIZE } from "./floatingWindow";
import { cancelActiveMeeting, endMeeting, toggleMeetingPause } from "./controls";
import { endSilentMeeting, keepRecording } from "./silenceGuard";

// The meeting window: a separate OS window that floats over the call while
// the main window stays the whole app. The MAIN window still records — it owns
// the capture, the transcript and the save — and is the source of truth; the
// meeting window mirrors the live state over these events and sends edits and
// commands back. Same shape as the finding-solution window (findingSolutionSync).
export const MEETING_WINDOW_LABEL = "meeting";
const STATE = "meeting-window://state"; // main → window: the mirrored keys
const HELLO = "meeting-window://hello"; // window → main: "I'm up, push me state"
const PATCH = "meeting-window://patch"; // window → main: fields edited there
const COMMAND = "meeting-window://command"; // window → main: run a meeting action

/** Store keys the meeting window mirrors from the main window. */
const MIRRORED = [
  "meetingStatus",
  "meetingStartedAt",
  "meetingPausedAt",
  "meetingPausedTotalMs",
  "isFinalizingMeeting",
  "liveMeetingId",
  "segments",
  "speakerNames",
  "findings",
  "analysisStatus",
  "systemAudioWarning",
  "transcriptionLink",
  "transcriptionNoAudioSources",
  "silencePromptAt",
  "meetingTitle",
  "meetingNotes",
  "meetingContext",
  "meetingBatna",
  "meetingTarget",
  "meetingFloor",
  "meetingFolderId",
  "meetingOrgShare",
  "todos",
  "autoAnalyze",
  "autoAnalyzeSec",
] as const satisfies readonly (keyof ParleyState)[];

/** Of those, the ones the meeting window edits; they travel back as patches. */
const EDITABLE = [
  "meetingTitle",
  "meetingNotes",
  "meetingContext",
  "meetingBatna",
  "meetingTarget",
  "meetingFloor",
  "meetingFolderId",
  "meetingOrgShare",
  "autoAnalyze",
  "autoAnalyzeSec",
  "systemAudioWarning",
] as const satisfies readonly (typeof MIRRORED)[number][];

type Mirrored = Pick<ParleyState, (typeof MIRRORED)[number]>;

export type MeetingCommand = "togglePause" | "end" | "cancel" | "analyze" | "keepRecording" | "endSilent";

function pick<K extends keyof ParleyState>(s: ParleyState, keys: readonly K[]): Pick<ParleyState, K> {
  const out = {} as Pick<ParleyState, K>;
  for (const k of keys) out[k] = s[k];
  return out;
}

/** True in the meeting window itself. */
export function isMeetingWindow(): boolean {
  return document.documentElement.dataset.appWindow === MEETING_WINDOW_LABEL;
}

/**
 * Run a meeting action from wherever the user pressed it: directly in the main
 * window (it records), as a command from the meeting window.
 */
export function meetingCommand(cmd: MeetingCommand): void {
  if (isMeetingWindow()) {
    void emitEvent(COMMAND, { cmd }).catch((error) =>
      log.warn("meeting-window: command failed to send", { cmd, error: String(error) }),
    );
    return;
  }
  runCommand(cmd);
}

function runCommand(cmd: MeetingCommand): void {
  const fail = (error: unknown) => log.error("meeting-window: command failed", { cmd, error: String(error) });
  switch (cmd) {
    case "togglePause":
      toggleMeetingPause();
      break;
    case "end":
      endMeeting().catch(fail);
      break;
    case "cancel":
      cancelActiveMeeting().catch(fail);
      break;
    case "analyze":
      void import("../analysis/engine").then((m) => m.runAnalysis({ mode: "live" })).catch(fail);
      break;
    case "keepRecording":
      keepRecording();
      break;
    case "endSilent":
      endSilentMeeting("confirmed").catch(fail);
      break;
  }
}

// ── Main window (host) ──────────────────────────────────────────────────────

async function openMeetingWindow(): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel(MEETING_WINDOW_LABEL);
  if (existing) {
    await existing.setFocus();
    return;
  }
  const { currentMonitor } = await import("@tauri-apps/api/window");
  const monitor = await currentMonitor();
  const area = monitor?.workArea;
  const frame =
    monitor && area
      ? floatingFrame(
          { width: area.size.width / monitor.scaleFactor, height: area.size.height / monitor.scaleFactor },
          { x: area.position.x / monitor.scaleFactor, y: area.position.y / monitor.scaleFactor },
        )
      : { ...FLOATING_SIZE, x: 40, y: 40 };
  log.info("meeting-window: open", frame);
  const win = new WebviewWindow(MEETING_WINDOW_LABEL, {
    url: "index.html#meeting",
    title: "Parley",
    ...frame,
    minWidth: 300,
    minHeight: 48,
    decorations: false,
    transparent: true,
    shadow: true,
    alwaysOnTop: true,
    resizable: true,
    focus: true,
  });
  win.once("tauri://error", (e) => log.error("meeting-window: window error", { error: String(e) }));
}

async function closeMeetingWindow(): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const win = await WebviewWindow.getByLabel(MEETING_WINDOW_LABEL);
  if (!win) return;
  log.info("meeting-window: close");
  await win.destroy();
}

/** Bring the meeting window to the front (the main title bar's recording pill). */
export async function focusMeetingWindow(): Promise<void> {
  if (!isTauri()) return;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const win = await WebviewWindow.getByLabel(MEETING_WINDOW_LABEL);
  if (win) {
    await win.show();
    await win.setFocus();
  } else {
    await openMeetingWindow();
  }
}

/**
 * Main window only: open the meeting window while a meeting records (and
 * until its save hands over to the report), keep it mirrored, and act on what
 * it sends back. Returns its teardown.
 */
export function initMeetingWindowHost(): () => void {
  if (!isTauri()) return () => {};
  const live = (s: ParleyState) => isMeetingActive(s.meetingStatus) || s.isFinalizingMeeting;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const broadcast = () => {
    clearTimeout(timer);
    timer = undefined;
    void emitEvent(STATE, pick(useStore.getState(), MIRRORED)).catch((error) =>
      log.warn("meeting-window: state broadcast failed", { error: String(error) }),
    );
  };
  // Transcript updates arrive many times a second; one push per 120 ms is
  // live enough for a caption and keeps the bridge from flooding.
  const scheduleBroadcast = () => {
    timer ??= setTimeout(broadcast, 120);
  };

  const unsubscribe = useStore.subscribe((next, prev) => {
    if (live(next) !== live(prev)) {
      void (live(next) ? openMeetingWindow() : closeMeetingWindow()).catch((error) =>
        log.warn("meeting-window: open/close failed", { error: String(error) }),
      );
    }
    if (MIRRORED.some((k) => next[k] !== prev[k])) scheduleBroadcast();
  });
  // A reload mid-meeting: the window may need opening (or closing) now.
  void (live(useStore.getState()) ? openMeetingWindow() : closeMeetingWindow()).catch(() => {});

  const unlisteners: Promise<UnlistenFn>[] = [
    listenEvent(HELLO, () => broadcast()),
    listenEvent<Partial<Mirrored>>(PATCH, (e) => {
      const patch: Partial<Mirrored> = {};
      for (const k of EDITABLE) if (k in e.payload) (patch as Record<string, unknown>)[k] = e.payload[k];
      useStore.setState(patch);
    }),
    listenEvent<{ cmd: MeetingCommand }>(COMMAND, (e) => runCommand(e.payload.cmd)),
  ];
  return () => {
    clearTimeout(timer);
    unsubscribe();
    for (const u of unlisteners) void u.then((fn) => fn()).catch(() => {});
  };
}

// ── Meeting window (client) ────────────────────────────────────────────────

/** A field typed here wins over the main window's echo for this long, so a
 *  late echo of the previous keystroke can't eat the next one. */
const LOCAL_EDIT_HOLD_MS = 1500;

/**
 * Meeting window only: mirror the main window's live state into this window's
 * store, and send this window's edits back. Returns its teardown.
 */
export function initMeetingWindowClient(): () => void {
  if (!isTauri()) return () => {};
  let applying = false;
  const editedAt: Partial<Record<(typeof EDITABLE)[number], number>> = {};

  const unState = listenEvent<Mirrored>(STATE, (e) => {
    const now = Date.now();
    const next = { ...e.payload } as Partial<Mirrored>;
    for (const k of EDITABLE) {
      if (now - (editedAt[k] ?? 0) < LOCAL_EDIT_HOLD_MS) delete next[k];
    }
    applying = true;
    useStore.setState(next);
    applying = false;
  });

  const unsubscribe = useStore.subscribe((next, prev) => {
    if (applying) return;
    const patch: Partial<Mirrored> = {};
    let any = false;
    for (const k of EDITABLE) {
      if (next[k] !== prev[k]) {
        (patch as Record<string, unknown>)[k] = next[k];
        editedAt[k] = Date.now();
        any = true;
      }
    }
    if (any) {
      void emitEvent(PATCH, patch).catch((error) =>
        log.warn("meeting-window: patch failed to send", { error: String(error) }),
      );
    }
  });

  void unState.then(() => emitEvent(HELLO, {})).catch(() => {});
  return () => {
    unsubscribe();
    void unState.then((fn) => fn()).catch(() => {});
  };
}
