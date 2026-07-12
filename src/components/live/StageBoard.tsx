import { useEffect, useMemo, useState } from "react";
import { useStore } from "../../lib/store";
import { activeClaims, useAccounts } from "../../lib/accounts/store";
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
 * The live gap board (S21/S22, #147): a SECOND-attention surface — one line
 * per slot, glanceable in 1–2 seconds of peripheral vision. The realtime
 * extraction auto-focuses the ONE slot to chase next (stage order first,
 * riding the current topic) and the board highlights only that cell with one
 * speakable question. No per-cell actions: the user picks TIMING (refresh /
 * the 30s cadence), never direction. Header = THIS call's stage (S19).
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
  const intel = useStore((s) => s.intel);
  const bundles = useStageBundles();

  const thread = acc.threads.find((x) => x.id === threadId) ?? null;
  const threadStage = thread?.kind === "sales" ? thread.stage : undefined;
  const stage: SalesStage = meetingStage ?? threadStage ?? SALES_STAGES[0];
  const bundle = bundles[stage];

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

  // Live fills + auto-focus for THIS call (§4.3/S22): UI transient, from the
  // 30s realtime pass — the claim base is written at post-meeting review (D8).
  const live = intel?.meetingType === "sales" ? intel : null;
  const fillsBySlot = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const f of live?.slotFills ?? []) out.set(f.slotId, [...(out.get(f.slotId) ?? []), f.text]);
    return out;
  }, [live]);
  const focus = live?.focusSlot;

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
                ? "border-primary/60 bg-primary/10 font-semibold text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t(`accounts.stage.${s}` as TranslationKey)}
          </button>
        ))}
      </div>

      {/* One line per slot; ONLY the focused cell expands (S22). */}
      <div className="flex flex-col">
        {board.map(({ slot, claims: cards, state }) => {
          const fills = fillsBySlot.get(slot.id) ?? [];
          const focused = focus?.slotId === slot.id;
          const newestCard = [...cards].sort((a, b) => b.lastSupportedAt - a.lastSupportedAt)[0];
          const content = fills[fills.length - 1] ?? newestCard?.text ?? slot.hint;
          const n = cards.length + fills.length;
          return (
            <div
              key={slot.id}
              className={`rounded-md px-1.5 py-1 ${focused ? "bg-secondary" : ""}`}
            >
              <div className="flex items-baseline gap-1.5">
                <span
                  className={`size-1.5 shrink-0 self-center rounded-full ${
                    state === "solid"
                      ? "bg-emerald-500"
                      : state === "thin" || fills.length > 0
                        ? "bg-amber-500"
                        : "border border-muted-foreground/50"
                  }`}
                />
                <span className="shrink-0 text-xs font-medium">{slot.label}</span>
                <span
                  className={`min-w-0 flex-1 truncate text-[11px] ${
                    n > 0 ? "text-muted-foreground" : "text-muted-foreground/60"
                  }`}
                >
                  {content}
                </span>
                {n > 0 && <span className="shrink-0 text-[10px] text-muted-foreground">{n}</span>}
              </div>
              {focused && (
                <div className="pb-0.5 pl-3 pt-1">
                  <p className="text-xs leading-snug">{focus.question}</p>
                  <p className="text-[10px] leading-snug text-muted-foreground">{focus.reason}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!companyId && (
        <p className="text-[10px] text-muted-foreground/70">{t("board.stage.unlinked")}</p>
      )}
    </div>
  );
}
