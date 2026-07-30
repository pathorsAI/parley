import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { useAccounts, activeClaims, personsOf, threadsOf } from "../accounts/store";
import { useScenarioSet } from "../accounts/useStageSet";
import { stageFor } from "../accounts/currentStage";
import { boardStates } from "../accounts/slotState";
import { boardFromBundle } from "../intel/boards";
import { listHistory } from "../history/history";
import type { SlotDef } from "../accounts/bundleFile";
import type { SlotState } from "../accounts/slotState";
import type { Claim, Company, Person, Thread } from "../accounts/types";
import type { HistoryEntrySummary } from "../history/types";
import { useI18n, type TranslationKey } from "../../i18n";
import { log } from "../log";

/**
 * The pre-flight read model: which company/thread/stage this call is against,
 * and the slice of the claim base + gap board it opens with.
 *
 * Both columns ② and ③ run off this. They used to derive it separately, which
 * meant the review column and the copilot could disagree about which stage's
 * board was in play — and the copilot's whole value is that it is talking about
 * the same battlefield the user is looking at.
 */
export interface PreflightIntel {
  company: Company | null;
  thread: Thread | null;
  attendees: Person[];
  /** Company-level claims plus the linked thread's — the live board's filter. */
  claims: Claim[];
  /** Every past meeting with this company, newest first. */
  meetings: HistoryEntrySummary[];
  rows: { slot: SlotDef; claims: Claim[]; state: SlotState }[];
  stageId: string | undefined;
  stageLabel: string | null;
  hasScenario: boolean;
}

export function usePreflightIntel(): PreflightIntel {
  const { t } = useI18n();
  const acc = useAccounts();
  const scenarios = useScenarioSet();

  const meetingType = useStore((s) => s.settings.meetingType);
  const companyId = useStore((s) => s.meetingCompanyId);
  const threadId = useStore((s) => s.meetingThreadId);
  const attendeeIds = useStore((s) => s.meetingAttendeeIds);
  const meetingStage = useStore((s) => s.meetingStage);

  const [meetings, setMeetings] = useState<HistoryEntrySummary[]>([]);

  const company = acc.companies.find((c) => c.id === companyId) ?? null;
  const scenario = scenarios.byId[meetingType] ?? null;

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

  const claims = useMemo(
    () =>
      companyId
        ? activeClaims(acc, companyId).filter(
            (c) => !threadId || !c.threadId || c.threadId === threadId
          )
        : [],
    [acc, companyId, threadId]
  );

  const thread = companyId ? (threadsOf(acc, companyId).find((x) => x.id === threadId) ?? null) : null;
  const attendees = companyId
    ? personsOf(acc, companyId).filter((p) => attendeeIds.includes(p.id))
    : [];
  const stageId = scenario ? stageFor(scenario, meetingStage, thread ?? undefined) : undefined;

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
    attendees,
    claims,
    meetings,
    rows,
    stageId,
    stageLabel: stageId ? (scenario?.names[stageId] ?? stageId) : null,
    hasScenario: !!scenario,
  };
}
