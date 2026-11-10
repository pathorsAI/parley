import type { HistoryEntry } from "../history/types";
import type { DeliveryAssessment } from "../types";
import enManifestJson from "./sampleManifests/sample.en.json";
import zhManifestJson from "./sampleManifests/sample.zh-TW.json";

/** The sample's prewritten outputs that the study page reads straight off the
 *  entry. Kept apart from sample.ts so the history opener can use it without
 *  importing the sample loader (which imports history). */
interface SampleOutputs {
  id: string;
  brief: string;
  delivery: DeliveryAssessment;
}

const OUTPUTS: SampleOutputs[] = [zhManifestJson, enManifestJson].map((m) => ({
  id: m.id,
  brief: m.brief,
  delivery: m.delivery as DeliveryAssessment,
}));

/**
 * Bring a saved sample entry up to the current prewritten outputs. A sample
 * imported before the brief used `## ` section headings, or before it carried
 * a 評分 read, otherwise keeps showing the old shape forever: the sample is
 * never auto-analysed, and importing it again is a no-op once it is in the
 * library. Only stale outputs are replaced — a brief that already has sections
 * (the current one, or one the user regenerated) and an existing tone read are
 * left alone. Returns the entry unchanged when it is not a sample. Pure.
 */
export function refreshSampleOutputs(entry: HistoryEntry): HistoryEntry {
  const outputs = OUTPUTS.find((o) => o.id === entry.id);
  if (!outputs) return entry;
  const staleBrief = !entry.brief || !/^##\s/m.test(entry.brief);
  const missingDelivery = !entry.deliveryAssessment;
  if (!staleBrief && !missingDelivery) return entry;
  return {
    ...entry,
    brief: staleBrief ? outputs.brief : entry.brief,
    deliveryAssessment: missingDelivery ? outputs.delivery : entry.deliveryAssessment,
  };
}
