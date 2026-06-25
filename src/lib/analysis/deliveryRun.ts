import { useStore, isTrimmed } from "../store";
import { hasProviderKey } from "../ai/settings";
import { analyzeDelivery } from "../ai/delivery";

/**
 * Run the whole-recording delivery assessment (tone + over-frequent fillers + an
 * overall pace read) for the REPLAY/retro debrief, writing it into the store.
 *
 * Unlike the LIVE coach (gated behind the opt-in `delivery.tone` toggle, which
 * governs the extra *live* nudges), the post-call pass runs as part of the retro
 * whenever there's a provider key + transcript — same as the timeline analysis
 * and action items. Fires once per replay load (the caller guards re-entry).
 */
export async function runDeliveryAnalysis(): Promise<void> {
  const state = useStore.getState();
  const { settings, speakerNames } = state;
  // Match runAnalysis's replay scoping: exclude trimmed-away speech so the
  // delivery verdict sees exactly what the findings + action items see.
  const segments =
    state.appMode === "replay"
      ? state.segments.filter((s) => !isTrimmed(s, state.replayTrim))
      : state.segments;
  if (!hasProviderKey(settings)) return;
  if (!segments.some((s) => s.isFinal && s.text.trim())) return;
  if (state.deliveryStatus === "running") return;

  state.setDeliveryStatus("running");
  try {
    const res = await analyzeDelivery({ settings, segments, names: speakerNames, mode: "post" });
    useStore.getState().setDeliveryAssessment(res);
    useStore.getState().setDeliveryStatus("done");
  } catch (e) {
    console.error("[delivery]", e);
    useStore.getState().setDeliveryStatus("error");
  }
}
