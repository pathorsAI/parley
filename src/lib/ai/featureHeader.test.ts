import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LlmProvider, Settings } from "../types";
import { seg } from "../test/fixtures";

// End to end through the REAL `ai` + `@ai-sdk/openai-compatible` + provider.ts,
// with only the network, the log file and the usage log faked: what reaches the
// wire is what Parley Cloud attributes credit usage by.
vi.mock("../cloud/client", () => ({
  cloudToken: () => "test-token",
  CLOUD_URL: "https://cloud.example.test",
}));
vi.mock("../log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock("../usage/log", () => ({ recordLlmUsage: vi.fn(async () => {}) }));

import { askAboutMeeting } from "./ask";
import { generatePostMeetingReport } from "./report";
import { checkTodos } from "./todos";
import { generateObjectResilient, streamObjectResilient } from "./generate";
import { createAgendaCursor, cursorForMeeting } from "../meeting/agendaDelta";
import { aiTask } from "./tasks/catalog";

function settingsFor(provider: LlmProvider, extra: Record<string, string> = {}): Settings {
  return {
    llmProviders: { realtime: provider, deep: provider },
    models: { [provider]: { realtime: "m-fast", deep: "m-smart" } },
    reasoningEffort: { realtime: "low", deep: "medium" },
    parleyApiKey: "",
    userName: "",
    userRole: "",
    userCompany: "",
    ...extra,
  } as unknown as Settings;
}
const hosted = settingsFor("parley");
const byok = settingsFor("groq", { groqApiKey: "gsk_mine" });

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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
    `data: ${JSON.stringify({
      id: "x",
      object: "chat.completion.chunk",
      created: 0,
      model: "m",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  const body = chunk({ role: "assistant", content }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Answers every chat request with `content`, streamed when the request asks for it. */
function stubFetch(content: string, first?: () => Response) {
  let calls = 0;
  const spy = vi.fn<FetchImpl>(async (_input, init) => {
    calls += 1;
    if (calls === 1 && first) return first();
    return JSON.parse(String(init?.body)).stream ? streamed(content) : completion(content);
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** The `X-Parley-Feature` of every request the stub saw, in order. */
const features = (spy: ReturnType<typeof stubFetch>) =>
  spy.mock.calls.map(([, init]) => new Headers(init?.headers).get("x-parley-feature"));

const bodies = (spy: ReturnType<typeof stubFetch>) =>
  spy.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));

/** Groq's strict json_schema refusal: a 400 the SDK does not retry. */
const refused = () =>
  new Response(JSON.stringify({ error: { message: "json_validate_failed", type: "invalid_request_error" } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });

const segments = [seg({ text: "We agreed to ship on Friday." })];

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

const urls = (spy: ReturnType<typeof stubFetch>) => spy.mock.calls.map(([input]) => String(input));
const clients = (spy: ReturnType<typeof stubFetch>) =>
  spy.mock.calls.map(([, init]) => new Headers(init?.headers).get("x-parley-client"));

describe("X-Parley-Feature on Parley Cloud", () => {
  it("sends Ask to the ask task, tagged ask", async () => {
    const spy = stubFetch("Friday.");
    await askAboutMeeting({ settings: hosted, segments, question: "When?", onDelta: () => {} });
    expect(urls(spy)).toEqual(["https://cloud.example.test/v1/ai/ask/chat/completions"]);
    expect(bodies(spy)[0].parley_task).toEqual({ version: 1, params: {}, slots: {} });
    expect(features(spy)).toEqual(["ask"]);
    expect(clients(spy)[0]).toMatch(/^(macos|windows|linux)\/\d+\.\d+\.\d+/);
  });

  it("tags the post-meeting report as report", async () => {
    const spy = stubFetch("## Notes\nShip Friday.");
    await generatePostMeetingReport({
      settings: hosted,
      segments,
      evaluations: [],
      todos: [],
      onDelta: () => {},
    });
    expect(urls(spy)).toEqual(["https://cloud.example.test/v1/ai/report/chat/completions"]);
    expect(bodies(spy)[0].parley_task.params).toEqual({ lens: "decision", language: "en" });
    expect(features(spy)).toEqual(["report"]);
  });

  it("tags live meeting analysis as meeting", async () => {
    const spy = stubFetch('{"done":[{"id":"t1","at":"0:05"}]}');
    const done = await checkTodos({
      settings: hosted,
      segments,
      todos: [{ id: "t1", text: "Agree a ship date", done: false }],
    });
    expect(done).toEqual([{ id: "t1", atMs: 5_000 }]);
    expect(urls(spy)).toEqual(["https://cloud.example.test/v1/ai/todos/chat/completions"]);
    expect(bodies(spy)[0].parley_task.params).toEqual({ scope: "full" });
    expect(features(spy)).toEqual(["meeting"]);
  });

  /** Groq's strict json_schema 400 sends the call round again in json_object
   *  mode; the retry is the same task. */
  it("keeps the task and the tag on the json_object retry", async () => {
    const spy = stubFetch('{"a":"ok"}', refused);
    const res = await generateObjectResilient({
      settings: hosted,
      workload: "realtime",
      task: aiTask("find_name_edit"),
      schema: z.object({ a: z.string() }),
      system: "Reply in json.",
      prompt: "p",
    });
    expect(res.object).toEqual({ a: "ok" });
    expect(bodies(spy).map((b) => b.response_format?.type)).toEqual(["json_schema", "json_object"]);
    expect(urls(spy)).toEqual(Array(2).fill("https://cloud.example.test/v1/ai/find_name_edit/chat/completions"));
    expect(bodies(spy).map((b) => b.parley_task)).toEqual(Array(2).fill({ version: 1, params: {}, slots: {} }));
    expect(features(spy)).toEqual(["meeting", "meeting"]);
  });

  it("keeps the task and the tag on a streamed call's non-streamed fallback", async () => {
    const spy = stubFetch('{"a":"ok"}', refused);
    const res = await streamObjectResilient({
      settings: hosted,
      workload: "deep",
      task: aiTask("timeline", { lens: "decision", mode: "replay", language: "en" }),
      schema: z.object({ a: z.string() }),
      system: "Reply in json.",
      prompt: "p",
    });
    expect(res.object).toEqual({ a: "ok" });
    expect(bodies(spy).map((b) => b.stream ?? false)).toEqual([true, false]);
    expect(urls(spy)).toEqual(Array(2).fill("https://cloud.example.test/v1/ai/timeline/chat/completions"));
    expect(bodies(spy).map((b) => b.parley_task.params.mode)).toEqual(["replay", "replay"]);
    expect(features(spy)).toEqual(["meeting", "meeting"]);
  });

  it("sends the task's slots with it", async () => {
    const spy = stubFetch('{"a":"ok"}');
    await generateObjectResilient({
      settings: hosted,
      workload: "realtime",
      task: aiTask("polish", { style: "concise" }, { terms: ["Parley"], customInstructions: "Formal." }),
      schema: z.object({ a: z.string() }),
      system: "Reply in json.",
      prompt: "p",
    });
    expect(bodies(spy)[0].parley_task).toEqual({
      version: 1,
      params: { style: "concise" },
      slots: { terms: ["Parley"], customInstructions: "Formal." },
    });
    expect(features(spy)).toEqual(["voice_typing"]);
  });
});

/** A BYOK endpoint's CORS allow-list does not carry the header, and the user's
 *  own key owes Parley no attribution. */
describe("X-Parley-Feature on a BYOK provider", () => {
  it("is not sent by Ask", async () => {
    const spy = stubFetch("Friday.");
    await askAboutMeeting({ settings: byok, segments, question: "When?", onDelta: () => {} });
    expect(String(spy.mock.calls[0][0])).toMatch(/^https:\/\/api\.groq\.com\//);
    expect(features(spy)).toEqual([null]);
    expect(clients(spy)).toEqual([null]);
    expect(bodies(spy)[0].parley_task).toBeUndefined();
  });

  it("is not sent by meeting analysis", async () => {
    const spy = stubFetch('{"done":[]}');
    await checkTodos({
      settings: byok,
      segments,
      todos: [{ id: "t1", text: "Agree a ship date", done: false }],
    });
    expect(features(spy)).toEqual([null]);
  });
});

describe("checkTodos: which items were covered, and where", () => {
  const BUDGET = "Confirm the budget";
  const TIMELINE = "Agree the timeline";
  const timed = [seg({ text: "The budget is approved.", startMs: 192_000, endMs: 195_000 })];

  it("sends the transcript with its [m:ss] stamps and reads each item's stamp back as ms", async () => {
    const spy = stubFetch('{"done":[{"id":"t1","at":"3:12"},{"id":"t2","at":"later"},{"id":"zz","at":"0:01"}]}');
    const done = await checkTodos({
      settings: hosted,
      segments: timed,
      todos: [
        { id: "t1", text: BUDGET, done: false },
        { id: "t2", text: TIMELINE, done: false },
      ],
    });
    expect(done).toEqual([{ id: "t1", atMs: 192_000 }, { id: "t2", atMs: undefined }]);
    expect(JSON.stringify(bodies(spy)[0].messages)).toContain("[3:12]");
  });

  it("does not ask about an item the user unticked after the AI ticked it", async () => {
    const spy = stubFetch('{"done":[{"id":"t1","at":"3:12"}]}');
    const done = await checkTodos({
      settings: hosted,
      segments: timed,
      todos: [
        { id: "t1", text: BUDGET, done: false, aiDismissed: true },
        { id: "t2", text: TIMELINE, done: false },
      ],
    });
    expect(done).toEqual([]);
    expect(JSON.stringify(bodies(spy)[0].messages)).not.toContain(BUDGET);
  });

  it("skips the call when everything left is done or dismissed", async () => {
    const spy = stubFetch('{"done":[]}');
    await checkTodos({
      settings: hosted,
      segments: timed,
      todos: [{ id: "t1", text: BUDGET, done: false, aiDismissed: true }],
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

/** The live meeting's pass (with a cursor) reads only what is new since the
 *  last answered pass — pathorsAI/parley-internal#100. */
describe("checkTodos with the live meeting's cursor", () => {
  const todos = [
    { id: "t1", text: "Confirm the budget", done: false },
    { id: "t2", text: "Agree the timeline", done: false },
  ];
  const line = (n: number, text = `line number ${n}`) =>
    seg({ id: `s${n}`, text, startMs: n * 10_000, endMs: n * 10_000 + 5_000 });
  const upTo = (n: number) => Array.from({ length: n }, (_, i) => line(i + 1));
  const prompt = (spy: ReturnType<typeof stubFetch>, i: number) => JSON.stringify(bodies(spy)[i].messages);
  const unauthorized = () =>
    new Response(JSON.stringify({ error: { message: "nope" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

  it("sends only the new lines, after a few earlier ones for context", async () => {
    const cursor = createAgendaCursor("m1");
    const spy = stubFetch('{"done":[]}');
    await checkTodos({ settings: hosted, segments: upTo(10), todos, cursor });
    await checkTodos({ settings: hosted, segments: upTo(12), todos, cursor });
    const second = prompt(spy, 1);
    expect(second).toContain("line number 11");
    expect(second).toContain("line number 12");
    expect(second).toContain("line number 7"); // context, before the boundary
    expect(second).not.toContain("line number 6");
    expect(second).toContain("New since the last check");
  });

  it("makes no call when nothing new was said", async () => {
    const cursor = createAgendaCursor("m1");
    const spy = stubFetch('{"done":[]}');
    await checkTodos({ settings: hosted, segments: upTo(3), todos, cursor });
    const silent = [...upTo(3), seg({ id: "s4", text: "typing…", isFinal: false, startMs: 40_000 })];
    await checkTodos({ settings: hosted, segments: silent, todos, cursor });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("makes no call when every item is covered", async () => {
    const cursor = createAgendaCursor("m1");
    const spy = stubFetch('{"done":[]}');
    await checkTodos({ settings: hosted, segments: upTo(3), todos: todos.map((t) => ({ ...t, done: true })), cursor });
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not advance past lines a failed call never delivered", async () => {
    const cursor = createAgendaCursor("m1");
    stubFetch('{"done":[]}');
    await checkTodos({ settings: hosted, segments: upTo(2), todos, cursor });
    vi.stubGlobal("fetch", vi.fn(async () => unauthorized()));
    await expect(checkTodos({ settings: hosted, segments: upTo(4), todos, cursor })).rejects.toThrow();
    const spy = stubFetch('{"done":[{"id":"t1","at":"0:30"}]}');
    const done = await checkTodos({ settings: hosted, segments: upTo(5), todos, cursor });
    expect(done).toEqual([{ id: "t1", atMs: 30_000 }]);
    const retry = prompt(spy, 0);
    for (const n of [3, 4, 5]) expect(retry).toContain(`line number ${n}`);
  });

  it("an item covered across the boundary still has its opening line in view", async () => {
    const cursor = createAgendaCursor("m1");
    const spy = stubFetch('{"done":[]}');
    const opening = line(2, "About the budget, let me check with finance.");
    await checkTodos({ settings: hosted, segments: [line(1), opening], todos, cursor });
    await checkTodos({ settings: hosted, segments: [line(1), opening, line(3, "Yes, it is approved.")], todos, cursor });
    const second = prompt(spy, 1);
    expect(second).toContain("let me check with finance");
    expect(second).toContain("it is approved");
  });

  it("starts over for a new meeting", async () => {
    let cursor = cursorForMeeting(null, "m1");
    const spy = stubFetch('{"done":[]}');
    await checkTodos({ settings: hosted, segments: upTo(3), todos, cursor });
    cursor = cursorForMeeting(cursor, "m1"); // resume: same place
    await checkTodos({ settings: hosted, segments: upTo(3), todos, cursor });
    expect(spy).toHaveBeenCalledTimes(1);
    cursor = cursorForMeeting(cursor, "m2"); // a new meeting, same ids by chance
    await checkTodos({ settings: hosted, segments: upTo(3), todos, cursor });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(prompt(spy, 1)).toContain("line number 1");
  });
});
