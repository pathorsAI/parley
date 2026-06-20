import { useStore, speakerKey } from "../store";
import type { SpeakerRole } from "../types";

/**
 * Re-attribute speakers across the WHOLE transcript with the LLM, then apply to
 * the store: each reassigned line's `speaker` becomes its 1-based role number,
 * and `speakerNames` maps the resulting keys to the role names (so the existing
 * transcript + rename UI just work). Lines the model didn't assign keep their
 * current speaker. Returns how many lines were reassigned. Throws on failure.
 */
export async function runSpeakerReassign(roles: SpeakerRole[]): Promise<{ assigned: number; total: number }> {
  const { settings, segments, speakerNames } = useStore.getState();
  const finalSegs = segments
    .filter((s) => s.isFinal && s.text.trim())
    .sort((a, b) => a.startMs - b.startMs);
  if (finalSegs.length === 0) throw new Error("No transcript to re-attribute.");

  const { reassignSpeakers } = await import("../ai/speakers");
  const indexToRole = await reassignSpeakers({ settings, segments: finalSegs, roles, names: speakerNames });

  // Map the (finalSegs-index → role) result onto stable segment ids.
  const idToRole = new Map<string, number>();
  finalSegs.forEach((s, i) => {
    const r = indexToRole.get(i);
    if (r) idToRole.set(s.id, r);
  });

  // Rewrite speaker on reassigned lines (over the FULL segment list), then name
  // the resulting speaker keys after the roles.
  const updated = useStore.getState().segments.map((s) => {
    const r = idToRole.get(s.id);
    return r ? { ...s, speaker: r } : s;
  });
  const newNames: Record<string, string> = {};
  for (const s of updated) {
    const r = idToRole.get(s.id);
    if (r) newNames[speakerKey(s)] = roles[r - 1]?.name ?? `Speaker ${r}`;
  }

  useStore.setState({
    segments: updated,
    speakerNames: { ...useStore.getState().speakerNames, ...newNames },
  });

  return { assigned: idToRole.size, total: finalSegs.length };
}
