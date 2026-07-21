#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  buildBuiltinBundles,
  buildTypedBuiltinBundles,
  isBundleLike,
  isValidCustomStageId,
  isValidScenarioId,
  parseBundleFile,
  serializeBundleFile,
  slotsMatchStage,
  stageOrder,
  TYPED_STAGE_IDS,
  type CustomScenarioDef,
  type CustomStageDef,
  type ParsedBundleFile,
  type StageBundle,
} from "../src/lib/accounts/bundleFile";
import { SALES_STAGES } from "../src/lib/accounts/types";
import { translate, type TranslationKey } from "../src/i18n/messages";
import type { AppLanguage } from "../src/lib/types";

/**
 * Stage-bundles MCP server (#155, scenario system): lets an external Claude
 * edit Parley's meeting know-how — stage bundles (slots/hints/exit criteria),
 * CUSTOM sales stages, and whole CUSTOM SCENARIOS (v3: e.g. an interview or
 * fundraise-pitch board) — by editing the same config-dir `stage-bundles.json`
 * the app reads. The app doesn't need to be running; a live meeting picks
 * changes up within one 30s extraction cycle.
 *
 * Register (Claude Code):
 *   claude mcp add parley-bundles -- bun run /path/to/parley/mcp/stage-bundles-server.ts
 *
 * Env:
 *   PARLEY_CONFIG_DIR  override the config dir (default: macOS app config dir)
 *   PARLEY_LANG        language for rendering builtin copy (zh-TW | en)
 */

const CONFIG_DIR =
  process.env.PARLEY_CONFIG_DIR ??
  join(homedir(), "Library", "Application Support", "com.pathors.parley");
const FILE = join(CONFIG_DIR, "stage-bundles.json");
const LANG: AppLanguage = process.env.PARLEY_LANG === "en" ? "en" : "zh-TW";
const t = (key: string) => translate(LANG, key as TranslationKey);

function readFile(): { parsed: ParsedBundleFile; warnings: string[] } {
  const warnings: string[] = [];
  const raw = existsSync(FILE) ? readFileSync(FILE, "utf8") : "";
  const parsed = parseBundleFile(raw, (m, c) => warnings.push(`${m} ${JSON.stringify(c ?? {})}`));
  return { parsed, warnings };
}

/** Atomic write: the app may read the file at any moment (30s live loop). */
function writeFile(parsed: ParsedBundleFile): void {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, serializeBundleFile(parsed), "utf8");
  renameSync(tmp, FILE);
}

function ok(data: unknown, warnings: string[] = []) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(warnings.length ? { data, warnings } : { data }, null, 2),
      },
    ],
  };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: `ERROR: ${message}` }], isError: true };
}

/** Effective bundle for a stage id (builtin + override, custom sales stage,
 *  typed builtin, or a custom scenario's stage). */
function effectiveBundle(parsed: ParsedBundleFile, stage: string): StageBundle | null {
  const override = parsed.overrides[stage];
  if (override) return override;
  const custom = parsed.customStages.find((c) => c.id === stage);
  if (custom) return custom.bundle;
  for (const sc of parsed.customScenarios) {
    const st = sc.stages.find((x) => x.id === stage);
    if (st) return st.bundle;
  }
  if (stage === TYPED_STAGE_IDS.negotiation) return buildTypedBuiltinBundles(t).nego;
  if (stage === TYPED_STAGE_IDS.partnership) return buildTypedBuiltinBundles(t).partner;
  return (SALES_STAGES as string[]).includes(stage) ? buildBuiltinBundles(t)[stage] : null;
}

/** Every stage id the file currently knows (override targets). */
function knownStageIds(parsed: ParsedBundleFile): Set<string> {
  return new Set([
    ...SALES_STAGES,
    TYPED_STAGE_IDS.negotiation,
    TYPED_STAGE_IDS.partnership,
    ...parsed.customStages.map((c) => c.id),
    ...parsed.customScenarios.flatMap((sc) => sc.stages.map((x) => x.id)),
  ]);
}

/** Validate a caller-supplied bundle for a stage; returns an error string or null. */
function bundleError(stage: string, bundle: unknown): string | null {
  if (!isBundleLike(bundle))
    return "bundle shape invalid: needs boardTitle, slots[{id,label,hint,query}], exitCriteria[], coachRules[]";
  if (!slotsMatchStage(bundle, stage))
    return `every slot id must start with "${stage}." (it namespaces slot tags and the backfill sentinel)`;
  return null;
}

const server = new McpServer({ name: "parley-stage-bundles", version: "1.0.0" });

server.tool(
  "list_stages",
  "List the sales pipeline: builtin + custom stages in order, with names, sources, and whether an override exists.",
  {},
  async () => {
    const { parsed, warnings } = readFile();
    const customIds = new Set(parsed.customStages.map((c) => c.id));
    const data = stageOrder(parsed.customStages).map((id) => ({
      id,
      name: customIds.has(id)
        ? parsed.customStages.find((c) => c.id === id)!.name
        : t(`accounts.stage.${id}`),
      source: customIds.has(id) ? "custom" : "builtin",
      overridden: !!parsed.overrides[id],
      slotCount: effectiveBundle(parsed, id)?.slots.length ?? 0,
    }));
    return ok(data, warnings);
  }
);

server.tool(
  "get_stage",
  "Get one stage's EFFECTIVE bundle (builtin content with override applied, or the custom stage's bundle). Use this to see the exact schema before editing.",
  { stage: z.string().describe("stage id, e.g. discovery or a custom id") },
  async ({ stage }) => {
    const { parsed, warnings } = readFile();
    const bundle = effectiveBundle(parsed, stage);
    if (!bundle) return fail(`unknown stage "${stage}" — list_stages shows valid ids`);
    return ok(bundle, warnings);
  }
);

server.tool(
  "upsert_stage_override",
  "Replace a stage's bundle WHOLE (S9 — no per-slot merge). Works on builtin and custom stages. Slot ids must be prefixed with `<stage>.`.",
  {
    stage: z.string().describe("stage id to override"),
    bundle: z
      .record(z.string(), z.unknown())
      .describe("full StageBundle JSON (get_stage shows the shape)"),
  },
  async ({ stage, bundle }) => {
    const { parsed } = readFile();
    if (!knownStageIds(parsed).has(stage)) return fail(`unknown stage "${stage}"`);
    const err = bundleError(stage, bundle);
    if (err) return fail(err);
    parsed.overrides[stage] = { ...(bundle as unknown as StageBundle), stage };
    writeFile(parsed);
    return ok({ written: FILE, stage });
  }
);

server.tool(
  "remove_stage_override",
  "Remove a stage's override — builtin stages revert to shipped content.",
  { stage: z.string() },
  async ({ stage }) => {
    const { parsed } = readFile();
    if (!parsed.overrides[stage]) return fail(`no override for "${stage}"`);
    delete parsed.overrides[stage];
    writeFile(parsed);
    return ok({ written: FILE, stage });
  }
);

server.tool(
  "add_custom_stage",
  "Add a NEW pipeline stage (e.g. a dedicated cold-call stage). id: lowercase slug, no dots, not a builtin. Slot ids must be `<id>.<slot>`. insertAfter positions it in the pipeline (default: appended at the end).",
  {
    id: z.string().describe("slug id, e.g. coldcall"),
    name: z.string().describe("display name shown on steppers, e.g. 陌生開發"),
    insertAfter: z.string().optional().describe("stage id to insert after"),
    bundle: z.record(z.string(), z.unknown()).describe("full StageBundle JSON"),
  },
  async ({ id, name, insertAfter, bundle }) => {
    const { parsed } = readFile();
    if (!isValidCustomStageId(id))
      return fail(`invalid id "${id}": lowercase slug (a-z0-9-), no dots, not a builtin stage`);
    if (parsed.customStages.some((c) => c.id === id))
      return fail(`custom stage "${id}" already exists — use update_custom_stage`);
    if (!name.trim()) return fail("name must be non-empty");
    const err = bundleError(id, bundle);
    if (err) return fail(err);
    const def: CustomStageDef = {
      id,
      name,
      ...(insertAfter ? { insertAfter } : {}),
      bundle: { ...(bundle as unknown as StageBundle), stage: id, name },
    };
    parsed.customStages.push(def);
    writeFile(parsed);
    return ok({ written: FILE, id, order: stageOrder(parsed.customStages) });
  }
);

server.tool(
  "update_custom_stage",
  "Update a custom stage's name, position, and/or bundle.",
  {
    id: z.string(),
    name: z.string().optional(),
    insertAfter: z.string().optional(),
    bundle: z.record(z.string(), z.unknown()).optional(),
  },
  async ({ id, name, insertAfter, bundle }) => {
    const { parsed } = readFile();
    const def = parsed.customStages.find((c) => c.id === id);
    if (!def) return fail(`no custom stage "${id}"`);
    if (bundle !== undefined) {
      const err = bundleError(id, bundle);
      if (err) return fail(err);
      def.bundle = { ...(bundle as unknown as StageBundle), stage: id };
    }
    if (name !== undefined) {
      if (!name.trim()) return fail("name must be non-empty");
      def.name = name;
    }
    if (insertAfter !== undefined) def.insertAfter = insertAfter || undefined;
    def.bundle = { ...def.bundle, name: def.name };
    writeFile(parsed);
    return ok({ written: FILE, id, order: stageOrder(parsed.customStages) });
  }
);

server.tool(
  "remove_custom_stage",
  "Remove a custom stage (its override, if any, goes too). Threads still on it fall back to the pipeline start in the live board.",
  { id: z.string() },
  async ({ id }) => {
    const { parsed } = readFile();
    if (!parsed.customStages.some((c) => c.id === id)) return fail(`no custom stage "${id}"`);
    parsed.customStages = parsed.customStages.filter((c) => c.id !== id);
    delete parsed.overrides[id];
    writeFile(parsed);
    return ok({ written: FILE, id });
  }
);

// ── Scenarios (v3) ───────────────────────────────────────────────────────────

server.tool(
  "list_scenarios",
  "List all meeting scenarios: builtin (sales / negotiation / partnership) + custom, with their stage ids in order.",
  {},
  async () => {
    const { parsed, warnings } = readFile();
    const builtins = [
      { id: "sales", source: "builtin", stages: stageOrder(parsed.customStages) },
      { id: "negotiation", source: "builtin", stages: [TYPED_STAGE_IDS.negotiation] },
      { id: "partnership", source: "builtin", stages: [TYPED_STAGE_IDS.partnership] },
    ];
    const customs = parsed.customScenarios.map((sc) => ({
      id: sc.id,
      name: sc.name,
      icon: sc.icon,
      source: "custom",
      stages: sc.stages.map((x) => x.id),
      evalTemplateId: sc.evalTemplateId,
    }));
    return ok([...builtins, ...customs], warnings);
  }
);

server.tool(
  "upsert_scenario",
  "Create or replace a CUSTOM meeting scenario (e.g. interview, fundraise pitch). id: lowercase slug, no dots, not a builtin. Each stage's slot ids must be `<stageId>.<slot>` and stage ids must be globally unique slugs. guidance: English extraction framing for the model. evalTemplateId: optional coach template auto-applied when picked.",
  {
    id: z.string().describe("slug id, e.g. interview"),
    name: z.string().describe("display name, e.g. 面試"),
    icon: z.string().optional().describe("emoji, default 🎯"),
    guidance: z.string().optional().describe("English extraction guidance line"),
    evalTemplateId: z.string().optional(),
    stages: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          bundle: z.record(z.string(), z.unknown()),
        })
      )
      .min(1)
      .describe("stages in pipeline order (one stage = no stage row in the UI)"),
  },
  async ({ id, name, icon, guidance, evalTemplateId, stages }) => {
    const { parsed } = readFile();
    if (!isValidScenarioId(id))
      return fail(`invalid scenario id "${id}": lowercase slug, not a builtin, not "general"`);
    if (!name.trim()) return fail("name must be non-empty");
    const otherStageIds = new Set(
      [...knownStageIds(parsed)].filter(
        (sid) =>
          !parsed.customScenarios.find((sc) => sc.id === id)?.stages.some((x) => x.id === sid)
      )
    );
    const defs: CustomStageDef[] = [];
    for (const st of stages) {
      if (!isValidCustomStageId(st.id)) return fail(`invalid stage id "${st.id}"`);
      if (otherStageIds.has(st.id)) return fail(`stage id "${st.id}" already exists elsewhere`);
      const err = bundleError(st.id, st.bundle);
      if (err) return fail(`stage "${st.id}": ${err}`);
      defs.push({
        id: st.id,
        name: st.name,
        bundle: { ...(st.bundle as unknown as StageBundle), stage: st.id, name: st.name },
      });
    }
    const def: CustomScenarioDef = {
      id,
      name,
      ...(icon ? { icon } : {}),
      ...(guidance ? { guidance } : {}),
      ...(evalTemplateId ? { evalTemplateId } : {}),
      stages: defs,
    };
    parsed.customScenarios = [...parsed.customScenarios.filter((sc) => sc.id !== id), def];
    writeFile(parsed);
    return ok({ written: FILE, id, stages: defs.map((x) => x.id) });
  }
);

server.tool(
  "remove_scenario",
  "Remove a custom scenario (its stages' overrides go too). Recordings that used it fall back to 'general' in the live picker.",
  { id: z.string() },
  async ({ id }) => {
    const { parsed } = readFile();
    const sc = parsed.customScenarios.find((x) => x.id === id);
    if (!sc) return fail(`no custom scenario "${id}"`);
    for (const st of sc.stages) delete parsed.overrides[st.id];
    parsed.customScenarios = parsed.customScenarios.filter((x) => x.id !== id);
    writeFile(parsed);
    return ok({ written: FILE, id });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`parley-stage-bundles MCP server up — file: ${FILE} (lang ${LANG})`);
