import { useStore } from "../store";
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
  const { settings, segments, speakerNames, meetingContext, findings } = state;
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
