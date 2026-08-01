import { useEffect, useMemo, useState } from "react";
import { useStore } from "../../lib/store";
import { useAccounts, activeClaims, personsOf, threadsOf } from "../../lib/accounts/store";
import { useScenarioSet } from "../../lib/accounts/useStageSet";
import { stageFor } from "../../lib/accounts/currentStage";
import { boardStates } from "../../lib/accounts/slotState";
import { boardFromBundle } from "../../lib/intel/boards";
import { listHistory } from "../../lib/history/history";
import { useI18n, type TranslationKey } from "../../i18n";
import { log } from "../../lib/log";
import type { Scenario, SlotDef } from "../../lib/accounts/bundles";
import type { SlotState } from "../../lib/accounts/slotState";
import type { Claim, Company, Person, Thread } from "../../lib/accounts/types";
import type { HistoryEntrySummary } from "../../lib/history/types";

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
  /** Display name of `stageId`, or null when the scenario has no board. */
  stageLabel: string | null;
  /** False for the "general" scenario, which links no customer at all. */
  hasScenario: boolean;
  /** Every past meeting with this company, newest first. Loaded async — empty
   *  on the first render, which is why the copilot's "第 N 次" is derived from
   *  it rather than stored. */
  meetings: HistoryEntrySummary[];
}

export function useMeetingSetup(): MeetingSetup {
  const { t } = useI18n();
  const acc = useAccounts();
  const scenarios = useScenarioSet();

  const meetingType = useStore((s) => s.meetingType);
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

  const [meetings, setMeetings] = useState<HistoryEntrySummary[]>([]);
  useEffect(() => {
    if (!companyId) {
      setMeetings([]);
      return;
    }
    let alive = true;
    listHistory()
      .then((all) => {
        if (!alive) return;
        setMeetings(
          all.filter((m) => m.companyId === companyId).sort((a, b) => b.createdAt - a.createdAt)
        );
      })
      .catch((e) => log.warn("preflight: list meetings failed", { error: String(e) }));
    return () => {
      alive = false;
    };
  }, [companyId]);

  const rows = useMemo(() => {
    if (!scenario || !stageId) return [];
    const bundle = scenario.bundles[stageId];
    if (!bundle) return [];
    const board = boardFromBundle(scenario, bundle, (k: TranslationKey) => t(k));
    return boardStates(claims, { ...bundle, slots: board.slots }, Date.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario, stageId, claims]);

  return {
    company,
    thread,
    scenario,
    stageId,
    attendees,
    claims,
    rows,
    stageLabel: stageId ? (scenario?.names[stageId] ?? stageId) : null,
    hasScenario: !!scenario,
    meetings,
  };
}
