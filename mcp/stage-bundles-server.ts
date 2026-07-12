#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  buildBuiltinBundles,
  isBundleLike,
  isValidCustomStageId,
  parseBundleFile,
  slotsMatchStage,
  stageOrder,
  type CustomStageDef,
  type ParsedBundleFile,
  type StageBundle,
} from "../src/lib/accounts/bundleFile";
import { SALES_STAGES } from "../src/lib/accounts/types";
import { translate, type TranslationKey } from "../src/i18n/messages";
import type { AppLanguage } from "../src/lib/types";

/**
 * Stage-bundles MCP server (#155): lets an external Claude edit Parley's sales
 * domain know-how — stage bundles (slots/hints/exit criteria) and CUSTOM
 * pipeline stages — by editing the same config-dir `stage-bundles.json` the
 * app reads. The app doesn't need to be running; a live meeting picks changes
 * up within one 30s extraction cycle.
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
  const body = JSON.stringify(
    { version: 2, stages: parsed.customStages, overrides: parsed.overrides },
    null,
    2
  );
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, body, "utf8");
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

/** Effective bundle for a stage id (builtin + override, or custom). */
function effectiveBundle(parsed: ParsedBundleFile, stage: string): StageBundle | null {
  const override = parsed.overrides[stage];
  if (override) return override;
  const custom = parsed.customStages.find((c) => c.id === stage);
  if (custom) return custom.bundle;
  return (SALES_STAGES as string[]).includes(stage) ? buildBuiltinBundles(t)[stage] : null;
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
    const known = new Set([...SALES_STAGES, ...parsed.customStages.map((c) => c.id)]);
    if (!known.has(stage)) return fail(`unknown stage "${stage}"`);
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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`parley-stage-bundles MCP server up — file: ${FILE} (lang ${LANG})`);
