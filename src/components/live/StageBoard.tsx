import { useEffect, useMemo, useState } from "react";
import { Loader2, MessageCircleQuestion } from "lucide-react";
import { transcriptAsText, useStore } from "../../lib/store";
import { activeClaims, useAccounts } from "../../lib/accounts/store";
import { suggestSlotQuestions, type SlotQuestion } from "../../lib/accounts/suggest";
import {
  buildBuiltinBundles,
  mergeBundles,
  readStageBundleOverrides,
  type StageBundle,
} from "../../lib/accounts/bundles";
import { boardStates } from "../../lib/accounts/slotState";
import { backfillSlotIds } from "../../lib/accounts/backfill";
import { hasProviderKey } from "../../lib/ai/settings";
import { SALES_STAGES, type SalesStage } from "../../lib/accounts/types";
import { useI18n, type TranslationKey } from "../../i18n";
import { log } from "../../lib/log";

/**
 * The live gap board's "readable" form (S21, #147 P1-3): shown at the top of
 * the sales intel rail. Header = THIS call's stage (S19 — defaults to the
 * linked thread's stage, changeable per call, never writes back); body = the
 * stage bundle's slots with 空/薄/實 dots, attached cards, and ghost hints.
 * Live slotFills (in-call updates) arrive in P2 — this form reads the claim
 * base as it stands.
 */

/** Builtins in the current language, with user overrides once they load. */
function useStageBundles(): Record<SalesStage, StageBundle> {
  const { t } = useI18n();
  const [overrides, setOverrides] = useState<Partial<Record<SalesStage, StageBundle>>>({});
  useEffect(() => {
    readStageBundleOverrides()
      .then(setOverrides)
      .catch(() => {});
  }, []);
  return useMemo(
    () => mergeBundles(buildBuiltinBundles((k) => t(k as TranslationKey)), overrides),
    [t, overrides]
  );
}

export function StageBoard() {
  const { t } = useI18n();
  const acc = useAccounts();
  const settings = useStore((s) => s.settings);
  const companyId = useStore((s) => s.meetingCompanyId);
  const threadId = useStore((s) => s.meetingThreadId);
  const meetingStage = useStore((s) => s.meetingStage);
  const setMeetingStage = useStore((s) => s.setMeetingStage);
  const bundles = useStageBundles();

  const thread = acc.threads.find((x) => x.id === threadId) ?? null;
  const threadStage = thread?.kind === "sales" ? thread.stage : undefined;
  const stage: SalesStage = meetingStage ?? threadStage ?? SALES_STAGES[0];
  const bundle = bundles[stage];

  // Live fills for THIS call (§4.3): transient proposals from the realtime
  // extraction — they land in cells with a "pending" look, never the claim base.
  const intel = useStore((s) => s.intel);
  const fillsBySlot = useMemo(() => {
    const out = new Map<string, { text: string; speaker: "me" | "them" }[]>();
    if (intel?.meetingType !== "sales") return out;
    for (const f of intel.slotFills ?? []) {
      const list = out.get(f.slotId) ?? [];
      list.push({ text: f.text, speaker: f.speaker });
      out.set(f.slotId, list);
    }
    return out;
  }, [intel]);

  // 建議問法 (#148): per-slot, on demand, cleared when the stage flips.
  const [asks, setAsks] = useState<
    Record<string, { status: "running" | "done" | "error"; questions: SlotQuestion[] }>
  >({});
  useEffect(() => setAsks({}), [stage]);
  const canAsk = hasProviderKey(settings, "realtime");

  function ask(slotId: string) {
    const slot = bundle.slots.find((s) => s.id === slotId);
    if (!slot || asks[slotId]?.status === "running") return;
    setAsks((m) => ({ ...m, [slotId]: { status: "running", questions: [] } }));
    const state = useStore.getState();
    const attached = board.find((b) => b.slot.id === slotId)?.claims ?? [];
    const known = [
      ...attached.map((c) => c.text),
      ...(fillsBySlot.get(slotId)?.map((f) => f.text) ?? []),
    ];
    suggestSlotQuestions({
      settings: state.settings,
      stage,
      slot,
      knownTexts: known,
      transcriptTail: transcriptAsText(state.segments, state.speakerNames).slice(-2_000),
    })
      .then((questions) => setAsks((m) => ({ ...m, [slotId]: { status: "done", questions } })))
      .catch((e) => {
        log.warn("stage-board: suggest failed", { error: String(e) });
        setAsks((m) => ({ ...m, [slotId]: { status: "error", questions: [] } }));
      });
  }

  // This meeting's view of the claim base: thread-scoped + company-level cards.
  const claims = useMemo(
    () =>
      companyId
        ? activeClaims(acc, companyId).filter(
            (c) => !threadId || !c.threadId || c.threadId === threadId
          )
        : [],
    [acc, companyId, threadId]
  );
  const board = useMemo(() => boardStates(claims, bundle, Date.now()), [claims, bundle]);

  // Board-open backfill (#146): classify query-hit-but-untagged cards once per
  // stage, write results back into the claim base. Deliberately keyed on the
  // stage/company — not `claims` — so approving cards doesn't re-trigger it.
  useEffect(() => {
    if (!companyId || !hasProviderKey(settings, "deep")) return;
    const snapshot = useAccounts.getState();
    const all = activeClaims(snapshot, companyId).filter(
      (c) => !threadId || !c.threadId || c.threadId === threadId
    );
    if (!all.length) return;
    backfillSlotIds({ settings, bundle, claims: all })
      .then((res) => {
        for (const r of res) useAccounts.getState().updateClaim(r.claimId, { slotIds: r.slotIds });
      })
      .catch((e) => log.warn("stage-board: backfill failed", { error: String(e) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, threadId, bundle.stage]);

  return (
    <div className="flex flex-col gap-2 border-b pb-2.5">
      {/* S19: this call's stage. */}
      <div className="flex flex-wrap gap-1">
        {SALES_STAGES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setMeetingStage(s)}
            className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
              s === stage
                ? "border-primary bg-primary/10 font-semibold text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t(`accounts.stage.${s}` as TranslationKey)}
          </button>
        ))}
      </div>

      <p className="text-[11px] leading-snug">
        <span className="text-muted-foreground">{t("accounts.stageGuide.goal")}：</span>
        {t(`accounts.stageGuide.${stage}.goal` as TranslationKey)}
      </p>

      <div className="flex flex-col gap-1.5">
        {board.map(({ slot, claims: cards, state }) => {
          const fills = fillsBySlot.get(slot.id) ?? [];
          const askState = asks[slot.id];
          return (
            <div
              key={slot.id}
              className={`rounded-md border px-2 py-1.5 ${
                state === "empty" && fills.length === 0 ? "border-dashed" : ""
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={`size-1.5 shrink-0 rounded-full ${
                    state === "solid"
                      ? "bg-emerald-500"
                      : state === "thin" || fills.length > 0
                        ? "bg-amber-500"
                        : "border border-muted-foreground/50"
                  }`}
                />
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{slot.label}</span>
                {cards.length > 0 && (
                  <span className="text-[10px] text-muted-foreground">{cards.length}</span>
                )}
                {canAsk && (
                  <button
                    type="button"
                    title={t("board.stage.ask")}
                    className="text-muted-foreground/60 transition-colors hover:text-foreground"
                    onClick={() => ask(slot.id)}
                  >
                    {askState?.status === "running" ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <MessageCircleQuestion className="size-3" />
                    )}
                  </button>
                )}
              </div>

              {cards.slice(0, 3).map((c) => (
                <p
                  key={c.id}
                  className="truncate pl-3 text-[11px] text-muted-foreground"
                  title={c.text}
                >
                  {c.text}
                </p>
              ))}
              {/* Live fills: pending-review look — captured this call, not yet in the base. */}
              {fills.map((f) => (
                <p key={f.text} className="pl-3 text-[11px] italic leading-snug text-sky-600 dark:text-sky-400">
                  ✎ {f.text}
                  <span className="ml-1 not-italic text-[9px] text-muted-foreground">
                    {t("board.stage.pending")}
                  </span>
                </p>
              ))}
              {cards.length === 0 && fills.length === 0 && (
                // Ghost hint: what belongs here — doubles as "how to ask" (§5 seeds).
                <p className="pl-3 text-[11px] leading-snug text-muted-foreground/70">{slot.hint}</p>
              )}

              {/* 建議問法 (#148): speakable lines, ride the conversation. */}
              {askState?.status === "error" && (
                <p className="pl-3 text-[10px] text-destructive">{t("board.stage.askFail")}</p>
              )}
              {askState?.status === "done" &&
                askState.questions.map((q) => (
                  <div key={q.reply} className="mt-1 rounded border-l-2 border-primary/50 bg-muted/40 py-0.5 pl-2 pr-1">
                    <p className="text-[11px] leading-snug">{q.reply}</p>
                    <p className="text-[10px] leading-snug text-muted-foreground">{q.consideration}</p>
                  </div>
                ))}
            </div>
          );
        })}
      </div>

      <div>
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          {t("accounts.stageGuide.exit")}
        </span>
        {bundle.exitCriteria.map((x) => (
          <p key={x} className="text-[11px] leading-snug text-muted-foreground">
            ○ {x}
          </p>
        ))}
      </div>

      {!companyId && (
        <p className="text-[10px] text-muted-foreground/70">{t("board.stage.unlinked")}</p>
      )}
    </div>
  );
}
