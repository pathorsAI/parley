import { SALES_STAGES, type ClaimCategory, type SalesStage } from "./types";

/**
 * Stage-bundle schema, builtin content, and file parsing — PURE module: no
 * Tauri, no store, no logging. Shared by the app (bundles.ts wraps it with
 * config-dir IO) and by the MCP editing server (mcp/stage-bundles-server.ts),
 * so both sides validate with exactly the same rules (#155).
 *
 * File format v2 (config-dir `stage-bundles.json`):
 *   { version: 2,
 *     stages:   [{ id, name, insertAfter?, bundle }],   // user-defined stages
 *     overrides: { [stageId]: StageBundle } }           // whole-stage replace (S9)
 * v1 files ({ version: 1, overrides }) keep parsing unchanged.
 */

/** One board cell. Ids are stage-namespaced: `discovery.problem`. */
export interface SlotDef {
  id: string;
  /** Cell header (SPIN letters per S13, or a short phrase). */
  label: string;
  /** What belongs here — doubles as ghost-row copy and extraction hint (S3). */
  hint: string;
  /** Coarse fallback query: existing claims matching it pre-attach (S3). */
  query: {
    categories: ClaimCategory[];
    side?: "ours" | "theirs";
    layer?: "surface" | "deep";
  };
  /** "Solid" threshold: fresh cards needed (confirmed counts alone). Default 2. */
  solidAt?: number;
}

/** In-call coach rules. Local kinds cost no AI; eval kinds ride the eval engine (S5). */
export type CoachRuleDef =
  | { kind: "nextstep-gate"; triggerAtRemainingPct: number; cooldownSec: number }
  | { kind: "premature-pricing"; guardSlots: string[]; cooldownSec: number }
  | { kind: "premature-demo"; guardSlots: string[]; cooldownSec: number }
  | { kind: "spin-order"; prompt: string; cooldownSec: number }
  | { kind: "open-question"; cooldownSec: number }
  | { kind: "s-tax"; cooldownSec: number }
  | { kind: "talk-ratio"; meMaxPct?: number; meMinPct?: number; monologueSec: number }
  | { kind: "stage-mismatch"; cooldownSec: number };

export interface StageBundle {
  stage: SalesStage;
  boardTitle: string;
  /** Display name — REQUIRED for custom stages (builtins resolve via i18n). */
  name?: string;
  /** Stage goal for the guide view — custom stages carry it here (builtins
   *  resolve via i18n `accounts.stageGuide.*`). */
  goal?: string;
  slots: SlotDef[];
  /** Exit criteria (upgraded from the static stage guide; checkable in #147). */
  exitCriteria: string[];
  coachRules: CoachRuleDef[];
  /** Default expected meeting length (S6), minutes. */
  defaultDurationMin?: number;
}

/** A user-defined pipeline stage (#155) — e.g. a dedicated cold-call stage. */
export interface CustomStageDef {
  /** Slug id, no dots (it namespaces slot ids and the `<stage>.none` sentinel). */
  id: string;
  /** Display name (shown on steppers/chips — custom stages don't use i18n keys). */
  name: string;
  /** Where it sits in the pipeline: after this stage id; default = appended. */
  insertAfter?: string;
  bundle: StageBundle;
}

/** The persisted file. v1 = overrides only; v2 adds custom stages. */
export interface StageBundleFile {
  version: 1 | 2;
  stages?: CustomStageDef[];
  overrides?: Partial<Record<SalesStage, StageBundle>>;
}

export interface ParsedBundleFile {
  customStages: CustomStageDef[];
  overrides: Partial<Record<SalesStage, StageBundle>>;
}

export const EMPTY_BUNDLE_FILE: ParsedBundleFile = { customStages: [], overrides: {} };

type Warn = (message: string, context?: Record<string, unknown>) => void;

/** Shallow shape check — a malformed bundle must not brick the board. */
export function isBundleLike(v: unknown): v is StageBundle {
  if (!v || typeof v !== "object") return false;
  const b = v as StageBundle;
  return (
    Array.isArray(b.slots) &&
    b.slots.every((s) => !!s && typeof s.id === "string" && typeof s.label === "string") &&
    Array.isArray(b.exitCriteria) &&
    Array.isArray(b.coachRules) &&
    typeof b.boardTitle === "string"
  );
}

/** Slot ids must carry the stage prefix — the backfill's "classified for this
 *  stage" test and the `<stage>.none` sentinel both key off it (#146). */
export function slotsMatchStage(bundle: StageBundle, stage: string): boolean {
  return bundle.slots.every((s) => s.id.startsWith(`${stage}.`));
}

/** Custom stage ids are dot-free slugs and must not shadow a builtin. */
export function isValidCustomStageId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    /^[a-z][a-z0-9-]*$/.test(id) &&
    !(SALES_STAGES as string[]).includes(id)
  );
}

function isCustomStageLike(v: unknown): v is CustomStageDef {
  if (!v || typeof v !== "object") return false;
  const c = v as CustomStageDef;
  return (
    isValidCustomStageId(c.id) &&
    typeof c.name === "string" &&
    !!c.name.trim() &&
    (c.insertAfter === undefined || typeof c.insertAfter === "string") &&
    isBundleLike(c.bundle) &&
    slotsMatchStage(c.bundle, c.id)
  );
}

/** Parse + validate the whole file. Malformed entries are dropped one by one
 *  (never the whole file), reported through `warn`. */
export function parseBundleFile(raw: string, warn: Warn = () => {}): ParsedBundleFile {
  if (!raw.trim()) return EMPTY_BUNDLE_FILE;
  let file: Partial<StageBundleFile>;
  try {
    file = JSON.parse(raw) as Partial<StageBundleFile>;
  } catch (e) {
    warn("stage-bundles: file unreadable — using builtins", { error: String(e) });
    return EMPTY_BUNDLE_FILE;
  }
  if (!file || typeof file !== "object") return EMPTY_BUNDLE_FILE;

  // 1. Custom stages (v2). First definition of an id wins.
  const customStages: CustomStageDef[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(file.stages) ? file.stages : []) {
    if (isCustomStageLike(entry) && !seen.has(entry.id)) {
      seen.add(entry.id);
      // S24 merged the builtin "proposal" stage into "negotiation" — an anchor
      // pointing at the removed stage keeps its pipeline position via the
      // survivor instead of falling to the end.
      const insertAfter = entry.insertAfter === "proposal" ? "negotiation" : entry.insertAfter;
      customStages.push({
        ...entry,
        insertAfter,
        bundle: { ...entry.bundle, stage: entry.id, name: entry.name },
      });
    } else {
      warn("stage-bundles: dropped malformed custom stage", {
        id: (entry as CustomStageDef | null)?.id,
      });
    }
  }

  // 2. Overrides — keyed to a builtin or a (just-parsed) custom stage.
  const knownIds = new Set<string>([...SALES_STAGES, ...seen]);
  const overrides: Partial<Record<SalesStage, StageBundle>> = {};
  for (const [stage, o] of Object.entries(file.overrides ?? {})) {
    if (!knownIds.has(stage)) {
      warn("stage-bundles: dropped override for unknown stage", { stage });
    } else if (isBundleLike(o) && slotsMatchStage(o, stage)) {
      overrides[stage] = { ...o, stage };
    } else if (o != null) {
      warn("stage-bundles: dropped malformed override", { stage });
    }
  }
  return { customStages, overrides };
}

/** Serialize back to the v2 file format — the single writer shape for the
 *  Settings editor, the MCP server, and tests (round-trips with parse). */
export function serializeBundleFile(parsed: ParsedBundleFile): string {
  return JSON.stringify(
    { version: 2, stages: parsed.customStages, overrides: parsed.overrides },
    null,
    2
  );
}

/** Full pipeline order: builtins with customs spliced in after their anchor
 *  (file order among siblings); unknown/absent anchors append at the end. */
export function stageOrder(customStages: CustomStageDef[]): SalesStage[] {
  const order: SalesStage[] = [...SALES_STAGES];
  for (const c of customStages) {
    const at = c.insertAfter ? order.indexOf(c.insertAfter) : -1;
    if (at >= 0) order.splice(at + 1, 0, c.id);
    else order.push(c.id);
  }
  return order;
}

// ── Builtin bundles ──────────────────────────────────────────────────────────

/** i18n lookup used to resolve builtin copy (rebuilds on language change). */
export type Tr = (key: string) => string;

/**
 * Coarse conversion for stages whose bespoke boards aren't authored yet
 * (§8 P1): each line of the existing stage-guide "collect" copy becomes one
 * slot (line = label = hint, no auto-attach query). Final copy lands at the
 * P1 content review (doc open question 3).
 */
function coarseBundle(stage: SalesStage, t: Tr, durationMin: number): StageBundle {
  const lines = t(`accounts.stageGuide.${stage}.collect`)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    stage,
    boardTitle: t(`accounts.stage.${stage}`),
    slots: lines.map((line, i) => ({
      id: `${stage}.c${i}`,
      label: line,
      hint: line,
      query: { categories: [] },
    })),
    exitCriteria: [t(`accounts.stageGuide.${stage}.exit`)],
    coachRules: [{ kind: "nextstep-gate", triggerAtRemainingPct: 20, cooldownSec: 300 }],
    defaultDurationMin: durationMin,
  };
}

/** The six builtin bundles, copy resolved through i18n (rebuild on language change). */
export function buildBuiltinBundles(t: Tr): Record<SalesStage, StageBundle> {
  const b = (key: string) => t(`accounts.bundle.${key}`);
  const prospecting: StageBundle = {
    stage: "prospecting",
    boardTitle: b("prospecting.title"),
    slots: [
      { id: "prospecting.identity", label: b("prospecting.identity.label"), hint: b("prospecting.identity.hint"), query: { categories: ["relation"] } },
      { id: "prospecting.trigger", label: b("prospecting.trigger.label"), hint: b("prospecting.trigger.hint"), query: { categories: ["goal", "openq"], side: "theirs" } },
      { id: "prospecting.pain", label: b("prospecting.pain.label"), hint: b("prospecting.pain.hint"), query: { categories: ["risk"], side: "theirs" } },
      { id: "prospecting.impact", label: b("prospecting.impact.label"), hint: b("prospecting.impact.hint"), query: { categories: ["risk", "goal"], side: "theirs" } },
      { id: "prospecting.next", label: b("prospecting.next.label"), hint: b("prospecting.next.hint"), query: { categories: ["nextmove"] }, solidAt: 1 },
    ],
    exitCriteria: [b("prospecting.exit1"), b("prospecting.exit2"), b("prospecting.exit3")],
    coachRules: [
      // The whole stage optimizes for ONE outcome: a booked demo (playbook 心法).
      { kind: "talk-ratio", meMaxPct: 30, monologueSec: 60 },
      { kind: "nextstep-gate", triggerAtRemainingPct: 20, cooldownSec: 300 },
      { kind: "premature-demo", guardSlots: ["prospecting.pain", "prospecting.impact"], cooldownSec: 300 },
    ],
    defaultDurationMin: 15,
  };
  const discovery: StageBundle = {
    stage: "discovery",
    boardTitle: b("discovery.title"),
    slots: [
      { id: "discovery.situation", label: b("discovery.situation.label"), hint: b("discovery.situation.hint"), query: { categories: ["goal", "relation"], side: "theirs", layer: "surface" } },
      { id: "discovery.problem", label: b("discovery.problem.label"), hint: b("discovery.problem.hint"), query: { categories: ["risk", "stance"], side: "theirs" } },
      { id: "discovery.implication", label: b("discovery.implication.label"), hint: b("discovery.implication.hint"), query: { categories: ["risk", "goal"], layer: "deep" } },
      { id: "discovery.needpayoff", label: b("discovery.needpayoff.label"), hint: b("discovery.needpayoff.hint"), query: { categories: ["goal", "nextmove"], side: "theirs", layer: "deep" } },
      { id: "discovery.committee", label: b("discovery.committee.label"), hint: b("discovery.committee.hint"), query: { categories: ["stance", "relation"] } },
    ],
    exitCriteria: [t("accounts.stageGuide.discovery.exit"), b("discovery.exitOwned")],
    coachRules: [
      { kind: "talk-ratio", meMaxPct: 40, monologueSec: 60 },
      { kind: "nextstep-gate", triggerAtRemainingPct: 20, cooldownSec: 300 },
      { kind: "premature-pricing", guardSlots: ["discovery.problem", "discovery.implication"], cooldownSec: 300 },
      { kind: "premature-demo", guardSlots: ["discovery.implication"], cooldownSec: 300 },
      { kind: "s-tax", cooldownSec: 600 },
      {
        kind: "spin-order",
        // Runs on the eval engine (P3) — terse English keeps the eval prompt stable.
        prompt:
          "Flag when ME pitches solution value while the customer has not yet " +
          "quantified the pain's consequences, or when implications are stated " +
          "by ME instead of elicited from the customer.",
        cooldownSec: 600,
      },
      { kind: "stage-mismatch", cooldownSec: 600 },
    ],
    defaultDurationMin: 40,
  };
  const demo = coarseBundle("demo", t, 45);
  // Demo inverts the listening ratio and polices open questions (playbook §demo).
  demo.coachRules = [
    { kind: "talk-ratio", meMinPct: 55, monologueSec: 120 },
    { kind: "open-question", cooldownSec: 300 },
    { kind: "nextstep-gate", triggerAtRemainingPct: 20, cooldownSec: 300 },
  ];
  return {
    prospecting,
    discovery,
    demo,
    // S24: the old separate "proposal" stage merged in — its collect lines are
    // this bundle's c0..c3 and the original negotiation lines shifted to
    // c4..c7 (the accounts-load migration remaps legacy slot ids to match).
    negotiation: coarseBundle("negotiation", t, 45),
    closing: coarseBundle("closing", t, 30),
  };
}
