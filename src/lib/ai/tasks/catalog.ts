import type { AppLanguage, LlmFeature, Settings } from "../../types";

/**
 * Parley Cloud's task API (`POST /v1/ai/<id>/chat/completions`): every hosted
 * LLM call names the feature it is, and the server — not the client — decides
 * the system prompt, the output format, the model lane and the limits. The
 * client only sends the feature's input (the last user message), the bounded
 * `params` that pick a prompt variant, and the `slots` of user content the
 * prompt carries (dictionary words, the user's own instructions).
 *
 * This file is the metadata half of the registry, small enough to ship in the
 * app: which tasks exist, their current version, and what they cost. The prompt
 * half is generated from the call sites' own prompt builders into
 * shared/ai-tasks/tasks.generated.json (scripts/gen-ai-tasks.ts), which the
 * cloud imports at build time. BYOK providers never look at any of this.
 */
export const AI_TASK_IDS = [
  "meeting_kind",
  "timeline",
  "action_items",
  "report",
  "delivery",
  "todos",
  "finding_solution",
  "filing",
  "ask",
  "ping",
  "polish",
  "draft_background",
  "summarize_intro",
  "find_name_edit",
] as const;

export type AiTaskId = (typeof AI_TASK_IDS)[number];

/** Which upstream model a task runs on: Parley Cloud's OPENROUTER_LANES. */
export type AiTaskLane = "smart" | "fast" | "concise";

export interface AiTaskMeta {
  /** Bumped only for a breaking change to the input or the output schema. */
  version: number;
  /** What the call bills to (the `X-Parley-Feature` it used to send). */
  feature: LlmFeature;
  /** The default lane; a variant may override it (timeline live, concise polish). */
  lane: AiTaskLane;
  /** Longest user message the server accepts (413 above it). */
  maxInputChars: number;
  /** Output cap upstream. Generous: the hosted lanes are reasoning models,
   *  and their hidden reasoning is paid out of the same budget. */
  maxOutputTokens: number;
  /** Sampling temperature, or null for the model's default. */
  temperature: number | null;
  /** Calls per user per task per day before 429 `task_daily_limit`. */
  dailyCallsPerUser: number;
}

// Input caps: a whole-meeting transcript with [m:ss] stamps and speaker labels
// runs ~60k characters an hour in English and far less in Chinese, so 400k is
// a long day of meetings in one recording, well past anything real. Per-task
// passes that read a capped excerpt get a cap a few times their own.
const WHOLE_MEETING = 400_000;

// Daily call budgets are generous ceilings against a runaway client, not
// quotas a real user meets: each is a few times the heaviest day we can
// picture (an eight-hour meeting day with live coaching on, or a day of
// dictation), and known users are not limited at all. A limit a person can
// hit is a bug, so when in doubt the number is higher.
export const AI_TASK_META: Record<AiTaskId, AiTaskMeta> = {
  // Once per recording (and again on a re-run).
  meeting_kind: { version: 1, feature: "meeting", lane: "fast", maxInputChars: WHOLE_MEETING, maxOutputTokens: 4_000, temperature: null, dailyCallsPerUser: 300 },
  // Live passes run every few minutes in a meeting; replay once per recording.
  timeline: { version: 1, feature: "meeting", lane: "smart", maxInputChars: WHOLE_MEETING, maxOutputTokens: 32_000, temperature: null, dailyCallsPerUser: 1_000 },
  action_items: { version: 1, feature: "meeting", lane: "smart", maxInputChars: WHOLE_MEETING, maxOutputTokens: 32_000, temperature: null, dailyCallsPerUser: 300 },
  report: { version: 1, feature: "report", lane: "smart", maxInputChars: WHOLE_MEETING, maxOutputTokens: 32_000, temperature: null, dailyCallsPerUser: 300 },
  // Live tone checks run every 15 s while the opt-in is on: ~2,000 in an eight-hour day.
  delivery: { version: 1, feature: "meeting", lane: "fast", maxInputChars: WHOLE_MEETING, maxOutputTokens: 8_000, temperature: null, dailyCallsPerUser: 5_000 },
  // The live agenda check runs on every few new lines of a meeting.
  todos: { version: 1, feature: "meeting", lane: "fast", maxInputChars: WHOLE_MEETING, maxOutputTokens: 8_000, temperature: null, dailyCallsPerUser: 5_000 },
  // One per finding the user opens; the prompt carries the transcript twice (at-moment + hindsight).
  finding_solution: { version: 1, feature: "meeting", lane: "fast", maxInputChars: 2 * WHOLE_MEETING, maxOutputTokens: 8_000, temperature: null, dailyCallsPerUser: 1_000 },
  // The transcript is capped at 24,000 characters (filing.json) plus title and folder names.
  filing: { version: 1, feature: "meeting", lane: "fast", maxInputChars: 60_000, maxOutputTokens: 4_000, temperature: 0.2, dailyCallsPerUser: 300 },
  ask: { version: 1, feature: "ask", lane: "fast", maxInputChars: WHOLE_MEETING, maxOutputTokens: 8_000, temperature: null, dailyCallsPerUser: 1_000 },
  // Settings → test connection. The server ignores the input.
  ping: { version: 1, feature: "meeting", lane: "fast", maxInputChars: 200, maxOutputTokens: 8, temperature: null, dailyCallsPerUser: 200 },
  // Every dictation over a clause; heavy dictation is hundreds a day.
  polish: { version: 1, feature: "voice_typing", lane: "fast", maxInputChars: 20_000, maxOutputTokens: 2_048, temperature: 0.2, dailyCallsPerUser: 5_000 },
  // Onboarding: memory import (notes capped at 6,000 characters) and the mic check.
  draft_background: { version: 1, feature: "meeting", lane: "fast", maxInputChars: 20_000, maxOutputTokens: 4_000, temperature: null, dailyCallsPerUser: 100 },
  summarize_intro: { version: 1, feature: "meeting", lane: "fast", maxInputChars: 20_000, maxOutputTokens: 4_000, temperature: null, dailyCallsPerUser: 100 },
  find_name_edit: { version: 1, feature: "meeting", lane: "fast", maxInputChars: 10_000, maxOutputTokens: 2_000, temperature: null, dailyCallsPerUser: 500 },
};

/** The two languages a prompt variant can be written for. */
export type TaskLanguage = AppLanguage;

/** The `language` param for a call made with these settings. */
export function taskLanguage(settings: Pick<Settings, "language">): TaskLanguage {
  return settings.language === "zh-TW" ? "zh-TW" : "en";
}

/** User content a prompt carries, as the client sends it: text or a list of terms. */
export type AiTaskSlots = Record<string, string | string[]>;

/**
 * What a call site hands the model layer instead of the old `feature`: which
 * task this is, the version of it the client speaks, the params that pick the
 * prompt variant, and the slots that fill it. Sent to Parley Cloud as the
 * request's `parley_task`; ignored by every BYOK provider.
 */
export interface AiTaskRequest {
  id: AiTaskId;
  version: number;
  params: Record<string, string>;
  slots: AiTaskSlots;
}

/** A task request at the version this build speaks. */
export function aiTask(id: AiTaskId, params: Record<string, string> = {}, slots: AiTaskSlots = {}): AiTaskRequest {
  return { id, version: AI_TASK_META[id].version, params, slots };
}
