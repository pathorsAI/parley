import { useStore } from "../store";
import { hasProviderKey } from "../ai/settings";
import { generateFindingSolution } from "../ai/findingSolution";

/**
 * Lazily generate the "how it should have been done" solution for one finding
 * and cache it in the store keyed by finding id. No-ops if the finding is gone,
 * already running/done, or there's no LLM key (the UI guards the no-key case).
 * Reads the FULL transcript (no playhead masking), so it behaves identically in
 * LIVE and REPLAY.
 */
export async function runFindingSolution(findingId: string): Promise<void> {
  const state = useStore.getState();
  const { settings, segments, speakerNames, meetingContext, findings, findingSolutions, setFindingSolution } =
    state;

  const entry = findingSolutions[findingId];
  if (entry && (entry.status === "running" || entry.status === "done")) return;
  const finding = findings.find((f) => f.id === findingId);
  if (!finding) return;
  if (!hasProviderKey(settings)) return;

  setFindingSolution(findingId, { status: "running", error: null });
  try {
    const solution = await generateFindingSolution({
      settings,
      finding,
      segments,
      meetingContext,
      names: speakerNames,
    });
    useStore.getState().setFindingSolution(findingId, { status: "done", solution, error: null });
  } catch (err) {
    console.error("[solution]", err);
    const { describeAiError } = await import("../ai/errors");
    useStore.getState().setFindingSolution(findingId, { status: "error", error: describeAiError(err) });
  }
}
