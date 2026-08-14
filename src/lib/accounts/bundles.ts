import { invoke, isTauri } from "@tauri-apps/api/core";
import { log } from "../log";
import { SALES_STAGES, type SalesStage } from "./types";
import {
  buildBuiltinBundles,
  buildTypedBuiltinBundles,
  BUILTIN_KIND_IDS,
  BUILTIN_SCENARIO_IDS,
  EMPTY_BUNDLE_FILE,
  GENERIC_GUIDANCE,
  isValidScenarioId,
  KIND_GUIDANCE,
  parseBundleFile,
  SCENARIO_GUIDANCE,
  serializeBundleFile,
  stageOrder,
  TYPED_STAGE_IDS,
  type CustomScenarioDef,
  type ParsedBundleFile,
  type StageBundle,
  type Tr,
} from "./bundleFile";

/**
 * Stage bundles — app-side IO and composition. The schema, builtin content,
 * and validation live in the PURE module `bundleFile.ts` (shared with the MCP
 * editing server, #155); this file adds the config-dir read, a short UI cache,
 * and the composed StageSet the components consume.
 */

export type {
  CoachRuleDef,
  CustomScenarioDef,
  CustomStageDef,
  ParsedBundleFile,
  SlotDef,
  StageBundle,
  StageBundleFile,
} from "./bundleFile";
export {
  BUILTIN_KIND_IDS,
  BUILTIN_SCENARIO_IDS,
  buildBuiltinBundles,
  isBundleLike,
  isValidScenarioId,
  KIND_GUIDANCE,
  parseBundleFile,
  stageOrder,
  TYPED_STAGE_IDS,
} from "./bundleFile";

const LS_KEY = "parley-stage-bundles";

/** v1-era helper kept for callers/tests that only need overrides. */
export function parseOverrides(raw: string): Partial<Record<SalesStage, StageBundle>> {
  return parseBundleFile(raw, (m, c) => log.warn(m, c)).overrides;
}

async function readRaw(): Promise<string> {
  return isTauri()
    ? await invoke<string>("read_stage_bundles")
    : (localStorage.getItem(LS_KEY) ?? "");
}

// Short TTL so per-row UI mounts (MiniStages on every thread) don't hammer the
// IPC, while MCP edits still land quickly; extraction passes fresh for the
// 30s live loop.
let cache: { at: number; value: ParsedBundleFile } | null = null;
const CACHE_TTL_MS = 10_000;

/** Read + parse the config-dir file (localStorage in browser dev). */
export async function readStageBundleFile(opts?: { fresh?: boolean }): Promise<ParsedBundleFile> {
  if (!opts?.fresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  try {
    const parsed = parseBundleFile(await readRaw(), (m, c) => log.warn(m, c));
    cache = { at: Date.now(), value: parsed };
    return parsed;
  } catch (e) {
    log.warn("stage-bundles: read failed — using builtins", { error: String(e) });
    return EMPTY_BUNDLE_FILE;
  }
}

/** Back-compat: overrides only. */
export async function readStageBundleOverrides(): Promise<
  Partial<Record<SalesStage, StageBundle>>
> {
  return (await readStageBundleFile()).overrides;
}

/** Persist the file (Settings stage editor) and drop the read cache so the
 *  UI sees the change immediately. */
export async function writeStageBundleFile(parsed: ParsedBundleFile): Promise<void> {
  const body = serializeBundleFile(parsed);
  if (isTauri()) await invoke("write_stage_bundles", { json: body });
  else localStorage.setItem(LS_KEY, body);
  cache = { at: Date.now(), value: parsed };
}

/** Merged view: an override replaces its stage whole (S9). */
export function mergeBundles(
  builtin: Record<SalesStage, StageBundle>,
  overrides: Partial<Record<SalesStage, StageBundle>>
): Record<SalesStage, StageBundle> {
  const out = { ...builtin };
  for (const [stage, o] of Object.entries(overrides)) if (o) out[stage] = o;
  return out;
}

/** Convenience: builtins (in the given language) + overrides, merged. */
export function stageBundles(
  t: Tr,
  overrides: Partial<Record<SalesStage, StageBundle>>
): Record<SalesStage, StageBundle> {
  return mergeBundles(buildBuiltinBundles(t), overrides);
}

/** The full stage universe the UI runs on (#155). */
export interface StageSet {
  /** Pipeline order: builtins with custom stages spliced in. */
  order: SalesStage[];
  /** Effective bundle per stage (builtin + custom, overrides applied). */
  bundles: Record<SalesStage, StageBundle>;
  /** Display name per stage (builtin via i18n, custom from the file). */
  names: Record<SalesStage, string>;
  /** Stages whose content came from the file (custom, or overridden builtin). */
  customized: Set<SalesStage>;
}

export function buildStageSet(t: Tr, parsed: ParsedBundleFile): StageSet {
  const bundles: Record<SalesStage, StageBundle> = { ...buildBuiltinBundles(t) };
  const names: Record<SalesStage, string> = {};
  const customized = new Set<SalesStage>();
  for (const s of SALES_STAGES) names[s] = t(`accounts.stage.${s}`);
  for (const c of parsed.customStages) {
    bundles[c.id] = c.bundle;
    names[c.id] = c.name;
    customized.add(c.id);
  }
  for (const [stage, o] of Object.entries(parsed.overrides)) {
    if (!o) continue;
    bundles[stage] = o;
    customized.add(stage);
  }
  return { order: stageOrder(parsed.customStages), bundles, names, customized };
}

// ── Scenarios(v3)────────────────────────────────────────────────────────────

/** Emoji for the builtin boardless kinds (their copy lives in i18n). */
const KIND_ICONS: Record<(typeof BUILTIN_KIND_IDS)[number], string> = {
  retro: "🔁",
  officehour: "🎓",
};

/**
 * One meeting scenario — the unit the board/extraction/pickers run on. Builtin
 * or custom, a scenario is exactly: an ordered list of stages, each with a
 * bundle. Sales has five stages; the other builtins have one; customs choose.
 *
 * Zero stages is legal and meaningful: that's a KIND (retro, office hour, 1:1)
 * — a name plus an analysis lens, with no live board. A scenario with stages is
 * the strictly larger thing: a kind that ALSO drives realtime extraction.
 */
export interface Scenario {
  id: string;
  name: string;
  /** Emoji for pickers/chips. */
  icon: string;
  builtin: boolean;
  /** False for a KIND: no stages, so no live board and no realtime extraction.
   *  Always `order.length > 0` — carried as a field so callers holding only a
   *  Scenario don't have to know that's what the emptiness means. */
  hasBoard: boolean;
  /** Extraction guidance ahead of the shared prompt (model input, English).
   *  For a boardless kind this is the ONLY thing it contributes. */
  guidance: string;
  /** Eval template auto-applied when this scenario is picked (if it exists). */
  evalTemplateId?: string;
  /** Stage ids in pipeline order (length 1 = no stage row in the UI, 0 = kind). */
  order: string[];
  names: Record<string, string>;
  bundles: Record<string, StageBundle>;
}

export interface ScenarioSet {
  /** Builtins first (sales, negotiation, partnership), then customs. */
  list: Scenario[];
  byId: Record<string, Scenario>;
}

/** The full scenario universe: builtins from code+i18n (overrides applied),
 *  customs from the file. THE lookup every scenario-aware surface uses. */
export function buildScenarioSet(t: Tr, parsed: ParsedBundleFile): ScenarioSet {
  const stageSet = buildStageSet(t, parsed);
  const typed = buildTypedBuiltinBundles(t);
  const negoStage = TYPED_STAGE_IDS.negotiation;
  const partnerStage = TYPED_STAGE_IDS.partnership;
  const sales: Scenario = {
    id: "sales",
    name: t("scenario.sales.name"),
    icon: "🤝",
    builtin: true,
    hasBoard: true,
    guidance: SCENARIO_GUIDANCE.sales,
    evalTemplateId: "tpl-sales",
    order: stageSet.order,
    names: stageSet.names,
    bundles: stageSet.bundles,
  };
  const negotiation: Scenario = {
    id: "negotiation",
    name: t("scenario.negotiation.name"),
    icon: "⚖️",
    builtin: true,
    hasBoard: true,
    guidance: SCENARIO_GUIDANCE.negotiation,
    evalTemplateId: "tpl-negotiation",
    order: [negoStage],
    names: { [negoStage]: t("scenario.negotiation.name") },
    bundles: { [negoStage]: parsed.overrides[negoStage] ?? typed.nego },
  };
  const partnership: Scenario = {
    id: "partnership",
    name: t("scenario.partnership.name"),
    icon: "🚀",
    builtin: true,
    hasBoard: true,
    guidance: SCENARIO_GUIDANCE.partnership,
    order: [partnerStage],
    names: { [partnerStage]: t("scenario.partnership.name") },
    bundles: { [partnerStage]: parsed.overrides[partnerStage] ?? typed.partner },
  };
  const kinds: Scenario[] = BUILTIN_KIND_IDS.map((id) => ({
    id,
    name: t(`kind.${id}.name`),
    icon: KIND_ICONS[id],
    builtin: true,
    hasBoard: false,
    guidance: KIND_GUIDANCE[id],
    order: [],
    names: {},
    bundles: {},
  }));
  const customs: Scenario[] = parsed.customScenarios.map((sc) => {
    const names: Record<string, string> = {};
    const bundles: Record<string, StageBundle> = {};
    for (const st of sc.stages) {
      names[st.id] = st.name;
      bundles[st.id] = parsed.overrides[st.id] ?? st.bundle;
    }
    return {
      id: sc.id,
      name: sc.name,
      icon: sc.icon ?? "🎯",
      builtin: false,
      hasBoard: sc.stages.length > 0,
      guidance: sc.guidance ?? GENERIC_GUIDANCE,
      ...(sc.evalTemplateId ? { evalTemplateId: sc.evalTemplateId } : {}),
      order: sc.stages.map((st) => st.id),
      names,
      bundles,
    };
  });
  // No stage filter: a zero-stage entry is a KIND, not a broken scenario, and
  // dropping it here is exactly what used to make custom kinds unrepresentable.
  const list = [sales, negotiation, partnership, ...kinds, ...customs];
  return { list, byId: Object.fromEntries(list.map((s) => [s.id, s])) };
}

/**
 * Create a boardless KIND and persist it to the bundle file. The write path for
 * "an id nobody has defined yet" — MCP sets a meeting type the app has never
 * seen, and instead of silently losing the pick (the old degrade-to-general
 * behavior) we materialize the kind so it survives on disk.
 *
 * Idempotent: an id that already exists (as a kind OR a full scenario) is left
 * exactly as it is, so repeat calls never clobber a user's authored board.
 */
export async function createBoardlessKind(input: {
  id: string;
  name: string;
  icon?: string;
  guidance?: string;
}): Promise<void> {
  const { id, name, icon, guidance } = input;
  if (!isValidScenarioId(id)) {
    throw new Error(
      `invalid scenario id "${id}" — use a lowercase slug (a-z, 0-9, -) that isn't a builtin ` +
        `(${[...BUILTIN_SCENARIO_IDS, ...BUILTIN_KIND_IDS].join(", ")}) or "general"`
    );
  }
  const parsed = await readStageBundleFile({ fresh: true });
  if (parsed.customScenarios.some((sc) => sc.id === id)) return;
  const kind: CustomScenarioDef = {
    id,
    name,
    ...(icon?.trim() ? { icon } : {}),
    ...(guidance?.trim() ? { guidance } : {}),
    stages: [],
  };
  await writeStageBundleFile({
    ...parsed,
    customScenarios: [...parsed.customScenarios, kind],
  });
  log.info("scenarios: boardless kind created", { id });
}

/**
 * Static-guide view (ThreadPage / seedTodos): untouched builtins keep their
 * i18n copy verbatim; custom or overridden stages derive from the bundle
 * (goal field, slot label：hint lines, exitCriteria).
 */
export function stageGuideView(
  t: Tr,
  set: StageSet,
  stage: SalesStage
): { goal: string; collect: string[]; exit: string[] } {
  const bundle = set.bundles[stage];
  if (!bundle) return { goal: "", collect: [], exit: [] };
  if ((SALES_STAGES as string[]).includes(stage) && !set.customized.has(stage)) {
    return {
      goal: t(`accounts.stageGuide.${stage}.goal`),
      collect: t(`accounts.stageGuide.${stage}.collect`)
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
      exit: [t(`accounts.stageGuide.${stage}.exit`)],
    };
  }
  return {
    goal: bundle.goal ?? "",
    collect: bundle.slots.map((s) => (s.label === s.hint ? s.label : `${s.label}：${s.hint}`)),
    exit: bundle.exitCriteria,
  };
}
