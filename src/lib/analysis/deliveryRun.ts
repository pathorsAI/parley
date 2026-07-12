import { useStore, isTrimmed, hasSpokenSegment } from "../store";
import { hasProviderKey } from "../ai/settings";
import { analyzeDelivery } from "../ai/delivery";
import { makeRunGuard } from "./runGuard";

/**
 * Run the whole-recording delivery assessment (tone + over-frequent fillers + an
 * overall pace read) for the REPLAY/retro debrief, writing it into the store.
 *
 * Unlike the LIVE coach (gated behind the opt-in `delivery.tone` toggle, which
 * governs the extra *live* nudges), the post-call pass runs as part of the retro
 * whenever there's a provider key + transcript — same as the timeline analysis
 * and action items. Dispatched by the study pipeline; a run that outlives its
 * session or is superseded stops writing (see runGuard).
 */
const guard = makeRunGuard();
export async function runDeliveryAnalysis(): Promise<void> {
  const state = useStore.getState();
  const { settings, speakerNames } = state;
  // Match runAnalysis's replay scoping: exclude trimmed-away speech so the
  // delivery verdict sees exactly what the findings + action items see.
  const segments =
    state.appMode === "replay"
      ? state.segments.filter((s) => !isTrimmed(s, state.replayTrim))
      : state.segments;
  if (!hasProviderKey(settings, "deep")) return;
  if (!hasSpokenSegment(segments)) return;
  if (state.deliveryStatus === "running") return;

  const alive = guard.begin();
  state.setDeliveryStatus("running");
  try {
    const res = await analyzeDelivery({
      settings,
      segments,
      names: speakerNames,
      measuredRateHz: state.replay?.speechRateHz ?? null,
      mode: "post",
    });
    if (!alive()) return;
    useStore.getState().setDeliveryAssessment(res);
    useStore.getState().setDeliveryStatus("done");
    // A legacy entry (saved before deliveryAssessment existed) recomputes this on
    // open — save it back so it only ever recomputes once. No-op when unsaved.
    void import("../history/history").then((m) =>
      m.persistStudyOutputs().catch((e) => console.error("[delivery] persist failed", e))
    );
  } catch (e) {
    console.error("[delivery]", e);
    if (alive()) useStore.getState().setDeliveryStatus("error");
  }
}
