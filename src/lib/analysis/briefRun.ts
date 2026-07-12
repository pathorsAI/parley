import { useStore, isTrimmed, hasSpokenSegment, meetingBriefText } from "../store";
import { hasProviderKey } from "../ai/settings";
import { generatePostMeetingReport } from "../ai/report";
import { makeRunGuard } from "./runGuard";
import { log } from "../log";

/**
 * Generate the study brief (重點 debrief) into the store and persist it onto the
 * loaded entry. The ONE entry point for both the study pipeline (which dispatches
 * it after the analysis + action items settle, so the checklist it folds in is
 * real) and the titlebar chip's manual regenerate (`force` re-runs over a
 * done/error state; the pipeline never forces). A run that outlives its session
 * or is superseded by a newer pass stops writing (see runGuard).
 */
const guard = makeRunGuard();
export async function runBriefGeneration(opts?: { force?: boolean }): Promise<void> {
  const state = useStore.getState();
  if (state.briefStatus === "running") return;
  if (!opts?.force && state.briefStatus !== "idle") return;
  if (!hasProviderKey(state.settings, "deep")) return;
  // Honor the trim keep-window, same as the analysis + action-items passes.
  const segments = state.segments.filter((s) => !isTrimmed(s, state.replayTrim));
  if (!hasSpokenSegment(segments)) return;

  const alive = guard.begin();
  state.setBrief("");
  state.setBriefStatus("running");
  try {
    await generatePostMeetingReport({
      settings: state.settings,
      segments,
      evaluations: state.evaluations,
      // The generated follow-ups double as the debrief's agenda/checklist.
      todos: state.actionItems.map((a) => ({ id: a.id, text: a.text, done: a.done })),
      names: state.speakerNames,
      meetingContext: meetingBriefText(state),
      onDelta: (chunk) => {
        if (alive()) useStore.getState().appendBrief(chunk);
      },
    });
    if (!alive()) return;
    useStore.getState().setBriefStatus("done");
    // Save onto the loaded entry so this recording never regenerates its brief.
    void import("../history/history").then((m) =>
      m.persistStudyOutputs().catch((e) =>
        log.warn("brief: persist failed", { error: String(e) })
      )
    );
  } catch (e) {
    log.error("brief: generation failed", { error: String(e) });
    if (alive()) useStore.getState().setBriefStatus("error");
  }
}
