import { useLiveStore, useStore, transcriptAsText } from "./store";
import type { ParleyState } from "./store/types";
import type { MeetingStatus } from "./types";
import { isTauri } from "./tauriEvents";
import * as ipc from "./ipc/commands";
import { createDebouncer } from "./debounce";

/**
 * The ONE session the MCP mirror describes, and the one MCP commands
 * (add_todo, *_finding, …) act on. The app can hold two at once: a recording
 * the main window has loaded (useStore) and a running meeting (useLiveStore).
 * MCP has a single "current session", so:
 *
 *  - a recording loaded in the main window wins — it is what the user is
 *    looking at there (and what the replay-oriented tools refer to);
 *  - otherwise the live meeting, while there is one (recording, paused, or
 *    stopped and not yet replaced by its report);
 *  - otherwise the main window (nothing loaded, nothing live).
 */
export function mcpSession(): { kind: "recording" | "live" | "none"; state: ParleyState } {
  const main = useStore.getState();
  if (main.replay) return { kind: "recording", state: main };
  const live = useLiveStore.getState();
  if (live.liveMeetingId != null && live.meetingStatus !== "idle") return { kind: "live", state: live };
  return { kind: "none", state: main };
}

/**
 * Mirror the live meeting state to `<appConfigDir>/session.json`, which the
 * built-in MCP server reads so clients (Claude, etc.) can see the current
 * transcript, todos, and evaluation results in real time. One-way for now:
 * the app writes, MCP reads.
 *
 * `context` tells MCP clients WHAT the user is focused on — a live meeting, the
 * post-meeting report, or a replay of a saved recording. Without it, a client
 * seeing meetingStatus "stopped" plus a lingering transcript can't tell "meeting
 * just ended" from "reviewing an old recording" (mcp.rs turns these fields into
 * the focusSummary the tools return).
 */
function snapshot() {
  const main = useStore.getState();
  const { kind, state: s } = mcpSession();
  // A loaded recording reads as a finished session ("stopped"), the way the
  // MCP side has always been told; the live meeting as its own status.
  let meetingStatus: MeetingStatus = "idle";
  if (kind === "live") meetingStatus = s.meetingStatus;
  else if (kind === "recording") meetingStatus = "stopped";
  return {
    meetingStatus,
    updatedAt: Date.now(),
    context: {
      // The live meeting has its own window: say so, whatever route the main
      // window is on.
      appMode: kind === "live" ? "live" : main.appMode,
      studyTab: kind === "recording" && main.appMode === "study" ? main.studyTab : null,
      replay: s.replay
        ? {
            id: s.replay.id,
            name: s.replay.name,
            /** Id in the local history library; null = unsaved upload or an org
             *  recording viewed read-only. */
            savedHistoryId: s.loadedHistoryId,
            durationMs: s.replay.durationMs,
            createdAt: s.replay.createdAt,
          }
        : null,
    },
    transcript: {
      text: transcriptAsText(s.segments, s.speakerNames),
      segmentCount: s.segments.filter((seg) => seg.isFinal && seg.text.trim()).length,
    },
    todos: s.todos,
    evaluations: s.evaluations.map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
      status: e.status,
      lastRunAt: e.lastRunAt,
      result: e.result ?? null,
    })),
    // Timeline-analysis findings, exposed verbatim so an MCP client can read,
    // overwrite, or edit them (see the *_finding tools / sessionCommands).
    findings: s.findings,
    // Everything else Parley's own analysis has produced for the LOADED content
    // (the live meeting, or the recording under replay — the store holds
    // whichever is on screen). Mirrored so MCP clients always get the full
    // analyzed picture alongside the raw transcript, clearly labelled as
    // Parley's prior analysis (context, not ground truth) on the MCP side.
    brief: s.brief,
    actionItems: s.actionItems,
    deliveryAssessment: s.deliveryAssessment,
  };
}

async function writeSession(): Promise<void> {
  try {
    await ipc.writeSession({ json: JSON.stringify(snapshot()) });
  } catch (e) {
    console.warn("[session] write failed", e);
  }
}

/** Start mirroring session state to disk. Returns a teardown function. */
export function initSessionSync(): () => void {
  if (!isTauri()) return () => {};
  // Any change at all, in either store; debounced because transcript updates
  // often. Seeded once on startup.
  const debouncer = createDebouncer(600);
  const schedule = () => debouncer.schedule(() => writeSession());
  const unMain = useStore.subscribe(schedule);
  const unLive = useLiveStore.subscribe(schedule);
  schedule();
  return () => {
    unMain();
    unLive();
    debouncer.cancel();
  };
}
