import { invoke } from "@tauri-apps/api/core";
import { useStore, transcriptAsText } from "./store";
import { isTauri } from "./tauriEvents";

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
  const s = useStore.getState();
  return {
    meetingStatus: s.meetingStatus,
    updatedAt: Date.now(),
    context: {
      appMode: s.appMode,
      studyTab: s.appMode === "replay" ? s.studyTab : null,
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
    meetingType: s.studyMeetingType,
    brief: s.brief,
    intel: s.intel,
    actionItems: s.actionItems,
    deliveryAssessment: s.deliveryAssessment,
  };
}

let timer: ReturnType<typeof setTimeout> | null = null;

async function writeSession(): Promise<void> {
  try {
    await invoke("write_session", { json: JSON.stringify(snapshot()) });
  } catch (e) {
    console.warn("[session] write failed", e);
  }
}

/** Start mirroring session state to disk. Returns a teardown function. */
export function initSessionSync(): () => void {
  if (!isTauri()) return () => {};
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(writeSession, 600); // debounce; transcript updates often
  };
  const unsub = useStore.subscribe(schedule);
  schedule(); // seed once on startup
  return () => {
    unsub();
    if (timer) clearTimeout(timer);
  };
}
