import { useEffect, useMemo, useState } from "react";
import { useStore } from "../../lib/store";
import { useScenarioSet } from "../../lib/scenarios/useStageSet";
import { stageFor } from "../../lib/scenarios/currentStage";
import { boardFromBundle } from "../../lib/intel/boards";
import { listHistory } from "../../lib/history/history";
import { buildOwnershipIndex, recordingsOfFolder } from "../../lib/library/scope";
import { listLocalFolders, type Folder } from "../../lib/history/folders";
import { useI18n, type TranslationKey } from "../../i18n";
import { log } from "../../lib/log";
import type { Scenario, SlotDef } from "../../lib/scenarios/bundles";
import type { HistoryEntrySummary } from "../../lib/history/types";

/**
 * The one resolution of "what is this meeting" that every pre-flight column
 * reads from. Columns ② and ③ both need the folder this call files into, the
 * board it will open with, and the earlier calls in that folder — and they have
 * to agree: a review that previews one stage's board while the draft reasons
 * about another is worse than either alone.
 */
export interface MeetingSetup {
  /** Folder this call will be filed in — the customer, in folder form. */
  folder: Folder | null;
  scenario: Scenario | null;
  /** Stage the board will run, resolved the same way the live board resolves it. */
  stageId: string | undefined;
  /** Every slot of the stage's board, in question order. */
  slots: SlotDef[];
  /** Display name of `stageId`, or null when the scenario has no board. */
  stageLabel: string | null;
  /** False for the "general" scenario, which has no board at all. */
  hasScenario: boolean;
  /** Every past meeting in this folder, newest first. Loaded async — empty on
   *  the first render, which is why the copilot's "第 N 次" is derived from it
   *  rather than stored. */
  meetings: HistoryEntrySummary[];
}

export function useMeetingSetup(): MeetingSetup {
  const { t } = useI18n();
  const scenarios = useScenarioSet();

  const meetingType = useStore((s) => s.meetingType);
  const folderId = useStore((s) => s.meetingFolderId);
  const meetingStage = useStore((s) => s.meetingStage);

  const folder = folderId ? (listLocalFolders().find((f) => f.id === folderId) ?? null) : null;
  const scenario = scenarios.byId[meetingType] ?? null;
  const stageId = scenario ? stageFor(scenario, meetingStage) : undefined;

  const [meetings, setMeetings] = useState<HistoryEntrySummary[]>([]);
  useEffect(() => {
    if (!folderId) {
      setMeetings([]);
      return;
    }
    let alive = true;
    listHistory()
      .then((all) => {
        if (!alive) return;
        // The tree's rule, so "第 N 次" counts the same meetings the folder's
        // own node shows.
        const idx = buildOwnershipIndex(listLocalFolders());
        setMeetings(
          recordingsOfFolder(all, folderId, idx).sort((a, b) => b.createdAt - a.createdAt)
        );
      })
      .catch((e) => log.warn("preflight: list meetings failed", { error: String(e) }));
    return () => {
      alive = false;
    };
  }, [folderId]);

  const slots = useMemo(() => {
    if (!scenario || !stageId) return [];
    const bundle = scenario.bundles[stageId];
    if (!bundle) return [];
    return boardFromBundle(scenario, bundle, (k: TranslationKey) => t(k)).slots;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario, stageId]);

  return {
    folder,
    scenario,
    stageId,
    slots,
    stageLabel: stageId ? (scenario?.names[stageId] ?? stageId) : null,
    hasScenario: !!scenario,
    meetings,
  };
}
