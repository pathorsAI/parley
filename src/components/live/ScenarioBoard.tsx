import { useEffect, useMemo, useState } from "react";
import { transcriptAsText, useStore, meetingElapsedMs } from "../../lib/store";
import { activeClaims, useAccounts } from "../../lib/accounts/store";
import { suggestSlotQuestions, type SlotQuestion } from "../../lib/accounts/suggest";
import { boardStates } from "../../lib/accounts/slotState";
import { backfillSlotIds } from "../../lib/accounts/backfill";
import { hasProviderKey } from "../../lib/ai/settings";
import type { Scenario } from "../../lib/accounts/bundles";
import { boardFromBundle, applyNextStepGate } from "../../lib/intel/boards";
import { useI18n, type TranslationKey } from "../../i18n";
import { log } from "../../lib/log";
import { FocusBanner, SlotRow } from "./SlotBoard";

/**
 * THE live board — one component for every scenario (scenario system). A
 * second-attention surface: one line per slot, glanceable in 1–2 seconds.
 * Quiet by design (呼吸版): an empty slot is a label and a hollow dot — the
 * hint lives in the tap-expansion, not on the resting board. Tapping a row
 * expands its fills (speaker-attributed) and, with a realtime key, generates
 * "how to ask" lines for THAT slot. The stage picker lives in the rail header
 * (IntelligenceBoard); this board renders the resolved stage.
 */
function stageFor(
  scenario: Scenario,
  meetingStage: string | null | undefined,
  threadStage: string | undefined
): string {
  if (meetingStage && scenario.order.includes(meetingStage)) return meetingStage;
  if (scenario.id === "sales" && threadStage && scenario.order.includes(threadStage)) {
    return threadStage;
  }
  return scenario.order[0];
}

export function ScenarioBoard({ scenario }: Readonly<{ scenario: Scenario }>) {
  const { t } = useI18n();
  const acc = useAccounts();
  const settings = useStore((s) => s.settings);
  const companyId = useStore((s) => s.meetingCompanyId);
  const threadId = useStore((s) => s.meetingThreadId);
  const meetingStage = useStore((s) => s.meetingStage);
  const intel = useStore((s) => s.intel);
  const recording = useStore((s) => s.meetingStatus === "recording");

  // Reactive mirror of resolveScenarioStageId (keep the two in step).
  const thread = acc.threads.find((x) => x.id === threadId) ?? null;
  const threadStage = thread?.kind === "sales" ? thread.stage : undefined;
  const stage = stageFor(scenario, meetingStage, threadStage);
  const bundle = scenario.bundles[stage];

  const board = useMemo(
    () => boardFromBundle(scenario, bundle, (k: TranslationKey) => t(k)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scenario, bundle]
  );

  // This meeting's view of the claim base (any scenario — slots with claim
  // queries attach cards whenever a company is linked).
  const claims = useMemo(
    () =>
      companyId
        ? activeClaims(acc, companyId).filter(
            (c) => !threadId || !c.threadId || c.threadId === threadId
          )
        : [],
    [acc, companyId, threadId]
  );
  const rows = useMemo(
    () => boardStates(claims, { ...bundle, slots: board.slots }, Date.now()),
    [claims, bundle, board]
  );

  // Live fills + auto-focus for THIS call (§4.3/S22): UI transient, from the
  // 30s realtime pass — the claim base is written at post-meeting review (D8).
  const live = intel?.meetingType === scenario.id ? intel : null;
  const fillsBySlot = useMemo(() => {
    const out = new Map<string, { text: string; speaker: "me" | "them" }[]>();
    for (const f of live?.slotFills ?? [])
      out.set(f.slotId, [...(out.get(f.slotId) ?? []), { text: f.text, speaker: f.speaker }]);
    return out;
  }, [live]);

  // Next-step gate: tick the recorded-time clock while live so the gate can
  // fire without waiting for the next extraction.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [recording]);
  const elapsedMs = meetingElapsedMs(useStore.getState(), nowMs);
  const focus = applyNextStepGate({
    focus: live?.focusSlot,
    fills: live?.slotFills ?? [],
    board,
    elapsedMs,
    question: t("board.gate.question"),
    reason: t("board.gate.reason"),
  });

  // Tap a row → expand in place: fills + hint + generated questions (S22 修訂).
  // One expansion at a time; tapping again collapses. Cleared on stage flip.
  const [manual, setManual] = useState<{
    slotId: string;
    status: "idle" | "running" | "done" | "error";
    questions: SlotQuestion[];
  } | null>(null);
  useEffect(() => setManual(null), [stage, scenario.id]);
  const canAsk = hasProviderKey(settings, "realtime");

  function tapSlot(slotId: string) {
    if (manual?.slotId === slotId) {
      setManual(null); // toggle off
      return;
    }
    const slot = board.slots.find((s) => s.id === slotId);
    if (!slot) return;
    if (!canAsk) {
      setManual({ slotId, status: "idle", questions: [] });
      return;
    }
    setManual({ slotId, status: "running", questions: [] });
    const state = useStore.getState();
    const attached = rows.find((b) => b.slot.id === slotId)?.claims ?? [];
    suggestSlotQuestions({
      settings: state.settings,
      stage,
      slot,
      knownTexts: [
        ...attached.map((c) => c.text),
        ...(fillsBySlot.get(slotId) ?? []).map((f) => f.text),
      ],
      transcriptTail: transcriptAsText(state.segments, state.speakerNames).slice(-2_000),
    })
      .then((questions) =>
        setManual((m) => (m?.slotId === slotId ? { slotId, status: "done", questions } : m))
      )
      .catch((e) => {
        log.warn("board: manual suggest failed", { error: String(e) });
        setManual((m) => (m?.slotId === slotId ? { slotId, status: "error", questions: [] } : m));
      });
  }

  // Board-open backfill (#146, sales war-room only): classify query-hit-but-
  // untagged cards once per stage. Fallback for recordings with no live fills.
  useEffect(() => {
    if (scenario.id !== "sales" || !companyId || !hasProviderKey(settings, "deep")) return;
    const cur = useStore.getState().intel;
    if (cur?.meetingType === "sales" && (cur.slotFills?.length ?? 0) > 0) return;
    const snapshot = useAccounts.getState();
    const all = activeClaims(snapshot, companyId).filter(
      (c) => !threadId || !c.threadId || c.threadId === threadId
    );
    if (!all.length) return;
    backfillSlotIds({ settings, bundle, claims: all })
      .then((res) => {
        for (const r of res) useAccounts.getState().updateClaim(r.claimId, { slotIds: r.slotIds });
      })
      .catch((e) => log.warn("board: backfill failed", { error: String(e) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario.id, companyId, threadId, bundle.stage]);

  return (
    <div className="flex flex-col gap-2 border-b pb-2.5">
      {/* Counter-the-challenge focus: outranks gap-chasing, one at a time. */}
      {focus?.kind === "objection" && (
        <FocusBanner label={t("board.stage.counter")} question={focus.question} reason={focus.reason} />
      )}

      {/* One quiet line per slot; only the focused/tapped cell expands. */}
      <div className="flex flex-col">
        {rows.map(({ slot, claims: cards, state }) => {
          const fills = fillsBySlot.get(slot.id) ?? [];
          const focused = focus?.kind === "gap" && focus.slotId === slot.id;
          const tapped = manual?.slotId === slot.id;
          const newestCard = [...cards].sort((a, b) => b.lastSupportedAt - a.lastSupportedAt)[0];
          // 呼吸版: an empty slot shows NO ghost copy — the hint moved into
          // the expansion, so the resting board is labels, not a wall of grey.
          const content = fills[fills.length - 1]?.text ?? newestCard?.text ?? "";
          const n = cards.length + fills.length;
          return (
            <SlotRow
              key={slot.id}
              state={state === "empty" && fills.length > 0 ? "thin" : state}
              label={slot.label}
              content={content}
              count={n}
              focused={focused}
              activated={tapped}
              clickable
              busy={tapped && manual.status === "running"}
              onActivate={() => tapSlot(slot.id)}
            >
              {tapped && (
                <div className="flex flex-col gap-1 pb-0.5 pl-3 pt-1">
                  {/* What belongs here (the hint, now on demand)… */}
                  <p className="text-[10px] leading-snug text-muted-foreground/70">{slot.hint}</p>
                  {/* …what we captured… */}
                  {fills.map((f) => (
                    <div key={`${f.speaker}:${f.text}`} className="flex items-baseline gap-1.5">
                      <span
                        className={`shrink-0 text-[10px] ${
                          f.speaker === "me"
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-sky-600 dark:text-sky-400"
                        }`}
                      >
                        {f.speaker === "me" ? t("speaker.you") : t("speaker.them")}
                      </span>
                      <span className="min-w-0 flex-1 text-xs leading-snug">{f.text}</span>
                    </div>
                  ))}
                  {/* …and how to chase the rest. */}
                  {manual.status === "done" &&
                    manual.questions.slice(0, 2).map((q) => (
                      <div key={q.reply}>
                        <p className="text-xs leading-snug">{q.reply}</p>
                        <p className="text-[10px] leading-snug text-muted-foreground">
                          {q.consideration}
                        </p>
                      </div>
                    ))}
                  {manual.status === "error" && (
                    <p className="text-[10px] text-destructive">{t("board.stage.askFail")}</p>
                  )}
                </div>
              )}
              {focused && !tapped && (
                <div className="pb-0.5 pl-3 pt-1">
                  <p className="text-xs leading-snug">{focus.question}</p>
                  <p className="text-[10px] leading-snug text-muted-foreground">{focus.reason}</p>
                </div>
              )}
            </SlotRow>
          );
        })}
      </div>

      {scenario.id === "sales" && !companyId && (
        <p className="text-[10px] text-muted-foreground/70">{t("board.stage.unlinked")}</p>
      )}
    </div>
  );
}
