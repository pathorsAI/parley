import { zodSchema } from "ai";
import type { z } from "zod";
import type { AnalysisLens, AppLanguage } from "../../types";
import { AI_TASK_IDS, AI_TASK_META, type AiTaskId, type AiTaskLane } from "./catalog";
import { variantKey, type SlotDef } from "./fill";
import { meetingKindSchema, meetingKindSystem } from "../meetingKind";
import { timelineSchema, timelineSystem, type TimelineMode } from "../timeline";
import { actionItemsSchema, actionItemsSystem } from "../actionItems";
import { reportSystem } from "../report";
import { deliverySchema, deliverySystem, type DeliveryMode } from "../delivery";
import { todosSchema, todosSystem, type TodosScope } from "../todos";
import { findingSolutionSchema, findingSolutionSystem } from "../findingSolution";
import { filingSchema, filingSystemPrompt } from "../filing";
import { ASK_SYSTEM } from "../ask";
import {
  CUSTOM_INSTRUCTIONS_LINE,
  DICTIONARY_TERMS_LINE,
  MAX_CUSTOM_INSTRUCTIONS_CHARS,
  MAX_PROTECTED_TERMS,
  SPEAKER_TERMS_LINE,
  polishBasePrompt,
} from "../../voiceTyping/polish";
import { backgroundDraftSchema, draftBackgroundSystem } from "../../onboarding/memoryImport";
import { findNameEditSystem, introSchema, nameEditSchema, summarizeIntroSystem } from "../../onboarding/micCheck";

// The prompt half of Parley Cloud's task registry, built from the very
// functions the call sites compose their system prompts with — nothing here
// restates a prompt. scripts/gen-ai-tasks.ts writes it to
// shared/ai-tasks/tasks.generated.json; tests/aiTasks.test.ts fails when that
// file is stale, and checks every call site's real prompt against it.

export type ResponseFormat =
  | { type: "text" }
  /** Valid JSON, shape not enforced upstream. `schema` is what the client
   *  validates against, for the server's own checks; it is not sent upstream. */
  | { type: "json_object"; schema: unknown }
  /** Enforced by the upstream (send as OpenAI `json_schema`, strict, name "response"). */
  | { type: "json_schema"; schema: unknown };

export interface TaskVariant {
  /** The complete system prompt; `{{slot}}` placeholders are filled per `slots`. */
  system: string;
  responseFormat: ResponseFormat;
  /** Overrides the task's lane for this variant only. */
  lane?: AiTaskLane;
}

export interface TaskParamDef {
  enum: string[];
}

export interface TaskDef {
  id: AiTaskId;
  version: number;
  feature: string;
  lane: AiTaskLane;
  maxInputChars: number;
  maxOutputTokens: number;
  temperature: number | null;
  dailyCallsPerUser: number;
  params: Record<string, TaskParamDef>;
  slots: Record<string, SlotDef>;
  variants: Record<string, TaskVariant>;
  /** Set on a kept old version the server should answer 410 `task_version_retired`. */
  retired?: boolean;
}

export interface TaskRegistry {
  $comment: string;
  formatVersion: 1;
  variantKey: string;
  slotRendering: string;
  tasks: TaskDef[];
}

const LANGUAGES: AppLanguage[] = ["zh-TW", "en"];
const LENSES: AnalysisLens[] = ["decision", "opportunity", "adversarial"];

/** How a task's variants are produced: its params and one builder per combination. */
interface TaskSpec {
  params: Record<string, string[]>;
  slots?: Record<string, SlotDef>;
  variant: (p: Record<string, string>) => Promise<TaskVariant> | TaskVariant;
}

async function jsonSchemaOf(schema: z.ZodType): Promise<unknown> {
  return await zodSchema(schema).jsonSchema;
}

/** Streamed calls run in json_object mode on every openai-compatible provider (generate.ts). */
async function jsonObject(schema: z.ZodType): Promise<ResponseFormat> {
  return { type: "json_object", schema: await jsonSchemaOf(schema) };
}

/** One-shot structured calls send the schema as strict json_schema to the hosted provider. */
async function jsonSchema(schema: z.ZodType): Promise<ResponseFormat> {
  return { type: "json_schema", schema: await jsonSchemaOf(schema) };
}

const TEXT: ResponseFormat = { type: "text" };

const POLISH_SLOTS: Record<string, SlotDef> = {
  terms: {
    type: "string[]",
    maxItems: MAX_PROTECTED_TERMS,
    maxItemChars: 60,
    join: "、",
    template: `\n${DICTIONARY_TERMS_LINE}{{value}}`,
  },
  speakerTerms: {
    type: "string[]",
    maxItems: 10,
    maxItemChars: 60,
    join: "、",
    template: `\n${SPEAKER_TERMS_LINE}{{value}}`,
  },
  customInstructions: {
    type: "string",
    maxChars: MAX_CUSTOM_INSTRUCTIONS_CHARS,
    template: `\n\n${CUSTOM_INSTRUCTIONS_LINE}{{value}}`,
  },
};

const SPECS: Record<AiTaskId, TaskSpec> = {
  meeting_kind: {
    params: {},
    variant: async () => ({ system: meetingKindSystem(), responseFormat: await jsonObject(meetingKindSchema) }),
  },
  timeline: {
    params: { lens: LENSES, mode: ["live", "replay"], language: LANGUAGES },
    variant: async (p) => ({
      system: timelineSystem(p.lens as AnalysisLens, p.mode as TimelineMode, p.language as AppLanguage),
      responseFormat: await jsonObject(timelineSchema(p.lens as AnalysisLens)),
      // Live passes are latency-sensitive (the realtime lane); a replay buys quality.
      ...(p.mode === "live" ? { lane: "fast" as const } : {}),
    }),
  },
  action_items: {
    params: { lens: LENSES, language: LANGUAGES },
    variant: async (p) => ({
      system: actionItemsSystem(p.lens as AnalysisLens, p.language as AppLanguage),
      responseFormat: await jsonObject(actionItemsSchema),
    }),
  },
  report: {
    params: { lens: LENSES, language: LANGUAGES },
    variant: (p) => ({ system: reportSystem(p.lens as AnalysisLens, p.language as AppLanguage), responseFormat: TEXT }),
  },
  delivery: {
    params: { mode: ["live", "post"], language: LANGUAGES },
    variant: async (p) => ({
      system: deliverySystem(p.mode as DeliveryMode, p.language as AppLanguage),
      responseFormat: await jsonSchema(deliverySchema),
    }),
  },
  todos: {
    params: { scope: ["full", "delta"] },
    variant: async (p) => ({ system: todosSystem(p.scope as TodosScope), responseFormat: await jsonSchema(todosSchema) }),
  },
  finding_solution: {
    params: { language: LANGUAGES },
    variant: async (p) => ({
      system: findingSolutionSystem(p.language as AppLanguage),
      responseFormat: await jsonSchema(findingSolutionSchema),
    }),
  },
  filing: {
    params: { language: LANGUAGES },
    variant: async (p) => ({
      system: filingSystemPrompt(p.language as AppLanguage),
      responseFormat: await jsonObject(filingSchema),
    }),
  },
  ask: { params: {}, variant: () => ({ system: ASK_SYSTEM, responseFormat: TEXT }) },
  // The connection test sends no system prompt; the server answers it without a model call.
  ping: { params: {}, variant: () => ({ system: "", responseFormat: TEXT }) },
  polish: {
    params: { style: ["tidy", "concise"] },
    slots: POLISH_SLOTS,
    variant: (p) => ({
      system: `${polishBasePrompt(p.style as "tidy" | "concise")}{{terms}}{{speakerTerms}}{{customInstructions}}`,
      responseFormat: TEXT,
      ...(p.style === "concise" ? { lane: "concise" as const } : {}),
    }),
  },
  draft_background: {
    params: { language: LANGUAGES },
    variant: async (p) => ({
      system: draftBackgroundSystem(p.language as AppLanguage),
      responseFormat: await jsonSchema(backgroundDraftSchema),
    }),
  },
  summarize_intro: {
    params: { language: LANGUAGES },
    variant: async (p) => ({
      system: summarizeIntroSystem(p.language as AppLanguage),
      responseFormat: await jsonSchema(introSchema),
    }),
  },
  find_name_edit: {
    params: {},
    variant: async () => ({ system: findNameEditSystem(), responseFormat: await jsonSchema(nameEditSchema) }),
  },
};

/** Every combination of the params' values, each as a params object. */
export function paramCombinations(params: Record<string, string[]>): Record<string, string>[] {
  return Object.entries(params).reduce<Record<string, string>[]>(
    (combos, [name, values]) => combos.flatMap((c) => values.map((v) => ({ ...c, [name]: v }))),
    [{}],
  );
}

async function buildTask(id: AiTaskId): Promise<TaskDef> {
  const spec = SPECS[id];
  const variants: Record<string, TaskVariant> = {};
  for (const combo of paramCombinations(spec.params)) {
    variants[variantKey(combo)] = await spec.variant(combo);
  }
  const params = Object.fromEntries(Object.entries(spec.params).map(([k, values]) => [k, { enum: values }]));
  return { id, ...AI_TASK_META[id], params, slots: spec.slots ?? {}, variants };
}

/**
 * The whole registry. `previous` is the registry as last generated: entries
 * for an older version of a task (kept for clients still on it) are carried
 * forward verbatim, after the current ones. Delete one by hand when its last
 * client is gone, or mark it `retired`.
 */
export async function buildTaskRegistry(previous?: TaskRegistry | null): Promise<TaskRegistry> {
  const current: TaskDef[] = [];
  for (const id of AI_TASK_IDS) current.push(await buildTask(id));
  const kept = (previous?.tasks ?? []).filter((t) => {
    const now = AI_TASK_META[t.id];
    return now !== undefined && t.version < now.version;
  });
  return {
    $comment:
      "Generated by scripts/gen-ai-tasks.ts from the desktop's own prompt builders. Do not edit; run `bun run gen:ai-tasks`.",
    formatVersion: 1,
    variantKey:
      "A variant's key is its params as `name=value` pairs sorted by name and joined with commas; \"\" for a task without params.",
    slotRendering:
      "Each {{name}} in a variant's system is replaced, in one pass, by that slot rendered from parley_task.slots[name]. " +
      "string: trim, then cut to maxChars UTF-16 code units. string[]: drop non-strings and items that are blank after trimming, " +
      "keep the first maxItems, cut each to maxItemChars UTF-16 code units (items are otherwise not trimmed), join with `join`. " +
      "An empty result renders as \"\"; anything else renders as `template` with {{value}} replaced by it (verbatim, not re-expanded). " +
      "A missing slot is empty. Reference implementation: src/lib/ai/tasks/fill.ts.",
    tasks: [...current, ...kept],
  };
}

/** The registry exactly as it is written to disk. */
export function serializeTaskRegistry(registry: TaskRegistry): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

/** Where the generated registry lives, relative to the repository root. */
export const TASK_REGISTRY_PATH = "shared/ai-tasks/tasks.generated.json";
