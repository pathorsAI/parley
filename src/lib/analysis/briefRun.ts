import { useStore, isTrimmed, meetingBriefText } from "../store";
import { hasProviderKey } from "../ai/settings";
import { generatePostMeetingReport } from "../ai/report";
import { log } from "../log";

/**
 * Generate the study brief (重點 debrief) into the store and persist it onto the
 * loaded entry. The ONE entry point for both the auto pipeline (which calls it
 * after the analysis + action items settle, so the checklist it folds in is
 * real) and the report page's Regenerate button (`force` re-runs over a
 * done/error state; the pipeline never forces).
 */
export async function runBriefGeneration(opts?: { force?: boolean }): Promise<void> {
  const state = useStore.getState();
  if (state.briefStatus === "running") return;
  if (!opts?.force && state.briefStatus !== "idle") return;
  if (!hasProviderKey(state.settings, "deep")) return;
  // Honor the trim keep-window, same as the analysis + action-items passes.
  const segments = state.segments.filter((s) => !isTrimmed(s, state.replayTrim));
  if (!segments.some((s) => s.isFinal && s.text.trim())) return;

  // Pin the session this run belongs to: if the user exits replay / loads a
  // different recording / starts a meeting mid-stream, stop touching the store
  // so this brief can't leak into the wrong session (or get persisted onto it).
  const startedFor = state.replay?.id ?? null;
  const sessionAlive = () => (useStore.getState().replay?.id ?? null) === startedFor;

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
        if (sessionAlive()) useStore.getState().appendBrief(chunk);
      },
    });
    if (!sessionAlive()) return;
    useStore.getState().setBriefStatus("done");
    // Save onto the loaded entry so this recording never regenerates its brief.
    void import("../history/history").then((m) =>
      m.persistStudyOutputs().catch((e) =>
        log.warn("brief: persist failed", { error: String(e) })
      )
    );
  } catch (e) {
    log.error("brief: generation failed", { error: String(e) });
    if (sessionAlive()) useStore.getState().setBriefStatus("error");
  }
}
