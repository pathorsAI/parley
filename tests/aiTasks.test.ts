import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Parley Cloud's AI task registry (shared/ai-tasks/tasks.generated.json) against
// the app that produced it:
//
//  1. the committed file is exactly what scripts/gen-ai-tasks.ts writes now —
//     a prompt edited without `bun run gen:ai-tasks` fails here;
//  2. every hosted call site, for every param combination, sends to its task's
//     endpoint, names a variant that exists, and its REAL system message (as it
//     reaches the wire, through the real AI SDK) equals that variant filled
//     with the request's slots by the registry's own rules — so the server,
//     which ignores the client's system message, sends the same prompt;
//  3. a structured call's response_format matches the variant's.

vi.mock("../src/lib/cloud/client", () => ({
  cloudToken: () => "test-token",
  CLOUD_URL: "https://cloud.example.test",
}));
vi.mock("../src/lib/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));
vi.mock("../src/lib/usage/log", () => ({ recordLlmUsage: vi.fn(async () => {}) }));

import { useStore } from "../src/lib/store";
import {
  buildTaskRegistry,
  paramCombinations,
  serializeTaskRegistry,
  TASK_REGISTRY_PATH,
  type TaskDef,
  type TaskRegistry,
} from "../src/lib/ai/tasks/registry";
import { AI_TASK_IDS, type AiTaskId } from "../src/lib/ai/tasks/catalog";
import { fillTaskSystem, renderSlot, variantKey } from "../src/lib/ai/tasks/fill";
import { askAboutMeeting } from "../src/lib/ai/ask";
import { generatePostMeetingReport } from "../src/lib/ai/report";
import { checkTodos } from "../src/lib/ai/todos";
import { detectMeetingKind } from "../src/lib/ai/meetingKind";
import { analyzeTimeline } from "../src/lib/ai/timeline";
import { generateActionItems } from "../src/lib/ai/actionItems";
import { analyzeDelivery } from "../src/lib/ai/delivery";
import { generateFindingSolution } from "../src/lib/ai/findingSolution";
import { suggestFiling } from "../src/lib/ai/filing";
import { runConnectionTest } from "../src/lib/ai/connectionTest";
import { polishTranscriptOutcome } from "../src/lib/voiceTyping/polish";
import { draftBackground } from "../src/lib/onboarding/memoryImport";
import { findNameEdit, summarizeIntro } from "../src/lib/onboarding/micCheck";
import { createAgendaCursor } from "../src/lib/meeting/agendaDelta";
import type { AnalysisLens, AppLanguage, Settings, TranscriptSegment } from "../src/lib/types";

const ROOT = join(__dirname, "..");
const COMMITTED = readFileSync(join(ROOT, TASK_REGISTRY_PATH), "utf8");
const REGISTRY: TaskRegistry = JSON.parse(COMMITTED);

function taskDef(id: string, version: number): TaskDef {
  const def = REGISTRY.tasks.find((t) => t.id === id && t.version === version);
  if (!def) throw new Error(`no task ${id}@${version} in the registry`);
  return def;
}

// ── Wire stubs (same shapes as the AI SDK's openai-compatible provider reads) ──

const ANSWER = JSON.stringify({
  kind: "internal",
  moments: [],
  actions: [],
  done: [],
  replies: [],
  tone: "neutral",
  tone_evidence: "",
  filler_level: "ok",
  filler_examples: [],
  filler_note: "",
  pace: "comfortable",
  summary: "",
  title: "Pilot rollout",
  folders: [],
  name: "",
  company: "",
  role: "",
  background: [],
  terms: [],
  from: "",
  to: "",
});

function completion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "x",
      object: "chat.completion",
      created: 0,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function streamed(content: string): Response {
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return new Response(chunk({ role: "assistant", content }, null) + chunk({}, "stop") + "data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

type Wire = { url: string; body: Record<string, unknown> & { messages: { role: string; content: string }[] } };

function stubFetch(): Wire[] {
  const seen: Wire[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      seen.push({ url: String(input), body });
      return body.stream ? streamed(ANSWER) : completion(ANSWER);
    }),
  );
  return seen;
}

function hosted(language: AppLanguage, extra: Partial<Settings> = {}): Settings {
  const base = useStore.getState().settings;
  return {
    ...base,
    language,
    llmProviders: { realtime: "parley", deep: "parley" },
    userName: "Jack",
    userRole: "Founder",
    userCompany: "Pathors",
    voiceTypingPolishStyle: "tidy",
    ...extra,
  } as Settings;
}

const segments: TranscriptSegment[] = [
  { id: "a", source: "them", speaker: 1, text: "We agreed to ship on Friday.", isFinal: true, startMs: 0, endMs: 3000 },
  { id: "b", source: "me", speaker: 0, text: "Um, I think the price is fine.", isFinal: true, startMs: 4000, endMs: 7000 },
];
const finding = {
  id: "f1",
  atMs: 4000,
  severity: "warn" as const,
  source: "extra" as const,
  title: "Price accepted",
  detail: "ME accepted the price without a trade.",
  side: "me" as const,
};

const LANGS: AppLanguage[] = ["zh-TW", "en"];
const LENSES: AnalysisLens[] = ["decision", "opportunity", "adversarial"];

type Case = { name: string; task: AiTaskId; run: () => Promise<unknown> };

const POLISH_RAW = "um so we ship on friday, and then i think we test on monday";
const MANY_TERMS = Array.from({ length: 40 }, (_, i) => `Term${i}`);

const CASES: Case[] = [
  { name: "meeting kind", task: "meeting_kind", run: () => detectMeetingKind({ settings: hosted("en"), segments }) },
  ...LENSES.flatMap((lens) =>
    (["live", "replay"] as const).flatMap((mode) =>
      LANGS.map((lang) => ({
        name: `timeline ${lens} ${mode} ${lang}`,
        task: "timeline" as const,
        run: () => analyzeTimeline({ settings: hosted(lang), segments, evals: [], lens, mode }),
      })),
    ),
  ),
  ...LENSES.flatMap((lens) =>
    LANGS.flatMap((lang) => [
      {
        name: `action items ${lens} ${lang}`,
        task: "action_items" as const,
        run: () => generateActionItems({ settings: hosted(lang), segments, findings: [finding], lens }),
      },
      {
        name: `report ${lens} ${lang}`,
        task: "report" as const,
        run: () =>
          generatePostMeetingReport({ settings: hosted(lang), segments, evaluations: [], todos: [], lens, onDelta: () => {} }),
      },
    ]),
  ),
  ...(["live", "post"] as const).flatMap((mode) =>
    LANGS.map((lang) => ({
      name: `delivery ${mode} ${lang}`,
      task: "delivery" as const,
      run: () => analyzeDelivery({ settings: hosted(lang), segments, mode }),
    })),
  ),
  {
    name: "todos full",
    task: "todos",
    run: () => checkTodos({ settings: hosted("en"), segments, todos: [{ id: "t1", text: "Ship date", done: false }] }),
  },
  {
    name: "todos delta",
    task: "todos",
    run: () =>
      checkTodos({
        settings: hosted("en"),
        segments,
        todos: [{ id: "t1", text: "Ship date", done: false }],
        cursor: createAgendaCursor("m1"),
      }),
  },
  ...LANGS.flatMap((lang) => [
    {
      name: `finding solution ${lang}`,
      task: "finding_solution" as const,
      run: () => generateFindingSolution({ settings: hosted(lang), finding, segments, mode: "replay" }),
    },
    {
      name: `filing ${lang}`,
      task: "filing" as const,
      run: () => suggestFiling({ settings: hosted(lang), segments, folders: [{ id: "x", name: "Sales" }], currentTitle: "R1" }),
    },
    {
      name: `draft background ${lang}`,
      task: "draft_background" as const,
      run: () => draftBackground({ settings: hosted(lang), current: "Founder.", text: "## Notes\nBuilds Parley." }),
    },
    {
      name: `summarize intro ${lang}`,
      task: "summarize_intro" as const,
      run: () => summarizeIntro({ settings: hosted(lang), transcript: "I'm Jack from Pathors." }),
    },
  ]),
  { name: "find name edit", task: "find_name_edit", run: () => findNameEdit({ settings: hosted("zh-TW"), before: "我在東昇", after: "我在東森" }) },
  { name: "ask", task: "ask", run: () => askAboutMeeting({ settings: hosted("en"), segments, question: "When?", onDelta: () => {} }) },
  { name: "ping", task: "ping", run: () => runConnectionTest(hosted("en"), "realtime") },
  ...(["tidy", "concise"] as const).flatMap((style) => [
    {
      name: `polish ${style}, no user content`,
      task: "polish" as const,
      run: () => polishTranscriptOutcome({ raw: POLISH_RAW, settings: hosted("en", { voiceTypingPolishStyle: style, voiceTypingCustomInstructions: "" }) }),
    },
    {
      name: `polish ${style}, terms, speaker and instructions`,
      task: "polish" as const,
      run: () =>
        polishTranscriptOutcome({
          raw: POLISH_RAW,
          settings: hosted("zh-TW", { voiceTypingPolishStyle: style, voiceTypingCustomInstructions: "  Keep it formal. {{terms}}  " }),
          protectedTerms: ["Parley", " ", "Pathors", ...MANY_TERMS],
          speakerTerms: [" Jack ", "Pathors", "Jack"],
        }),
    },
    {
      name: `polish ${style}, over-long instructions`,
      task: "polish" as const,
      run: () =>
        polishTranscriptOutcome({
          raw: POLISH_RAW,
          settings: hosted("en", { voiceTypingPolishStyle: style, voiceTypingCustomInstructions: "x".repeat(1500) }),
        }),
    },
  ]),
];

afterEach(() => vi.unstubAllGlobals());

describe("tasks.generated.json", () => {
  let built: TaskRegistry;
  beforeAll(async () => {
    built = await buildTaskRegistry(REGISTRY);
  });

  it("is what `bun run gen:ai-tasks` writes now", () => {
    expect(serializeTaskRegistry(built) === COMMITTED, "stale: run `bun run gen:ai-tasks` and commit the result").toBe(true);
  });

  it("has every task at its current version, each param combination once", () => {
    for (const id of AI_TASK_IDS) {
      const def = REGISTRY.tasks.find((t) => t.id === id);
      expect(def, id).toBeDefined();
      const enums = Object.fromEntries(Object.entries(def!.params).map(([k, p]) => [k, p.enum]));
      expect(Object.keys(def!.variants).sort(), id).toEqual(paramCombinations(enums).map(variantKey).sort());
    }
  });

  it("leaves no placeholder a slot does not define", () => {
    for (const t of REGISTRY.tasks) {
      for (const [key, v] of Object.entries(t.variants)) {
        for (const [, name] of v.system.matchAll(/\{\{(\w+)\}\}/g)) {
          expect(t.slots[name], `${t.id} ${key} {{${name}}}`).toBeDefined();
        }
      }
    }
  });
});

describe("slot rendering", () => {
  it("bounds and joins a list, and drops it when empty", () => {
    const def = { type: "string[]" as const, maxItems: 2, maxItemChars: 3, join: "、", template: "<{{value}}>" };
    expect(renderSlot(def, [" ", "abcd", "x", "y"])).toBe("<abc、x>");
    expect(renderSlot(def, [" "])).toBe("");
    expect(renderSlot(def, undefined)).toBe("");
  });

  it("trims and caps text, and never expands a placeholder inside a value", () => {
    const def = { type: "string" as const, maxChars: 5, template: "[{{value}}]" };
    expect(renderSlot(def, "  {{a}}bcdef ")).toBe("[{{a}}]");
    expect(fillTaskSystem("S{{x}}", { x: def }, { x: "$& {{x}}" })).toBe("S[$& {{]");
  });

  it("refuses a placeholder with no slot definition", () => {
    expect(() => fillTaskSystem("{{nope}}", {}, {})).toThrow(/nope/);
  });
});

describe("every hosted call site matches its registry variant", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const wire = stubFetch();
    await c.run();
    expect(wire.length, "made no request").toBeGreaterThan(0);
    const first = wire[0];
    expect(first.url).toBe(`https://cloud.example.test/v1/ai/${c.task}/chat/completions`);
    const pt = first.body.parley_task as { version: number; params: Record<string, string>; slots: Record<string, string | string[]> };
    const def = taskDef(c.task, pt.version);
    for (const [k, v] of Object.entries(pt.params)) expect(def.params[k]?.enum, `param ${k}`).toContain(v);
    const variant = def.variants[variantKey(pt.params)];
    expect(variant, `variant ${variantKey(pt.params)}`).toBeDefined();
    for (const k of Object.keys(pt.slots)) expect(def.slots[k], `slot ${k}`).toBeDefined();

    const sent = first.body.messages.find((m) => m.role === "system")?.content ?? "";
    expect(sent).toBe(fillTaskSystem(variant.system, def.slots, pt.slots));

    const rf = first.body.response_format as { type: string; json_schema?: { schema: unknown } } | undefined;
    if (variant.responseFormat.type === "text") expect(rf).toBeUndefined();
    if (variant.responseFormat.type === "json_object") expect(rf).toEqual({ type: "json_object" });
    if (variant.responseFormat.type === "json_schema") {
      expect(rf?.type).toBe("json_schema");
      expect(rf?.json_schema?.schema).toEqual(variant.responseFormat.schema);
    }
    // Every request of the call — retries and format fallbacks — is the same task.
    for (const w of wire) {
      expect(w.url).toBe(first.url);
      expect(w.body.parley_task).toEqual(pt);
    }
  });

  it("covers every task", () => {
    expect(new Set(CASES.map((c) => c.task))).toEqual(new Set(AI_TASK_IDS));
  });
});
