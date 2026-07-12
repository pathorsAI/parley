import { invoke, isTauri } from "@tauri-apps/api/core";
import { log } from "../log";
import { SALES_STAGES, type SalesStage } from "./types";
import {
  buildBuiltinBundles,
  EMPTY_BUNDLE_FILE,
  parseBundleFile,
  stageOrder,
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
  CustomStageDef,
  ParsedBundleFile,
  SlotDef,
  StageBundle,
  StageBundleFile,
} from "./bundleFile";
export { buildBuiltinBundles, isBundleLike, parseBundleFile, stageOrder } from "./bundleFile";

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
