// The AI tone read for a speaker other than the user, on the 評分 page's
// speaker switch. The user's own read is the study pipeline's delivery stage
// (deliveryRun.ts); anyone else is read the first time their chip is shown,
// one speaker at a time, and kept for as long as the app is open.

import { create } from "zustand";
import { useStore, isTrimmed } from "../store";
import { analyzeDelivery } from "../ai/delivery";
import { hasProviderKey } from "../ai/settings";
import { studyErrorMessage } from "./errorMessage";
import { log } from "../log";
import type { DeliveryAssessment } from "../types";

export type SpeakerToneState =
  | { status: "running" }
  | { status: "done"; assessment: DeliveryAssessment | null }
  | { status: "error"; error: string };

export const useSpeakerTone = create<{ reads: Record<string, SpeakerToneState> }>(() => ({ reads: {} }));

/** The cache key: one recording's one speaker. */
export function speakerToneKey(recordingId: string | null, speaker: string): string {
  return `${recordingId ?? "unsaved"}|${speaker}`;
}

function put(key: string, value: SpeakerToneState) {
  useSpeakerTone.setState((s) => ({ reads: { ...s.reads, [key]: value } }));
}

/** Whether a tone read can run at all (a deep-model key is set). */
export function canReadSpeakerTone(): boolean {
  return hasProviderKey(useStore.getState().settings, "deep");
}

/** Read `label`'s tone over the loaded recording's kept lines. */
export async function readSpeakerTone(speaker: string, label: string): Promise<void> {
  const state = useStore.getState();
  const key = speakerToneKey(state.loadedHistoryId, speaker);
  if (useSpeakerTone.getState().reads[key]?.status === "running") return;
  const segments = state.segments.filter((s) => !isTrimmed(s, state.replayTrim));
  put(key, { status: "running" });
  try {
    const assessment = await analyzeDelivery({
      settings: state.settings,
      segments,
      names: state.speakerNames,
      subjectLabel: label,
      mode: "post",
    });
    put(key, { status: "done", assessment });
  } catch (e) {
    log.error("delivery: speaker tone read failed", { error: String(e) });
    put(key, { status: "error", error: await studyErrorMessage(e, state.settings.llmProviders.realtime) });
  }
}
