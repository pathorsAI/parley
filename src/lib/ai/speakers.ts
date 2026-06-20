import { generateObject } from "ai";
import { z } from "zod";
import { getModel, getProviderOptions, JSON_MODE_INSTRUCTION } from "./provider";
import { speakerLabel } from "../store";
import { recordLlmUsage } from "../usage/log";
import { log } from "../log";
import { profileContext } from "./profile";
import type { Settings, SpeakerRole, TranscriptSegment } from "../types";

/**
 * Run-based output schema. Instead of one object per transcript line (which makes
 * the model's output grow O(lines) and, for a reasoning model whose hidden
 * reasoning tokens share the output budget, blow past max_tokens → an empty 200
 * body → "JSON Parse error: Unexpected EOF"), the model emits one entry per
 * SPEAKER RUN: a contiguous range of lines spoken by the same role. A real
 * conversation collapses dozens of lines into a handful of runs, so the visible
 * output tracks speaker *changes*, not line count. We expand runs back to a
 * per-line role map locally.
 */
const chunkSchema = z.object({
  runs: z
    .array(
      z.object({
        start: z
          .number()
          .int()
          .describe("0-based line index WITHIN THIS WINDOW where this speaker run begins."),
        role: z.number().int().describe("1-based role number that speaks this run."),
      })
    )
    .min(1)
    .describe(
      "Speaker runs in order of `start`, ascending. Each run owns every line from its `start` up to the next run's `start`; the last run owns the rest of the window. Emit a new run only where the speaker CHANGES — most windows have only a few runs."
    ),
});

type ChunkRun = z.infer<typeof chunkSchema>["runs"][number];

/**
 * System prompt. Deliberately aligned with `expandRunsIntoMap`: when a `prevRole`
 * hint is present, the model is told the window's first run may start AFTER index
 * 0 (the opening lines continue the previous speaker), so the seam carry-over in
 * expansion lives on the common path rather than only firing when the model
 * disobeys a "start at 0" instruction.
 */
const SYSTEM = `You re-attribute speakers in a meeting transcript whose automatic speaker diarization was UNRELIABLE (it merged or split people wrongly). You are given a fixed set of ROLES and a WINDOW of transcript lines, each indexed from 0 within the window. Decide which role most likely said each line — using conversational flow, turn-taking, who asks vs. answers, self-references, names, and topic ownership. Adjacent lines are usually the SAME speaker; speaker changes typically happen at question/answer boundaries or topic shifts. Use ONLY the role numbers provided.

Output SPEAKER RUNS, not one entry per line: emit a new run only where the speaker CHANGES. Each run is { start, role } where start is the window-local line index where that role begins speaking, and the run continues until the next run's start. Runs must be in ascending order of start. Most windows have only a few runs.

If a "previous speaker" is given, the window's opening lines may CONTINUE that speaker: in that case do NOT emit a run at start 0 — start your first run at the first line whose speaker DIFFERS from the previous speaker. If line 0 already starts a new speaker (or there is no previous speaker), your first run starts at 0.`;

/** Final segments attributed per model call — bounds each call's INPUT (and thus
 *  a reasoning model's hidden tokens) regardless of total transcript length. */
const CHUNK = 60;
/** Smallest window we'll split down to on failure before surfacing the error. */
const MIN_CHUNK = 12;
/** Lines of the previous window carried as read-only context (not re-output). */
const TAIL = 6;
/** Combined output ceiling per call (covers low-effort reasoning + tiny runs). */
const MAX_OUTPUT_TOKENS = 8000;

/** Provider-options shape used across the codebase: `{ [providerId]: { ... } }`. */
type ProviderOpts = Record<string, Record<string, string | { require_parameters: boolean }>>;

/**
 * Ask the LLM to re-assign each transcript line to one of the user's roles.
 *
 * Returns a map of line index (into the passed `segments` array) → 1-based role
 * number, with an entry for every line the model could attribute. Lines left
 * UNSET (a window that returned nothing usable) are absent on purpose, so the
 * engine keeps their existing STT label — the safe, established fallback.
 *
 * Robustness: the transcript is processed in fixed windows of `CHUNK` lines, each
 * with run-based output and a transcript-length-independent `maxOutputTokens`, so
 * no single call's reasoning or output scales with overall length. A truncated/
 * failed call is retried on smaller windows (down to `MIN_CHUNK`) before it
 * throws — so one truncated response self-heals. A genuine failure throws with
 * the original error preserved as `cause`, so the dialog's `describeAiError`
 * surfaces the real provider message.
 */
export async function reassignSpeakers(opts: {
  settings: Settings;
  segments: TranscriptSegment[];
  roles: SpeakerRole[];
  names?: Record<string, string>;
}): Promise<Map<number, number>> {
  const { settings, segments, roles, names } = opts;
  if (roles.length < 2 || segments.length === 0) return new Map();

  const maxRole = roles.length;
  const roleList = roles
    .map((role, idx) => `${idx + 1}. ${role.name}${role.hint?.trim() ? ` — ${role.hint.trim()}` : ""}`)
    .join("\n");

  // Force LOW reasoning effort for this call: re-attribution is lightweight
  // classification, and high effort is the main token sink that could exhaust
  // the budget. No-op for non-reasoning providers / Anthropic (empty options).
  const providerOptions = withLowReasoning(getProviderOptions(settings, "eval") as ProviderOpts);

  const map = new Map<number, number>();

  log.info("ai.speakers: start", {
    provider: settings.provider,
    model: settings.models[settings.provider].eval,
    roles: roles.length,
    segments: segments.length,
    chunk: CHUNK,
  });

  for (let base = 0; base < segments.length; base += CHUNK) {
    await attributeWindow(segments.slice(base, base + CHUNK), base);
  }

  log.info("ai.speakers: done", { assigned: map.size, total: segments.length });

  return map;

  /** Attribute one window [base, base+len); on failure, split and retry halves. */
  async function attributeWindow(window: TranscriptSegment[], base: number): Promise<void> {
    const len = window.length;
    if (len === 0) return;

    // Continuity: role of the line immediately before this window, read from what
    // we've actually resolved (never a loop-carried variable that can desync).
    const prevRole = base > 0 ? map.get(base - 1) : undefined;

    let tailContext = "";
    if (base > 0) {
      const tailStart = Math.max(0, base - TAIL);
      const tailLines: string[] = [];
      for (let i = tailStart; i < base; i++) {
        const resolved = map.get(i);
        const label = resolved ? roles[resolved - 1]?.name ?? `Role ${resolved}` : "?";
        tailLines.push(`(${label}) ${segments[i].text.trim()}`);
      }
      tailContext =
        `Context (already attributed, do NOT re-output these):\n${tailLines.join("\n")}\n\n` +
        (prevRole !== undefined
          ? `The previous speaker (the line immediately before index 0) was role ${prevRole}.\n\n`
          : "");
    }

    const lines = window
      .map((s, i) => `[${i}] (${speakerLabel(s, names)}) ${s.text.trim()}`)
      .join("\n");

    let runs: ChunkRun[];
    try {
      const { object, usage } = await generateObject({
        model: getModel(settings, "eval"),
        providerOptions,
        schema: chunkSchema,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM + JSON_MODE_INSTRUCTION,
        prompt:
          profileContext(settings) +
          `Roles (use these role numbers):\n${roleList}\n\n` +
          tailContext +
          `Window (${len} lines, indices 0–${len - 1}). Output speaker runs:\n${lines}`,
      });
      void recordLlmUsage(settings, "eval", "eval", usage);
      runs = object.runs;
    } catch (err) {
      // Truncated/empty body (the original failure) or any API error: split the
      // window and retry the halves before giving up. The seam carries via `map`.
      if (len > MIN_CHUNK) {
        log.warn("ai.speakers: window failed, splitting", { base, len, error: String(err) });
        const mid = Math.floor(len / 2);
        await attributeWindow(window.slice(0, mid), base);
        await attributeWindow(window.slice(mid), base + mid);
        return;
      }
      log.error("ai.speakers: window failed, giving up", { base, len, error: String(err) });
      // Preserve the original error as `cause` so the dialog's describeAiError
      // surfaces the real provider message (set after construction — the 2-arg
      // Error(message, { cause }) form isn't in this project's TS lib target).
      const error = new Error(
        `Speaker re-attribution failed on lines ${base + 1}–${base + len} of ${segments.length}`
      );
      (error as Error & { cause?: unknown }).cause = err;
      throw error;
    }

    expandRunsIntoMap({ runs, base, len, maxRole, prevRole, map });
  }
}

/**
 * Override `reasoningEffort` to "low" inside the provider-options object (shape
 * `{ [providerId]: { reasoningEffort?, ... } }`). No-op when empty (non-reasoning
 * providers / Anthropic). Returns a fresh object; never mutates the input.
 */
function withLowReasoning(providerOptions: ProviderOpts): ProviderOpts {
  const out: ProviderOpts = {};
  for (const [providerId, raw] of Object.entries(providerOptions)) {
    out[providerId] = "reasoningEffort" in raw ? { ...raw, reasoningEffort: "low" } : raw;
  }
  return out;
}

/**
 * Expand a window's speaker runs into per-line role assignments in `map`, keyed
 * by GLOBAL index (`base + window-local index`). Runs are half-open intervals:
 * each run owns every line from its `start` up to the next run's `start`, and the
 * last run owns the rest of the window. Boundary handling:
 *
 *  - Lines BEFORE the first run's start are the seam continuation: filled with
 *    `prevRole` if we have one, else the first run's role.
 *  - Lines AFTER the last run's start take the last run's role.
 *  - Empty / all-invalid runs: leave the WHOLE window UNSET (engine keeps the STT
 *    label). We deliberately do NOT stamp `prevRole` across it — that would
 *    silently invent one speaker over a span we failed to attribute.
 *  - Out-of-order / duplicate starts: sorted + a forward-only cursor makes
 *    overlaps harmless. Roles outside [1, maxRole] drop the run.
 */
function expandRunsIntoMap(args: {
  runs: ChunkRun[];
  base: number;
  len: number;
  maxRole: number;
  prevRole: number | undefined;
  map: Map<number, number>;
}): void {
  const { runs, base, len, maxRole, prevRole, map } = args;

  const clean = runs
    .filter(
      (r) =>
        Number.isInteger(r.role) &&
        r.role >= 1 &&
        r.role <= maxRole &&
        Number.isInteger(r.start) &&
        r.start >= 0 &&
        r.start < len
    )
    .sort((a, b) => a.start - b.start);

  // No usable runs: leave every line UNSET (engine keeps the old STT label).
  if (clean.length === 0) return;

  let cursor = 0;
  let activeRole = prevRole ?? clean[0].role;

  for (const run of clean) {
    const boundary = Math.max(cursor, run.start);
    for (let i = cursor; i < boundary; i++) map.set(base + i, activeRole);
    activeRole = run.role;
    cursor = boundary;
  }

  // The last run owns the remainder of the window.
  for (let i = cursor; i < len; i++) map.set(base + i, activeRole);
}
