import { translate, type TranslationKey } from "../../i18n/messages";
import { resolveMeetingBundle } from "../accounts/currentStage";
import { buildStageSet, readStageBundleFile } from "../accounts/bundles";
import type { SlotDef, StageBundle } from "../accounts/bundleFile";
import type { ExtractedNewClaim } from "../accounts/store";
import type { IntelSlotFill, IntelState, MeetingType, Settings } from "../types";

/**
 * ONE board model for every typed meeting (C-integration): the intelligence
 * board is a slot board regardless of meeting type. Sales resolves THIS call's
 * stage bundle (plus shared cross-stage slots); negotiation and partnership
 * carry fixed builtin boards. The unified extraction fills slots, the board
 * renders them, and the next-step gate reads board state deterministically.
 */
export interface MeetingBoard {
  type: Exclude<MeetingType, "general">;
  slots: SlotDef[];
  /** Expected meeting length (minutes) — drives the next-step gate. */
  durationMin: number;
  /** Gate fires when remaining time falls below this percentage. */
  gateAtRemainingPct: number;
  /** The board's next-step slot (gate target), if it has one. */
  nextSlotId: string | null;
}

function slot(
  t: (k: TranslationKey) => string,
  id: string,
  key: string,
  query: SlotDef["query"] = { categories: [] }
): SlotDef {
  return {
    id,
    label: t(`board.slot.${key}.label` as TranslationKey),
    hint: t(`board.slot.${key}.hint` as TranslationKey),
    query,
  };
}

/** Negotiation board: the ledgers the old IntelSections held, as slots. */
function negotiationSlots(t: (k: TranslationKey) => string): SlotDef[] {
  return [
    slot(t, "nego.numbers", "nego.numbers"),
    slot(t, "nego.give", "nego.give"),
    slot(t, "nego.get", "nego.get"),
    slot(t, "nego.agreed", "nego.agreed"),
    slot(t, "nego.open", "nego.open"),
    slot(t, "nego.next", "nego.next", { categories: ["nextmove"] }),
  ];
}

/** Partnership board: they-have × they-need, leverage, give/get. */
function partnershipSlots(t: (k: TranslationKey) => string): SlotDef[] {
  return [
    slot(t, "partner.have", "partner.have"),
    slot(t, "partner.need", "partner.need"),
    slot(t, "partner.leverage", "partner.leverage", { categories: ["leverage"] }),
    slot(t, "partner.give", "partner.give"),
    slot(t, "partner.get", "partner.get"),
    slot(t, "partner.next", "partner.next", { categories: ["nextmove"] }),
  ];
}

/**
 * Cross-stage sales slots appended to every stage bundle: the next-step
 * commitment and competitor mentions — the two ledgers every sales call keeps
 * regardless of stage. A bundle that already owns a `.next` slot (prospecting)
 * keeps its own. Exported for tests.
 */
export function withSharedSalesSlots(
  slots: SlotDef[],
  t: (k: TranslationKey) => string
): SlotDef[] {
  const out = [...slots];
  if (!slots.some((s) => s.id.endsWith(".next"))) {
    out.push(slot(t, "sales.next", "sales.next", { categories: ["nextmove"] }));
  }
  if (!slots.some((s) => s.query.categories.includes("competitor"))) {
    out.push(slot(t, "sales.competitors", "sales.competitors", { categories: ["competitor"] }));
  }
  return out;
}

/** Find the board's next-step slot. Exported for tests. */
export function nextSlotIdOf(slots: SlotDef[]): string | null {
  return slots.find((s) => s.id.endsWith(".next"))?.id ?? null;
}

const GATE_DEFAULT_PCT = 20;
const DURATION_DEFAULT_MIN = 60;

/** The sales board for one stage bundle — shared slots appended, gate params
 *  read from the bundle's (previously dormant) nextstep-gate coach rule. Sync,
 *  so StageBoard can derive it from its already-loaded stage set. */
export function salesBoardFromBundle(
  bundle: StageBundle,
  t: (k: TranslationKey) => string
): MeetingBoard {
  const slots = withSharedSalesSlots(bundle.slots, t);
  const gate = bundle.coachRules.find((r) => r.kind === "nextstep-gate");
  return {
    type: "sales",
    slots,
    durationMin: bundle.defaultDurationMin ?? DURATION_DEFAULT_MIN,
    gateAtRemainingPct: gate?.triggerAtRemainingPct ?? GATE_DEFAULT_PCT,
    nextSlotId: nextSlotIdOf(slots),
  };
}

/** The fixed board for a non-sales typed meeting. Sync. */
export function typedBoard(
  type: "negotiation" | "partnership",
  t: (k: TranslationKey) => string
): MeetingBoard {
  const slots = type === "negotiation" ? negotiationSlots(t) : partnershipSlots(t);
  return {
    type,
    slots,
    durationMin: DURATION_DEFAULT_MIN,
    gateAtRemainingPct: GATE_DEFAULT_PCT,
    nextSlotId: nextSlotIdOf(slots),
  };
}

/** Resolve the board for a meeting type; null for "general" (todos only). */
export async function resolveBoard(
  type: MeetingType,
  settings: Settings
): Promise<MeetingBoard | null> {
  if (type === "general") return null;
  const t = (key: TranslationKey) => translate(settings.language, key);
  if (type === "sales") return salesBoardFromBundle(await resolveMeetingBundle(settings), t);
  return typedBoard(type, t);
}

/**
 * Every slot the type can ever produce, id → def. The study readout resolves
 * labels through this instead of one resolved stage board — a recording only
 * says which slots it FILLED, not which stage was live, and sales slot ids are
 * stage-namespaced so the union is collision-free.
 */
export async function slotCatalog(
  type: MeetingType,
  settings: Settings
): Promise<Map<string, SlotDef>> {
  if (type === "general") return new Map();
  const t = (key: TranslationKey) => translate(settings.language, key);
  if (type !== "sales") return new Map(typedBoard(type, t).slots.map((s) => [s.id, s]));
  const set = buildStageSet(
    (key: string) => t(key as TranslationKey),
    await readStageBundleFile({ fresh: true })
  );
  const map = new Map<string, SlotDef>();
  for (const stage of set.order) {
    for (const s of set.bundles[stage]?.slots ?? []) map.set(s.id, s);
  }
  for (const s of withSharedSalesSlots([], t)) map.set(s.id, s);
  return map;
}

/**
 * Next-step gate (the one coach rule that runs, deterministically): when the
 * meeting enters its last stretch and the next-step slot is still empty, the
 * board's focus becomes "pin the next step" — no LLM involved. A live
 * objection focus outranks it (countering a challenge beats housekeeping).
 * Pure function; exported for tests.
 */
export function applyNextStepGate(opts: {
  focus: IntelState["focusSlot"];
  fills: IntelSlotFill[];
  board: MeetingBoard;
  elapsedMs: number;
  question: string;
  reason: string;
}): IntelState["focusSlot"] {
  const { focus, fills, board, elapsedMs, question, reason } = opts;
  if (!board.nextSlotId) return focus;
  if (focus?.kind === "objection") return focus;
  const gateAtMs = board.durationMin * 60_000 * (1 - board.gateAtRemainingPct / 100);
  if (elapsedMs < gateAtMs) return focus;
  if (fills.some((f) => f.slotId === board.nextSlotId)) return focus;
  return { kind: "gap", slotId: board.nextSlotId, question, reason };
}

/**
 * Turn the meeting's accumulated slot fills into claim candidates for the
 * post-meeting review (B6): the live extraction is the only transcript→slot
 * pass; review starts from its output instead of re-tagging. Claim category
 * rides the slot's query; text dedupes case-insensitively. Pure; tested.
 */
export function fillsToClaimCandidates(
  fills: IntelSlotFill[],
  slots: SlotDef[]
): ExtractedNewClaim[] {
  const byId = new Map(slots.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const out: ExtractedNewClaim[] = [];
  for (const f of fills) {
    const slot = byId.get(f.slotId);
    const key = f.text.trim().toLowerCase();
    if (!slot || !key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      category: slot.query.categories[0] ?? "stance",
      text: f.text.trim(),
      subjects: [],
      side: slot.query.side ?? "",
      layer: slot.query.layer ?? "",
      quote: f.quote,
      slotIds: [f.slotId],
    });
  }
  return out;
}
