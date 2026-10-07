import { generateObject, NoObjectGeneratedError, streamObject, type LanguageModelUsage } from "ai";
import { z } from "zod";
import { getModel, getProviderOptions } from "./provider";
import { isReasoningModel, PROVIDER_BY_ID } from "./providers";
import { logAiError } from "./errors";
import { log } from "../log";
import {
  createDeadline,
  ONE_SHOT_DEADLINE_MS,
  rejectOnAbort,
  untilAborted,
  STUDY_FALLBACK_DEADLINE_MS,
  STUDY_HARD_DEADLINE_MS,
  STUDY_STALL_MS,
  type Deadline,
} from "./deadline";

export { STUDY_HARD_DEADLINE_MS, STUDY_STALL_MS } from "./deadline";
import type { LlmWorkload, Settings } from "../types";

/**
 * Output-token cap. Reasoning models (Groq gpt-oss, o-series, …) spend output
 * tokens on HIDDEN reasoning before the answer; without headroom they exhaust the
 * budget and return EMPTY content — Groq then 400s with `json_validate_failed`
 * and an empty `failed_generation`. Give them a generous cap so the JSON still
 * fits after reasoning; non-reasoning models keep the provider default (undefined).
 */
export function maxOutputTokensFor(settings: Settings, workload: LlmWorkload): number | undefined {
  const provider = settings.llmProviders[workload];
  return isReasoningModel(settings.models[provider][workload]) ? 32_000 : undefined;
}

/** Parse model text into JSON, tolerating ```json fences and leading prose. */
function parseLooseJson(text: string): unknown {
  const stripped = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const a = stripped.indexOf("{");
    const b = stripped.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(stripped.slice(a, b + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Coerce already-parsed JSON to a schema: validate as-is, and if that fails,
 * remap a lone wrapper array onto the schema's single key. Handles the common
 * json_object-mode drift where the model emits the right data under a different
 * top-level key (e.g. `{"moments":[…]}` for a `{"events":[…]}` schema). Pure +
 * exported for testing. Returns the validated object, or null.
 */
export function coerceToSchema<OBJECT>(value: unknown, schema: z.ZodType<OBJECT>): OBJECT | null {
  if (!value || typeof value !== "object") return null;
  const direct = schema.safeParse(value);
  if (direct.success) return direct.data;

  if (schema instanceof z.ZodObject) {
    const keys = Object.keys(schema.shape);
    const arrays = Object.values(value as Record<string, unknown>).filter(Array.isArray);
    if (keys.length === 1 && arrays.length === 1) {
      const remapped = schema.safeParse({ [keys[0]]: arrays[0] });
      if (remapped.success) return remapped.data as OBJECT;
    }
  }
  return null;
}

/**
 * Deterministic repair for output that was generated but didn't conform (AI SDK
 * NoObjectGeneratedError) — most often the right data under a DRIFTED wrapper key
 * (e.g. gpt-oss emits `{"moments":[…]}` for a `{"events":[…]}` schema in
 * json_object mode, or wraps the JSON in fences). We re-parse the captured text
 * and coerce it. No second model call. Returns the validated object + the call's
 * usage, or null when it genuinely can't be salvaged.
 */
function salvageObject<OBJECT>(
  err: unknown,
  schema: z.ZodType<OBJECT>
): { object: OBJECT; usage: LanguageModelUsage | undefined } | null {
  if (!NoObjectGeneratedError.isInstance(err) || typeof err.text !== "string") return null;
  const object = coerceToSchema(parseLooseJson(err.text), schema);
  return object == null ? null : { object, usage: err.usage };
}

/**
 * The error a call that gave up should surface: its deadline's own timeout
 * error when the deadline fired (however the SDK wrapped the abort, so
 * isTimeoutError and the "timed out" copy apply), else the original error — a
 * parent abort (the run was cancelled) included, which the runner drops.
 */
function deadlineError(err: unknown, deadline: Deadline): unknown {
  const why = deadline.reason();
  return why === "hard" || why === "stall" ? deadline.signal.reason : err;
}

/**
 * `generateObject` with a structured-output fallback. Some OpenAI-compatible
 * endpoints advertise json_schema (response_format strict) but intermittently
 * reject their own output with HTTP 400 `json_validate_failed` and an EMPTY
 * `failed_generation` — most visibly Groq's gpt-oss-120b / -20b. When that
 * happens we retry ONCE in `json_object` mode, where the schema is embedded in
 * the prompt and validated client-side by the AI SDK (zod) instead of by the
 * provider's strict validator. The happy path is identical to a plain
 * `generateObject` call, so this is safe to use everywhere.
 *
 * Providers using native tool mode (Anthropic) or already on json_object
 * (Ollama) don't have a stricter mode to fall back from, so they just rethrow.
 *
 * The whole call — fallback included — runs under a deadline (`hardMs`,
 * default {@link ONE_SHOT_DEADLINE_MS}) hanging off the caller's `signal`, so a
 * provider that never answers fails with a timeout instead of pinning the
 * caller forever, and cancelling the caller aborts the request.
 */
export async function generateObjectResilient<OBJECT>(opts: {
  settings: Settings;
  workload: LlmWorkload;
  schema: z.ZodType<OBJECT>;
  system: string;
  prompt: string;
  /** Sampling temperature. Omitted → the provider's default, which is what every
   *  caller but the filing pass wants. */
  temperature?: number;
  /** Cancels the call. Its abort is passed through untouched (no retry). */
  signal?: AbortSignal;
  /** Ceiling on the whole call. Default {@link ONE_SHOT_DEADLINE_MS}. */
  hardMs?: number;
}) {
  const deadline = createDeadline({ hardMs: opts.hardMs ?? ONE_SHOT_DEADLINE_MS, parent: opts.signal });
  try {
    // Raced against the deadline as well as handed to the SDK: the abort is what
    // cancels the request, the race is what guarantees this returns.
    return await Promise.race([
      generateObjectWithFallback(opts, deadline.signal),
      rejectOnAbort(deadline.signal),
    ]);
  } catch (err) {
    throw deadlineError(err, deadline);
  } finally {
    deadline.clear();
  }
}

async function generateObjectWithFallback<OBJECT>(
  opts: {
    settings: Settings;
    workload: LlmWorkload;
    schema: z.ZodType<OBJECT>;
    system: string;
    prompt: string;
    temperature?: number;
  },
  abortSignal: AbortSignal,
) {
  const { settings, workload, schema, system, prompt } = opts;
  // Spread only when set, so callers that never pass it send exactly what they
  // sent before (some providers reject an explicit temperature on some models).
  const sampling = opts.temperature === undefined ? {} : { temperature: opts.temperature };
  const provider = settings.llmProviders[workload];
  const providerOptions = getProviderOptions(settings, workload);
  const maxOutputTokens = maxOutputTokensFor(settings, workload);
  const tag = { provider, workload, model: settings.models[provider][workload] };
  const call = { providerOptions, schema, system, prompt, maxOutputTokens, abortSignal, ...sampling };

  try {
    return await generateObject({ model: getModel(settings, workload), ...call });
  } catch (err) {
    // Out of time or cancelled: nothing to salvage, and no time for a retry.
    if (abortSignal.aborted) throw err;
    const info = PROVIDER_BY_ID[provider];
    const canFallback = info.kind === "openai-compatible" && (info.supportsStructuredOutputs ?? false);
    logAiError(canFallback ? "ai.generateObject json_schema (retrying json_object)" : "ai.generateObject", tag, err);
    const salvaged = salvageObject(err, schema);
    if (salvaged) {
      log.info("ai.generateObject: salvaged drifted output", tag);
      return salvaged;
    }
    if (!canFallback) throw err;
    try {
      return await generateObject({ model: getModel(settings, workload, { forceJsonObject: true }), ...call });
    } catch (error_) {
      if (abortSignal.aborted) throw error_;
      logAiError("ai.generateObject json_object", tag, error_);
      const salvaged2 = salvageObject(error_, schema);
      if (salvaged2) {
        log.info("ai.generateObject: salvaged drifted output (json_object)", tag);
        return salvaged2;
      }
      throw error_;
    }
  }
}

/**
 * Streaming sibling of {@link generateObjectResilient}: yields each cumulative
 * partial object to `onPartial` as it fills in, so the UI can render results
 * progressively instead of popping the whole thing in at the end.
 *
 * OpenAI-compatible providers stream in `json_object` mode (the AI SDK parses
 * partial JSON client-side). That also dodges Groq gpt-oss's strict-json_schema
 * 400, so streaming works uniformly. Anthropic streams via its tool path. If the
 * stream errors, we fall back to ONE non-streamed resilient object and emit it as
 * a single final partial — so a flaky stream still yields a result.
 *
 * Bounded in time, always: the stream runs under a deadline — `hardMs` overall
 * (default {@link STUDY_HARD_DEADLINE_MS}) and `stallMs` without a new partial
 * (default {@link STUDY_STALL_MS}) — hanging off the caller's `signal`. When OUR
 * deadline fires, the fallback still gets one try under a fresh
 * {@link STUDY_FALLBACK_DEADLINE_MS} ceiling, then the timeout is thrown. When
 * the CALLER's signal aborts (the run was cancelled) nothing is retried.
 *
 * Also guards an AI SDK trap: `streamObject().object` only settles on the
 * provider's finish chunk. A request that fails before the stream starts (an
 * HTTP error after the SDK's retries, a dropped connection) ends the partial
 * stream quietly, reports the error only to `onError`, and leaves `object`
 * pending forever — which is how a study stage used to sit at "generating" for
 * good. The captured error is rethrown instead.
 *
 * `onPartial` receives the raw (deeply-partial) object shape; callers map only
 * the fully-formed elements into their domain type.
 */
export async function streamObjectResilient<OBJECT>(opts: {
  settings: Settings;
  workload: LlmWorkload;
  schema: z.ZodType<OBJECT>;
  system: string;
  prompt: string;
  /** Receives the deeply-partial object as it fills in. Omit for a one-shot
   *  answer with nothing to render mid-stream (e.g. a classification). */
  onPartial?: (partial: unknown) => void;
  /** Sampling temperature; see generateObjectResilient. */
  temperature?: number;
  /** Cancels the call, fallback included. */
  signal?: AbortSignal;
  /** Ceiling on the streamed attempt. Default {@link STUDY_HARD_DEADLINE_MS}. */
  hardMs?: number;
  /** Longest gap between partials. Default {@link STUDY_STALL_MS}. */
  stallMs?: number;
}) {
  const { settings, workload, schema, system, prompt, onPartial, temperature, signal } = opts;
  const sampling = temperature === undefined ? {} : { temperature };
  const provider = settings.llmProviders[workload];
  const providerOptions = getProviderOptions(settings, workload);
  const forceJsonObject = PROVIDER_BY_ID[provider].kind === "openai-compatible";
  const maxOutputTokens = maxOutputTokensFor(settings, workload);
  const tag = { provider, workload, model: settings.models[provider][workload] };
  const deadline = createDeadline({
    hardMs: opts.hardMs ?? STUDY_HARD_DEADLINE_MS,
    stallMs: opts.stallMs ?? STUDY_STALL_MS,
    parent: signal,
  });

  try {
    let streamError: unknown = null;
    const result = streamObject({
      model: getModel(settings, workload, { forceJsonObject }),
      providerOptions,
      schema,
      system,
      prompt,
      maxOutputTokens,
      abortSignal: deadline.signal,
      onError: ({ error }) => {
        streamError ??= error;
      },
      ...sampling,
    });
    for await (const partial of untilAborted(result.partialObjectStream, deadline.signal)) {
      deadline.touch();
      onPartial?.(partial);
    }
    // The stream has closed. If the finish chunk arrived, `object` has already
    // settled and wins the race (it is listed first); if it never will, the
    // captured stream error or the deadline ends the wait.
    const stops: Promise<never>[] = [rejectOnAbort(deadline.signal)];
    if (streamError !== null) stops.push(Promise.reject(streamError as Error));
    const object = await Promise.race([result.object, ...stops]);
    return { object, usage: await result.usage };
  } catch (err) {
    const why = deadline.reason();
    // Cancelled by the caller: no fallback, no error log — the run is dropped.
    if (why === "parent") throw err;
    const timedOut = why === "hard" || why === "stall";
    logAiError(
      timedOut ? `ai.streamObject (${why} deadline; falling back to non-streamed)` : "ai.streamObject (falling back to non-streamed)",
      tag,
      deadlineError(err, deadline),
    );
    const res = await generateObjectResilient({
      settings,
      workload,
      schema,
      system,
      prompt,
      temperature,
      signal,
      hardMs: timedOut ? STUDY_FALLBACK_DEADLINE_MS : undefined,
    });
    onPartial?.(res.object);
    return { object: res.object, usage: res.usage };
  } finally {
    deadline.clear();
  }
}
