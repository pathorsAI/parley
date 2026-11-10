// The 這是我 mark: which speaker in the loaded recording is the user.

import { useStore } from "../store";
import { log } from "../log";
import { persistSelfSpeaker } from "../history/history";
import { cancelDeliveryAnalysis } from "../analysis/deliveryRun";
import { refineVoiceprintFrom } from "./voiceprint";

/**
 * Mark `key` as the user (null clears the mark), save it on the entry, and
 * drop the AI tone read: it judged whoever was the user before, so the study
 * pipeline reads it again for the new speaker. The reset keeps the recording's
 * manual-analysis pin as it was — marking yourself never starts a paid pass
 * that auto-analysis would not.
 */
export function markSelfSpeaker(key: string | null): void {
  const s = useStore.getState();
  if (s.selfSpeaker === key) return;
  s.setSelfSpeaker(key);
  persistSelfSpeaker().catch((error) => log.warn("speakers: saving the self mark failed", { error: String(error) }));
  // A mark is the user saying "this voice is mine": teach the voiceprint.
  if (key) refineVoiceprintFrom(key);
  if (s.deliveryStatus === "running") cancelDeliveryAnalysis();
  if (s.deliveryStatus !== "idle" || s.deliveryAssessment) {
    s.setDeliveryAssessment(null);
    s.restartStudyStage("deliveryStatus", s.studyManualForId);
  }
}
