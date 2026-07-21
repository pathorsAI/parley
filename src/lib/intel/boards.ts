import { translate, type TranslationKey } from "../../i18n/messages";
import { resolveScenarioStageId } from "../accounts/currentStage";
import {
  buildScenarioSet,
  readStageBundleFile,
  type Scenario,
  type ScenarioSet,
} from "../accounts/bundles";
import type { SlotDef, StageBundle } from "../accounts/bundleFile";
import type { ExtractedNewClaim } from "../accounts/store";
import type { IntelSlotFill, IntelState, MeetingType, Settings } from "../types";

/**
 * ONE board model for every meeting scenario (scenario system): a scenario is
 * an ordered list of stages, each stage a slot board. The unified extraction
 * fills slots, the board renders them, and the next-step gate reads board
 * state deterministically. Sales is not special here — it's just the builtin
 * scenario that happens to have five stages.
 */
export interface MeetingBoard {
  scenarioId: string;
  stageId: string;
  slots: SlotDef[];
  /** Extraction guidance (from the scenario; model input). */
  guidance: string;
  /** Expected meeting length (minutes) — drives the next-step gate. */
  durationMin: number;
  /** Gate fires when remaining time falls below this percentage. */
  gateAtRemainingPct: number;
  /** The board's next-step slot (gate target), if it has one. */
  nextSlotId: string | null;
}

function sharedSlot(
  t: (k: TranslationKey) => string,
  id: string,
  key: string,
  query: SlotDef["query"]
): SlotDef {
  return {
    id,
    label: t(`board.slot.${key}.label` as TranslationKey),
    hint: t(`board.slot.${key}.hint` as TranslationKey),
    query,
  };
}

/**
 * Cross-stage shared slots: every board keeps a next-step slot (the gate's
 * target); sales boards also track competitor mentions. A bundle that already
 * owns a `.next` slot keeps its own. Exported for tests.
 */
export function withSharedSlots(
  slots: SlotDef[],
  t: (k: TranslationKey) => string,
  opts: { competitors?: boolean } = {}
): SlotDef[] {
  const out = [...slots];
  if (!slots.some((s) => s.id.endsWith(".next"))) {
    out.push(sharedSlot(t, "sales.next", "sales.next", { categories: ["nextmove"] }));
  }
  if (opts.competitors && !slots.some((s) => s.query.categories.includes("competitor"))) {
    out.push(
      sharedSlot(t, "sales.competitors", "sales.competitors", { categories: ["competitor"] })
    );
  }
  return out;
}

/** Find the board's next-step slot. Exported for tests. */
export function nextSlotIdOf(slots: SlotDef[]): string | null {
  return slots.find((s) => s.id.endsWith(".next"))?.id ?? null;
}

const GATE_DEFAULT_PCT = 20;
const DURATION_DEFAULT_MIN = 60;

/** The board for one scenario stage — shared slots appended, gate params read
 *  from the bundle's nextstep-gate coach rule. Pure/sync; exported for the
 *  ScenarioBoard, which already holds the scenario. */
export function boardFromBundle(
  scenario: Pick<Scenario, "id" | "guidance">,
  bundle: StageBundle,
  t: (k: TranslationKey) => string
): MeetingBoard {
  const slots = withSharedSlots(bundle.slots, t, { competitors: scenario.id === "sales" });
  const gate = bundle.coachRules.find((r) => r.kind === "nextstep-gate");
  return {
    scenarioId: scenario.id,
    stageId: bundle.stage,
    slots,
    guidance: scenario.guidance,
    durationMin: bundle.defaultDurationMin ?? DURATION_DEFAULT_MIN,
    gateAtRemainingPct: gate?.triggerAtRemainingPct ?? GATE_DEFAULT_PCT,
    nextSlotId: nextSlotIdOf(slots),
  };
}

/** Fresh scenario set for imperative callers (extraction, review, catalog). */
export async function resolveScenarioSet(settings: Settings): Promise<ScenarioSet> {
  const t = (key: string) => translate(settings.language, key as TranslationKey);
  return buildScenarioSet(t, await readStageBundleFile({ fresh: true }));
}

/** Resolve the live board for a meeting type; null for "general" (todos only)
 *  and for scenario ids that no longer exist (deleted customs). */
export async function resolveBoard(
  type: MeetingType,
  settings: Settings
): Promise<MeetingBoard | null> {
  if (type === "general") return null;
  const t = (key: TranslationKey) => translate(settings.language, key);
  const scenario = (await resolveScenarioSet(settings)).byId[type];
  if (!scenario) return null;
  const stageId = resolveScenarioStageId(scenario);
  const bundle = scenario.bundles[stageId];
  return bundle ? boardFromBundle(scenario, bundle, t) : null;
}

/**
 * Every slot the scenario can ever produce, id → def. The study readout
 * resolves labels through this instead of one resolved stage board — a
 * recording only says which slots it FILLED, not which stage was live, and
 * slot ids are stage-namespaced so the union is collision-free.
 */
export async function slotCatalog(
  type: MeetingType,
  settings: Settings
): Promise<Map<string, SlotDef>> {
  if (type === "general") return new Map();
  const t = (key: TranslationKey) => translate(settings.language, key);
  const scenario = (await resolveScenarioSet(settings)).byId[type];
  if (!scenario) return new Map();
  const map = new Map<string, SlotDef>();
  for (const stage of scenario.order) {
    for (const s of scenario.bundles[stage]?.slots ?? []) map.set(s.id, s);
  }
  for (const s of withSharedSlots([], t, { competitors: scenario.id === "sales" })) {
    map.set(s.id, s);
  }
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
