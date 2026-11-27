import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmProvider, Settings } from "../types";
import { seg } from "../test/fixtures";

// What every LLM call site puts on the wire for a BYOK (bring-your-own-key)
// provider: URL, headers and body of every request, retries included. The
// snapshot was recorded before hosted calls moved to Parley Cloud's task
// endpoint (/v1/ai/<task>/chat/completions), and is the proof that the move
// changed nothing for anyone on their own key: a diff here is a BYOK change.

vi.mock("../cloud/client", () => ({
  cloudToken: () => "test-token",
  CLOUD_URL: "https://cloud.example.test",
}));
vi.mock("../log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  attachConsoleOnce: vi.fn(),
}));
vi.mock("../usage/log", () => ({ recordLlmUsage: vi.fn(async () => {}) }));

import { useStore } from "../store";
import { askAboutMeeting } from "./ask";
import { generatePostMeetingReport } from "./report";
import { checkTodos } from "./todos";
import { detectMeetingKind } from "./meetingKind";
import { analyzeTimeline } from "./timeline";
import { generateActionItems } from "./actionItems";
import { analyzeDelivery } from "./delivery";
import { generateFindingSolution } from "./findingSolution";
import { suggestFiling } from "./filing";
import { runConnectionTest } from "./connectionTest";
import { polishTranscriptOutcome } from "../voiceTyping/polish";
import { draftBackground } from "../onboarding/memoryImport";
import { findNameEdit, summarizeIntro } from "../onboarding/micCheck";

/** One answer that satisfies every structured call's schema (each reads its own keys). */
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

type Request = { url: string; headers: Record<string, string>; body: unknown };

function stubFetch(content: string) {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      requests.push({ url: String(input), headers, body });
      return body.stream ? streamed(content) : completion(content);
    }),
  );
  return requests;
}

function settingsFor(provider: LlmProvider): Settings {
  const base = useStore.getState().settings;
  return {
    ...base,
    language: "zh-TW",
    llmProviders: { realtime: provider, deep: provider },
    models: { ...base.models, [provider]: { realtime: "byok-fast", deep: "byok-smart" } },
    groqApiKey: "gsk_mine",
    customApiKey: "custom-key",
    customBaseUrl: "https://llm.example.test/v1",
    userName: "Jack",
    userRole: "Founder",
    userCompany: "Pathors",
    voiceTypingPolishStyle: "tidy",
    voiceTypingCustomInstructions: "Keep it formal.",
  } as Settings;
}

const segments = [
  seg({ id: "a", text: "We agreed to ship on Friday.", startMs: 0, endMs: 3000 }),
  seg({ id: "b", source: "me", speaker: 0, text: "Um, I think the price is fine.", startMs: 4000, endMs: 7000 }),
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

/** Every call site, run once. A failure is part of what is pinned, not a test failure. */
const CALL_SITES: Record<string, (settings: Settings) => Promise<unknown>> = {
  ask: (settings) => askAboutMeeting({ settings, segments, question: "When?", onDelta: () => {} }),
  report: (settings) =>
    generatePostMeetingReport({ settings, segments, evaluations: [], todos: [], lens: "adversarial", onDelta: () => {} }),
  todos: (settings) => checkTodos({ settings, segments, todos: [{ id: "t1", text: "Agree a ship date", done: false }] }),
  meetingKind: (settings) => detectMeetingKind({ settings, segments, meetingContext: "Pilot call" }),
  timelineLive: (settings) => analyzeTimeline({ settings, segments, evals: [], mode: "live", lens: "opportunity" }),
  timelineReplay: (settings) => analyzeTimeline({ settings, segments, evals: [], mode: "replay", lens: "adversarial" }),
  actionItems: (settings) => generateActionItems({ settings, segments, findings: [finding], lens: "decision" }),
  deliveryLive: (settings) => analyzeDelivery({ settings, segments, mode: "live" }),
  deliveryPost: (settings) => analyzeDelivery({ settings, segments, mode: "post", measuredRateHz: 4.2 }),
  findingSolution: (settings) => generateFindingSolution({ settings, finding, segments, mode: "live" }),
  filing: (settings) =>
    suggestFiling({ settings, segments, folders: [{ id: "x", name: "Sales" }], currentTitle: "Recording 1" }),
  connectionTest: (settings) => runConnectionTest(settings, "realtime"),
  polish: (settings) =>
    polishTranscriptOutcome({
      raw: "um so we ship on friday, and then i think we test on monday",
      settings,
      protectedTerms: ["Parley", "Pathors"],
      speakerTerms: ["Jack", "Pathors"],
    }),
  draftBackground: (settings) => draftBackground({ settings, current: "Founder of Pathors.", text: "## Notes\nBuilds Parley." }),
  summarizeIntro: (settings) => summarizeIntro({ settings, transcript: "I'm Jack from Pathors." }),
  findNameEdit: (settings) => findNameEdit({ settings, before: "我在東昇工作", after: "我在東森工作" }),
};

afterEach(() => {
  vi.unstubAllGlobals();
  useStore.setState({ meetingContext: "" });
});

describe.each(["groq", "custom"] as LlmProvider[])("BYOK wire format (%s)", (provider) => {
  it.each(Object.keys(CALL_SITES))("%s", async (name) => {
    const requests = stubFetch(ANSWER);
    await CALL_SITES[name](settingsFor(provider)).catch(() => undefined);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests).toMatchSnapshot();
  });
});
