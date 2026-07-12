import { useStore, isTrimmed, hasSpokenSegment, meetingBriefText } from "../store";
import { hasProviderKey } from "../ai/settings";
import { generateActionItems } from "../ai/actionItems";
import { makeRunGuard } from "./runGuard";

/**
 * Generate post-meeting action items from the analysis findings + transcript and
 * write them into the store (REPLAY only). Skips silently if there's no key, no
 * transcript, or a run is in flight (the status is the lock — set synchronously
 * below, so two back-to-back calls can't interleave). A run that outlives its
 * session or is superseded by a newer pass stops writing (see runGuard).
 */
const guard = makeRunGuard();
export async function runActionItems(): Promise<void> {
  const state = useStore.getState();
  const { settings, speakerNames, findings } = state;
  const meetingContext = meetingBriefText(state);
  // Honor the trim keep-window (replay-only feature) — same as the analysis pass.
  const segments = state.segments.filter((s) => !isTrimmed(s, state.replayTrim));
  if (state.actionItemsStatus === "running") return;
  if (!hasProviderKey(settings, "deep")) return;
  if (!hasSpokenSegment(segments)) return;

  const alive = guard.begin();
  state.setActionItemsError(null);
  state.setActionItemsStatus("running");
  try {
    const items = await generateActionItems({
      settings,
      segments,
      findings,
      meetingContext,
      names: speakerNames,
      // Stream items into the store so they appear one-by-one while generating.
      onPartial: (partial) => {
        if (alive()) useStore.getState().setActionItems(partial);
      },
    });
    if (!alive()) return;
    useStore.getState().setActionItems(items);
    useStore.getState().setActionItemsStatus("done");
  } catch (err) {
    console.error("[actionItems]", err);
    if (!alive()) return;
    const { describeAiError } = await import("../ai/errors");
    useStore.getState().setActionItemsError(describeAiError(err));
    useStore.getState().setActionItemsStatus("error");
  }
}
