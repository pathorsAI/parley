import { useStore, isTrimmed, hasSpokenSegment, meetingBriefText } from "../store";
import { hasProviderKey } from "../ai/settings";
import { generateActionItems } from "../ai/actionItems";
import { lensOf } from "./lens";
import { landStage, makeRunGuard } from "./runGuard";

/**
 * Generate post-meeting action items from the analysis findings + transcript and
 * write them into the store (REPLAY only). Skips silently if there's no key, no
 * transcript, or a run is in flight (the status is the lock — set synchronously
 * below, so two back-to-back calls can't interleave).
 *
 * While the recording is on screen, initHistoryPersistSync saves the completed
 * pipeline. A run that outlives that (the user left) writes its result onto the
 * recording's entry itself — together with the findings it ran on and
 * `analyzed: true`, because that pair IS the completed pipeline — so reopening
 * never re-runs it. A run superseded by a newer pass is discarded (runGuard).
 */
const guard = makeRunGuard("actions");
export async function runActionItems(): Promise<void> {
  const state = useStore.getState();
  const { settings, speakerNames, findings, meetingKind } = state;
  const meetingContext = meetingBriefText(state);
  // Honor the trim keep-window (replay-only feature) — same as the analysis pass.
  const segments = state.segments.filter((s) => !isTrimmed(s, state.replayTrim));
  if (state.actionItemsStatus === "running") return;
  if (!hasProviderKey(settings, "deep")) return;
  if (!hasSpokenSegment(segments)) return;

  const run = guard.begin();
  state.setActionItemsError(null);
  state.setActionItemsStatus("running");
  try {
    const items = await generateActionItems({
      settings,
      segments,
      findings,
      meetingContext,
      names: speakerNames,
      lens: lensOf(meetingKind),
      // Stream items into the store so they appear one-by-one while generating.
      onPartial: (partial) => {
        if (run.alive()) useStore.getState().setActionItems(partial);
      },
    });
    await landStage(run, {
      stage: "actions",
      apply: () => {
        useStore.getState().setActionItems(items);
        useStore.getState().setActionItemsStatus("done");
      },
      patch: { findings, actionItems: items, analyzed: true, meetingKind },
    });
  } catch (err) {
    console.error("[actionItems]", err);
    const { describeAiError } = await import("../ai/errors");
    const message = describeAiError(err);
    await landStage(run, {
      stage: "actions",
      apply: () => {
        useStore.getState().setActionItemsError(message);
        useStore.getState().setActionItemsStatus("error");
      },
      patch: null,
    });
  } finally {
    run.end();
  }
}
