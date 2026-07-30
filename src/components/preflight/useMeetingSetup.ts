import { useMemo } from "react";
import { useStore } from "../../lib/store";
import { useAccounts, activeClaims, personsOf, threadsOf } from "../../lib/accounts/store";
import { useScenarioSet } from "../../lib/accounts/useStageSet";
import { stageFor } from "../../lib/accounts/currentStage";
import { boardStates } from "../../lib/accounts/slotState";
import { boardFromBundle } from "../../lib/intel/boards";
import { useI18n, type TranslationKey } from "../../i18n";
import type { Scenario } from "../../lib/accounts/bundles";
import type { SlotState } from "../../lib/accounts/slotState";
import type { SlotDef } from "../../lib/accounts/bundles";
import type { Claim, Company, Person, Thread } from "../../lib/accounts/types";

/**
 * The one resolution of "what is this meeting" that every pre-flight column
 * reads from. Columns ② and ③ both need the linked company, this deal's slice
 * of the claim base, and the gap board the call will actually open with — and
 * they have to agree: a review that previews one stage's board while the draft
 * reasons about another is worse than either alone.
 */
export interface MeetingSetup {
  company: Company | null;
  thread: Thread | null;
  scenario: Scenario | null;
  /** Stage the board will run, resolved the same way the live board resolves it. */
  stageId: string | undefined;
  /** Attendees picked in column ①. */
  attendees: Person[];
  /** Company-level claims plus the linked thread's — the live board's filter. */
  claims: Claim[];
  /** Every slot of the stage's board with its current 空／薄／實 state. */
  rows: { slot: SlotDef; claims: Claim[]; state: SlotState }[];
}

export function useMeetingSetup(): MeetingSetup {
  const { t } = useI18n();
  const acc = useAccounts();
  const scenarios = useScenarioSet();

  const meetingType = useStore((s) => s.settings.meetingType);
  const companyId = useStore((s) => s.meetingCompanyId);
  const threadId = useStore((s) => s.meetingThreadId);
  const attendeeIds = useStore((s) => s.meetingAttendeeIds);
  const meetingStage = useStore((s) => s.meetingStage);

  const company = acc.companies.find((c) => c.id === companyId) ?? null;
  const scenario = scenarios.byId[meetingType] ?? null;
  const thread = companyId
    ? (threadsOf(acc, companyId).find((x) => x.id === threadId) ?? null)
    : null;
  const attendees = companyId
    ? personsOf(acc, companyId).filter((p) => attendeeIds.includes(p.id))
    : [];

  const claims = useMemo(
    () =>
      companyId
        ? activeClaims(acc, companyId).filter(
            (c) => !threadId || !c.threadId || c.threadId === threadId
          )
        : [],
    [acc, companyId, threadId]
  );

  const stageId = scenario ? stageFor(scenario, meetingStage, thread) : undefined;

  const rows = useMemo(() => {
    if (!scenario || !stageId) return [];
    const bundle = scenario.bundles[stageId];
    if (!bundle) return [];
    const board = boardFromBundle(scenario, bundle, (k: TranslationKey) => t(k));
    return boardStates(claims, { ...bundle, slots: board.slots }, Date.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario, stageId, claims]);

  return { company, thread, scenario, stageId, attendees, claims, rows };
}
