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

describe("X-Parley-Feature on Parley Cloud", () => {
  it("tags Ask as ask", async () => {
    const spy = stubFetch("Friday.");
    await askAboutMeeting({ settings: hosted, segments, question: "When?", onDelta: () => {} });
    expect(String(spy.mock.calls[0][0])).toBe("https://cloud.example.test/v1/chat/completions");
    expect(features(spy)).toEqual(["ask"]);
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
    expect(features(spy)).toEqual(["report"]);
  });

  it("tags live meeting analysis as meeting", async () => {
    const spy = stubFetch('{"done_ids":["t1"]}');
    const done = await checkTodos({
      settings: hosted,
      segments,
      todos: [{ id: "t1", text: "Agree a ship date", done: false }],
    });
    expect(done).toEqual(["t1"]);
    expect(features(spy)).toEqual(["meeting"]);
  });

  /** Groq's strict json_schema 400 sends the call round again in json_object
   *  mode; the retry is the same feature's spend. */
  it("keeps the tag on the json_object retry", async () => {
    const spy = stubFetch('{"a":"ok"}', refused);
    const res = await generateObjectResilient({
      settings: hosted,
      workload: "realtime",
      feature: "meeting",
      schema: z.object({ a: z.string() }),
      system: "Reply in json.",
      prompt: "p",
    });
    expect(res.object).toEqual({ a: "ok" });
    expect(bodies(spy).map((b) => b.response_format?.type)).toEqual(["json_schema", "json_object"]);
    expect(features(spy)).toEqual(["meeting", "meeting"]);
  });

  it("keeps the tag on a streamed call's non-streamed fallback", async () => {
    const spy = stubFetch('{"a":"ok"}', refused);
    const res = await streamObjectResilient({
      settings: hosted,
      workload: "deep",
      feature: "meeting",
      schema: z.object({ a: z.string() }),
      system: "Reply in json.",
      prompt: "p",
    });
    expect(res.object).toEqual({ a: "ok" });
    expect(bodies(spy).map((b) => b.stream ?? false)).toEqual([true, false]);
    expect(features(spy)).toEqual(["meeting", "meeting"]);
  });

  it("sends no tag when the caller names no feature", async () => {
    const spy = stubFetch('{"a":"ok"}');
    await generateObjectResilient({
      settings: hosted,
      workload: "realtime",
      schema: z.object({ a: z.string() }),
      system: "Reply in json.",
      prompt: "p",
    });
    expect(features(spy)).toEqual([null]);
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
  });

  it("is not sent by meeting analysis", async () => {
    const spy = stubFetch('{"done_ids":[]}');
    await checkTodos({
      settings: byok,
      segments,
      todos: [{ id: "t1", text: "Agree a ship date", done: false }],
    });
    expect(features(spy)).toEqual([null]);
  });
});
