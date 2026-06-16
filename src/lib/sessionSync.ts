import { invoke } from "@tauri-apps/api/core";
import { useStore, transcriptAsText } from "./store";
import { isTauri } from "./tauriEvents";

/**
 * Mirror the live meeting state to `<appConfigDir>/session.json`, which the
 * built-in MCP server reads so clients (Claude, etc.) can see the current
 * transcript, todos, and evaluation results in real time. One-way for now:
 * the app writes, MCP reads.
 */
function snapshot() {
  const s = useStore.getState();
  return {
    meetingStatus: s.meetingStatus,
    updatedAt: Date.now(),
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
