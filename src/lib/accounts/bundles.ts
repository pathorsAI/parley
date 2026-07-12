import { invoke, isTauri } from "@tauri-apps/api/core";
import { log } from "../log";
import { SALES_STAGES, type ClaimCategory, type SalesStage } from "./types";

/**
 * Stage bundles (design docs/design/stage-bundles.md): one bundle per sales
 * stage — gap-board schema + coach rules + exit criteria. Data-driven (S1):
 * builtins ship in code (copy via i18n), user overrides live in the config-dir
 * `stage-bundles.json` and replace a stage WHOLE (S9 — no per-slot merge).
 * P1 ships the data layer + war-room board; coach rules execute in P2/P3.
 */

/** One board cell. Ids are bundle-namespaced: `discovery.problem`. */
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
  slots: SlotDef[];
  /** Exit criteria (upgraded from the static stage guide; checkable in #147). */
  exitCriteria: string[];
  coachRules: CoachRuleDef[];
  /** Default expected meeting length (S6), minutes. */
  defaultDurationMin?: number;
}

/** The persisted override file: whole-stage replacement only (S9). */
export interface StageBundleFile {
  version: 1;
  overrides: Partial<Record<SalesStage, StageBundle>>;
}

type Tr = (key: string) => string;

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
      { id: "discovery.situation", label: "S（Situation）", hint: b("discovery.situation.hint"), query: { categories: ["goal", "relation"], side: "theirs", layer: "surface" } },
      { id: "discovery.problem", label: "P（Problem）", hint: b("discovery.problem.hint"), query: { categories: ["risk", "stance"], side: "theirs" } },
      { id: "discovery.implication", label: "I（Implication）", hint: b("discovery.implication.hint"), query: { categories: ["risk", "goal"], layer: "deep" } },
      { id: "discovery.needpayoff", label: "N（Need-payoff）", hint: b("discovery.needpayoff.hint"), query: { categories: ["goal", "nextmove"], side: "theirs", layer: "deep" } },
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
    proposal: coarseBundle("proposal", t, 30),
    negotiation: coarseBundle("negotiation", t, 45),
    closing: coarseBundle("closing", t, 30),
  };
}

const LS_KEY = "parley-stage-bundles";

/** Shallow shape check — a malformed override must not brick the board. */
function isBundleLike(v: unknown): v is StageBundle {
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

/** Parse the override file content into validated per-stage overrides. */
export function parseOverrides(raw: string): Partial<Record<SalesStage, StageBundle>> {
  if (!raw.trim()) return {};
  try {
    const file = JSON.parse(raw) as Partial<StageBundleFile>;
    const out: Partial<Record<SalesStage, StageBundle>> = {};
    for (const stage of SALES_STAGES) {
      const o = file?.overrides?.[stage];
      if (isBundleLike(o)) out[stage] = { ...o, stage };
      else if (o != null) log.warn("stage-bundles: dropped malformed override", { stage });
    }
    return out;
  } catch (e) {
    log.warn("stage-bundles: override file unreadable — using builtins", { error: String(e) });
    return {};
  }
}

/** Read user overrides from the config dir (localStorage in browser dev). */
export async function readStageBundleOverrides(): Promise<Partial<Record<SalesStage, StageBundle>>> {
  try {
    const raw = isTauri()
      ? await invoke<string>("read_stage_bundles")
      : (localStorage.getItem(LS_KEY) ?? "");
    return parseOverrides(raw);
  } catch (e) {
    log.warn("stage-bundles: override read failed — using builtins", { error: String(e) });
    return {};
  }
}

/** Merged view: an override replaces its stage whole (S9). */
export function mergeBundles(
  builtin: Record<SalesStage, StageBundle>,
  overrides: Partial<Record<SalesStage, StageBundle>>
): Record<SalesStage, StageBundle> {
  const out = { ...builtin };
  for (const stage of SALES_STAGES) {
    const o = overrides[stage];
    if (o) out[stage] = o;
  }
  return out;
}

/** Convenience: builtins (in the given language) + overrides, merged. */
export function stageBundles(
  t: Tr,
  overrides: Partial<Record<SalesStage, StageBundle>>
): Record<SalesStage, StageBundle> {
  return mergeBundles(buildBuiltinBundles(t), overrides);
}
