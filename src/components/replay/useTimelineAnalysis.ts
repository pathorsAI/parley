import { useEffect, useRef } from "react";
import { useStore } from "../../lib/store";
import { hasProviderKey } from "../../lib/ai/settings";
import { analyzeTimeline } from "../../lib/ai/timeline";
import { useReplaySession, useReplayTimelineStatus } from "./spine";

/** Guards against a double-run if the effect re-fires before status flips. */
let timelineBusy = false;

/**
 * Run the whole-recording retro analysis and write the result into the store.
 * Idempotent at the module level (`timelineBusy`) and re-usable for the manual
 * "re-analyze" button — that path resets status to "idle" first.
 */
export async function runTimelineAnalysis(): Promise<void> {
  const state = useStore.getState();
  const { settings, segments, speakerNames, meetingContext } = state;
  const setStatus = state.setReplayTimelineStatus;

  if (timelineBusy) return;
  if (!hasProviderKey(settings)) return;
  if (!segments.some((s) => s.isFinal && s.text.trim())) return;

  timelineBusy = true;
  setStatus("running");
  try {
    const events = await analyzeTimeline({
      settings,
      // Whole-recording overview — intentionally NOT masked to the playhead.
      segments,
      evals: settings.evaluations,
      meetingContext,
      names: speakerNames,
    });
    useStore.getState().setReplayTimeline(events);
    useStore.getState().setReplayTimelineStatus("done");
  } catch (err) {
    console.error("[timeline]", err);
    useStore.getState().setReplayTimelineStatus("error");
  } finally {
    timelineBusy = false;
  }
}

/** Manual "re-analyze": reset to idle and re-run. */
export function reanalyzeTimeline(): void {
  useStore.getState().setReplayTimelineStatus("idle");
  void runTimelineAnalysis();
}

/**
 * Auto-run the timeline analysis as soon as a replay session is loaded with
 * final segments and an LLM key configured. Fires once per session (status
 * leaves "idle" immediately), and the module-level busy flag prevents overlap.
 */
export function useTimelineAnalysis(): void {
  const session = useReplaySession();
  const status = useReplayTimelineStatus();
  const startedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!session) {
      startedFor.current = null;
      return;
    }
    if (status !== "idle") return;
    if (startedFor.current === session.id) return;

    const { settings, segments } = useStore.getState();
    if (!hasProviderKey(settings)) return;
    if (!segments.some((s) => s.isFinal && s.text.trim())) return;

    startedFor.current = session.id;
    void runTimelineAnalysis();
  }, [session, status]);
}
