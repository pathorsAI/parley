// The trial build's remote control. A build made with VITE_PARLEY_DEV_SESSION=1
// polls a local test harness (live-suggestions-trial/control.py on
// 127.0.0.1:8799) for one command at a time — start a drafted meeting, end it,
// shrink or grow the meeting window — so a meeting can be run end to end
// without anyone at the keyboard. Release builds don't set the variable:
// DEV_SESSION is the constant false there and Vite drops all of this.

import { emitEvent } from "./ipc/events";
import { useStore } from "./store";
import { sortDrafts } from "./store/prep";
import { DEV_SESSION } from "./cloud/devSession";
import { log } from "./log";

const HARNESS = "http://127.0.0.1:8799/command";
const POLL_MS = 1_500;

/** The meeting window shrinks to its mini layout (true) or grows back. */
export const TRIAL_MINI_EVENT = "trial://mini";

interface Command {
  id: string;
  action: "start" | "end" | "mini" | "expand";
  /** start: the draft's title; the soonest draft when absent. */
  title?: string;
}

async function run(c: Command): Promise<void> {
  log.info("dev control: command", { action: c.action });
  if (c.action === "start") {
    const s = useStore.getState();
    const draft = s.drafts.find((d) => d.title === c.title) ?? sortDrafts(s.drafts, Date.now())[0];
    if (!draft || !s.takeDraft(draft.id)) return;
    const { beginMeeting } = await import("./meeting/start");
    await beginMeeting();
  } else if (c.action === "end") {
    const { endMeeting } = await import("./meeting/controls");
    await endMeeting();
  } else {
    await emitEvent(TRIAL_MINI_EVENT, { on: c.action === "mini" });
  }
}

/** Poll the harness while the app runs (main window). A no-op unless this is a
 *  trial build; a harness that isn't running is simply not there. */
export function startDevControl(): () => void {
  if (!DEV_SESSION) return () => {};
  let last = "";
  const tick = async () => {
    try {
      const res = await fetch(HARNESS, { cache: "no-store" });
      if (!res.ok) return;
      const c = (await res.json()) as Command | null;
      if (!c?.id || c.id === last) return;
      last = c.id;
      await run(c);
    } catch {
      /* no harness running */
    }
  };
  const timer = setInterval(() => void tick(), POLL_MS);
  return () => clearInterval(timer);
}
