import { useEffect, useMemo, useState } from "react";
import { useStore, meetingElapsedMs } from "../../lib/store";
import { typedBoard, applyNextStepGate } from "../../lib/intel/boards";
import { useI18n } from "../../i18n";
import type { IntelSlotFill } from "../../lib/types";
import { FocusBanner, SlotRow } from "./SlotBoard";

/**
 * The negotiation/partnership board (C integration): the same one-line-per-slot
 * model as the sales gap board, over the type's fixed slots (boards.ts) — no
 * claim base underneath, fills only. Tapping a row expands every accumulated
 * fill (the numbers ledger wants the whole list, not just the newest).
 */
export function TypedBoard({ type }: Readonly<{ type: "negotiation" | "partnership" }>) {
  const { t, language } = useI18n();
  const intel = useStore((s) => s.intel);
  const recording = useStore((s) => s.meetingStatus === "recording");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const board = useMemo(() => typedBoard(type, t), [type, language]);

  const live = intel?.meetingType === type ? intel : null;
  const fillsBySlot = useMemo(() => {
    const out = new Map<string, IntelSlotFill[]>();
    for (const f of live?.slotFills ?? []) out.set(f.slotId, [...(out.get(f.slotId) ?? []), f]);
    return out;
  }, [live]);

  // Next-step gate clock (same cadence as the sales board).
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

  // One expansion at a time; tapping again collapses.
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => setOpen(null), [type]);

  return (
    <div className="flex flex-col gap-2 border-b pb-2.5">
      {focus?.kind === "objection" && (
        <FocusBanner label={t("board.stage.counter")} question={focus.question} reason={focus.reason} />
      )}

      <div className="flex flex-col">
        {board.slots.map((slot) => {
          const fills = fillsBySlot.get(slot.id) ?? [];
          const focused = focus?.kind === "gap" && focus.slotId === slot.id;
          const opened = open === slot.id;
          const content = fills[fills.length - 1]?.text ?? slot.hint;
          return (
            <SlotRow
              key={slot.id}
              state={fills.length >= 2 ? "solid" : fills.length === 1 ? "thin" : "empty"}
              label={slot.label}
              content={content}
              count={fills.length}
              focused={focused}
              activated={opened}
              clickable={fills.length > 1}
              onActivate={() => setOpen(opened ? null : slot.id)}
            >
              {opened &&
                fills.map((f, i) => (
                  <div key={i} className="flex items-baseline gap-1.5 pb-0.5 pl-3 pt-1">
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
              {focused && !opened && (
                <div className="pb-0.5 pl-3 pt-1">
                  <p className="text-xs leading-snug">{focus.question}</p>
                  <p className="text-[10px] leading-snug text-muted-foreground">{focus.reason}</p>
                </div>
              )}
            </SlotRow>
          );
        })}
      </div>
    </div>
  );
}
