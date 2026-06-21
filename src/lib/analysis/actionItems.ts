import { useStore, isTrimmed } from "../store";
import { hasProviderKey } from "../ai/settings";
import { generateActionItems } from "../ai/actionItems";

let actionItemsBusy = false;

/**
 * Generate post-meeting action items from the analysis findings + transcript and
 * write them into the store (REPLAY only). Skips silently if there's no key, no
 * transcript, or a run is in flight.
 */
export async function runActionItems(): Promise<void> {
  const state = useStore.getState();
  const { settings, speakerNames, meetingContext, findings } = state;
  // Honor the trim keep-window (replay-only feature) — same as the analysis pass.
  const segments = state.segments.filter((s) => !isTrimmed(s, state.replayTrim));
  if (actionItemsBusy) return;
  if (!hasProviderKey(settings)) return;
  if (!segments.some((s) => s.isFinal && s.text.trim())) return;

  actionItemsBusy = true;
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
      onPartial: (partial) => useStore.getState().setActionItems(partial),
    });
    useStore.getState().setActionItems(items);
    useStore.getState().setActionItemsStatus("done");
  } catch (err) {
    console.error("[actionItems]", err);
    const { describeAiError } = await import("../ai/errors");
    useStore.getState().setActionItemsError(describeAiError(err));
    useStore.getState().setActionItemsStatus("error");
  } finally {
    actionItemsBusy = false;
  }
}

/** Manual "regenerate": reset to idle and re-run. */
export function regenerateActionItems(): void {
  useStore.getState().setActionItemsStatus("idle");
  void runActionItems();
}
