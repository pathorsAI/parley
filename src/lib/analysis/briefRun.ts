import { useStore, isTrimmed, hasSpokenSegment, meetingBriefText } from "../store";
import { hasProviderKey } from "../ai/settings";
import { generatePostMeetingReport } from "../ai/report";
import { lensOf } from "./lens";
import { landStage, makeRunGuard } from "./runGuard";
import { log } from "../log";

/**
 * Generate the study brief (重點 debrief) into the store and persist it onto the
 * recording's entry. The ONE entry point for both the study pipeline (which
 * dispatches it after the analysis + action items settle, so the checklist it
 * folds in is real) and the titlebar chip's manual regenerate (`force` re-runs
 * over a done/error state; the pipeline never forces).
 *
 * An EMPTY brief is a failure, not a result (generatePostMeetingReport throws):
 * saving "" used to read as "never generated" on the next open, so a recording
 * whose brief kept coming back empty re-ran it on every open. A failure is
 * persisted as `briefFailed` instead, which restores as "error" — visible, and
 * retried by hand rather than silently on every open.
 *
 * A run that outlives its recording being on screen still lands its brief (or
 * its failure) on that recording's entry; a superseded run is discarded (see
 * runGuard).
 */
const guard = makeRunGuard("brief");
export async function runBriefGeneration(opts?: { force?: boolean }): Promise<void> {
  const state = useStore.getState();
  if (state.briefStatus === "running") return;
  if (!opts?.force && state.briefStatus !== "idle") return;
  if (!hasProviderKey(state.settings, "deep")) return;
  // Honor the trim keep-window, same as the analysis + action-items passes.
  const segments = state.segments.filter((s) => !isTrimmed(s, state.replayTrim));
  if (!hasSpokenSegment(segments)) return;

  const run = guard.begin();
  state.setBrief("");
  state.setBriefStatus("running");
  // The run keeps the whole text itself: if the user leaves and comes back
  // mid-stream, the store was reset in between, so appending would lose the
  // part that streamed while the recording was off screen.
  let text = "";
  try {
    const brief = await generatePostMeetingReport({
      settings: state.settings,
      segments,
      evaluations: state.evaluations,
      // The generated follow-ups double as the debrief's agenda/checklist.
      todos: state.actionItems.map((a) => ({ id: a.id, text: a.text, done: a.done })),
      names: state.speakerNames,
      meetingContext: meetingBriefText(state),
      lens: lensOf(state.meetingKind),
      onDelta: (chunk) => {
        text += chunk;
        if (run.alive()) useStore.getState().setBrief(text);
      },
    });
    // Save it so this recording never regenerates its brief.
    await landStage(run, {
      stage: "brief",
      apply: () => {
        useStore.getState().setBrief(brief);
        useStore.getState().setBriefStatus("done");
      },
      patch: { brief, briefFailed: false },
      persistWhileLoaded: true,
    });
  } catch (e) {
    log.error("brief: generation failed", { error: String(e) });
    await landStage(run, {
      stage: "brief",
      apply: () => {
        // Don't leave a truncated stream on screen under the error.
        useStore.getState().setBrief(null);
        useStore.getState().setBriefStatus("error");
      },
      patch: { briefFailed: true },
      persistWhileLoaded: true,
    });
  } finally {
    run.end();
  }
}
