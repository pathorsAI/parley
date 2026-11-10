// "Another app started a call — record it?" (issue #606), the wiring.
//
// The backend watcher (meeting_detect.rs) reports a call; the MAIN window
// decides whether to ask, opens the small prompt window over the call, and —
// because the main window is the one that records — runs whatever the user
// picks there. The prompt window only shows the question and sends the answer
// back, the same split as the floating meeting window (meetingWindow.ts).
import { isTauri } from "../platform";
import { log } from "../log";
import { isLiveMeetingActive, isMeetingActive, useLiveStore, useStore } from "../store";
import type { ParleyState } from "../store/types";
import * as ipc from "../ipc/commands";
import {
  MEETING_DETECTED_EVENT,
  MEETING_DETECT_ENDED_EVENT,
  emitEvent,
  listenEvent,
  type UnlistenFn,
} from "../ipc/events";
import { beginMeeting, isStartingMeeting } from "./start";
import { muteApp, pickDraftNear, promptFrame, PROMPT_SIZE, shouldPrompt, type MicAppPayload } from "./detect";

export const MEETING_PROMPT_LABEL = "meeting-prompt";
const HELLO = "meeting-prompt://hello"; // prompt → main: "I'm up, send the question"
const STATE = "meeting-prompt://state"; // main → prompt: the question
const ACTION = "meeting-prompt://action"; // prompt → main: the answer

/** What the prompt shows. */
export interface PromptState {
  app: MicAppPayload;
  /** A draft scheduled around now: Start records from it. */
  draft: { id: string; title: string } | null;
}

export type PromptAction = "start" | "dismiss" | "mute";

// ── Main window (host) ──────────────────────────────────────────────────────

async function promptWindow() {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return WebviewWindow.getByLabel(MEETING_PROMPT_LABEL);
}

/** The work area of the screen the pointer is on (the one the user is
 *  looking at), in logical px. */
async function activeScreenArea(): Promise<{ x: number; y: number; width: number } | null> {
  const { cursorPosition, monitorFromPoint, primaryMonitor } = await import("@tauri-apps/api/window");
  let monitor = null;
  try {
    const at = await cursorPosition();
    monitor = await monitorFromPoint(at.x, at.y);
  } catch (error) {
    log.warn("meeting-prompt: pointer screen lookup failed", { error: String(error) });
  }
  monitor ??= await primaryMonitor();
  if (!monitor) return null;
  const f = monitor.scaleFactor;
  const a = monitor.workArea;
  return { x: a.position.x / f, y: a.position.y / f, width: a.size.width / f };
}

async function openPromptWindow(): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const area = await activeScreenArea();
  const frame = area ? promptFrame(area) : { x: 40, y: 40, ...PROMPT_SIZE };
  log.info("meeting-prompt: open", frame);
  const win = new WebviewWindow(MEETING_PROMPT_LABEL, {
    url: `index.html#${MEETING_PROMPT_LABEL}`,
    title: "Parley",
    ...frame,
    decorations: false,
    transparent: true,
    // The pill draws its own shadow inside the transparent margin.
    shadow: false,
    alwaysOnTop: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    visibleOnAllWorkspaces: true,
    // Never take the keyboard from the call it is asking about.
    focus: false,
  });
  win.once("tauri://error", (e) => log.error("meeting-prompt: window error", { error: String(e) }));
}

/**
 * Main window only: keep the backend watcher in step with the setting, ask
 * when it reports a call, and act on the answer. Returns its teardown.
 */
export function initMeetingDetect(): () => void {
  if (!isTauri()) return () => {};
  let current: PromptState | null = null;

  const syncWatcher = (s: ParleyState) => {
    const { meetingDetectEnabled: enabled, meetingDetectMutedApps: muted } = s.settings;
    void ipc
      .setMeetingDetection({ enabled, mutedApps: muted.map((m) => m.id) })
      .catch((error) => log.warn("meeting-prompt: watcher update failed", { error: String(error) }));
  };

  const close = () => {
    if (!current) return;
    current = null;
    void promptWindow()
      .then((win) => win?.destroy())
      .catch((error) => log.warn("meeting-prompt: close failed", { error: String(error) }));
  };

  const show = async (state: PromptState) => {
    current = state;
    if (await promptWindow()) await emitEvent(STATE, state);
    else await openPromptWindow();
  };

  const onDetected = (app: MicAppPayload) => {
    const s = useStore.getState();
    const live = useLiveStore.getState();
    const ask = shouldPrompt({
      enabled: s.settings.meetingDetectEnabled,
      meetingStatus: live.meetingStatus,
      finalizing: live.isFinalizingMeeting,
      starting: isStartingMeeting(),
      muted: s.settings.meetingDetectMutedApps,
      app,
    });
    log.info("meeting-prompt: call detected", { app: app.appId, kind: app.kind, ask });
    if (!ask) return;
    const draft = pickDraftNear(s.drafts, Date.now());
    void show({ app, draft: draft ? { id: draft.id, title: draft.title } : null }).catch((error) =>
      log.warn("meeting-prompt: show failed", { error: String(error) }),
    );
  };

  const onAction = (action: PromptAction) => {
    const state = current;
    log.info("meeting-prompt: answered", { action, app: state?.app.appId });
    close();
    if (!state) return;
    if (action === "mute") {
      const s = useStore.getState();
      s.updateSettings({ meetingDetectMutedApps: muteApp(s.settings.meetingDetectMutedApps, state.app) });
    } else if (action === "start") {
      void startFromPrompt(state.draft?.id ?? null);
    }
  };

  const unsubscribe = useStore.subscribe((next, prev) => {
    if (
      next.settings.meetingDetectEnabled !== prev.settings.meetingDetectEnabled ||
      next.settings.meetingDetectMutedApps !== prev.settings.meetingDetectMutedApps
    ) {
      syncWatcher(next);
      if (!next.settings.meetingDetectEnabled) close();
    }
  });
  // Recording started some other way: the question is answered.
  const unsubscribeLive = useLiveStore.subscribe((next, prev) => {
    if (isMeetingActive(next.meetingStatus) && !isMeetingActive(prev.meetingStatus)) close();
  });
  syncWatcher(useStore.getState());
  // A reload while a prompt was up: it has nobody to answer to any more.
  void promptWindow()
    .then((win) => win?.destroy())
    .catch(() => {});

  const unlisteners: Promise<UnlistenFn>[] = [
    listenEvent(MEETING_DETECTED_EVENT, (e) => onDetected(e.payload)),
    listenEvent(MEETING_DETECT_ENDED_EVENT, (e) => {
      if (current && current.app.appId === e.payload.appId) {
        log.info("meeting-prompt: call ended before an answer", { app: e.payload.appId });
        close();
      }
    }),
    listenEvent(HELLO, () => {
      if (current) void emitEvent(STATE, current).catch(() => {});
      else close();
    }),
    listenEvent<{ action: PromptAction }>(ACTION, (e) => onAction(e.payload.action)),
  ];
  return () => {
    unsubscribe();
    unsubscribeLive();
    for (const u of unlisteners) void u.then((fn) => fn()).catch(() => {});
  };
}

/** Start recording the way the app's own Start does — from the draft when one
 *  is due. A start that was refused (no key, signed out) explains itself in
 *  the main window, so bring that window up. */
async function startFromPrompt(draftId: string | null): Promise<void> {
  try {
    // A draft that is gone (or a meeting already running) falls back to
    // the plain start, which explains a running meeting itself.
    if (draftId) useStore.getState().takeDraft(draftId);
    await beginMeeting();
  } catch (error) {
    log.error("meeting-prompt: start failed", { error: String(error) });
  }
  if (isLiveMeetingActive()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    await win.show();
    await win.setFocus();
  } catch (error) {
    log.warn("meeting-prompt: showing the main window failed", { error: String(error) });
  }
}

// ── Prompt window (client) ─────────────────────────────────────────────────

/** Prompt window only: receive the question. Returns its teardown. */
export function initMeetingPromptClient(onState: (state: PromptState) => void): () => void {
  if (!isTauri()) return () => {};
  const unState = listenEvent<PromptState>(STATE, (e) => onState(e.payload));
  void unState.then(() => emitEvent(HELLO, {})).catch(() => {});
  return () => {
    void unState.then((fn) => fn()).catch(() => {});
  };
}

/** Prompt window only: send the answer to the main window, which closes it. */
export function sendPromptAction(action: PromptAction): void {
  void emitEvent(ACTION, { action }).catch((error) =>
    log.warn("meeting-prompt: answer failed to send", { action, error: String(error) }),
  );
}

/** Prompt window only: grow the window under the pill for the chevron's menu,
 *  or shrink it back, so the transparent margin never covers more of the call
 *  than it must. */
export async function setPromptWindowHeight(height: number): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setSize(new LogicalSize(PROMPT_SIZE.width, height));
  } catch (error) {
    log.warn("meeting-prompt: resize failed", { height, error: String(error) });
  }
}
