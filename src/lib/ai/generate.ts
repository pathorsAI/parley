import { generateObject, NoObjectGeneratedError, streamObject, type LanguageModelUsage } from "ai";
import { z } from "zod";
import { getModel, getProviderOptions } from "./provider";
import { isReasoningModel, PROVIDER_BY_ID } from "./providers";
import { logAiError } from "./errors";
import { log } from "../log";
import type { Settings } from "../types";

/**
 * Output-token cap. Reasoning models (Groq gpt-oss, o-series, …) spend output
 * tokens on HIDDEN reasoning before the answer; without headroom they exhaust the
 * budget and return EMPTY content — Groq then 400s with `json_validate_failed`
 * and an empty `failed_generation`. Give them a generous cap so the JSON still
 * fits after reasoning; non-reasoning models keep the provider default (undefined).
 */
function maxOutputTokensFor(settings: Settings, kind: "ask" | "eval"): number | undefined {
  return isReasoningModel(settings.models[settings.provider][kind]) ? 32_000 : undefined;
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
 */
export async function generateObjectResilient<OBJECT>(opts: {
  settings: Settings;
  kind: "ask" | "eval";
  schema: z.ZodType<OBJECT>;
  system: string;
  prompt: string;
}) {
  const { settings, kind, schema, system, prompt } = opts;
  const providerOptions = getProviderOptions(settings, kind);
  const maxOutputTokens = maxOutputTokensFor(settings, kind);
  const tag = { provider: settings.provider, kind, model: settings.models[settings.provider][kind] };

  try {
    return await generateObject({ model: getModel(settings, kind), providerOptions, schema, system, prompt, maxOutputTokens });
  } catch (err) {
    const info = PROVIDER_BY_ID[settings.provider];
    const canFallback = info.kind === "openai-compatible" && (info.supportsStructuredOutputs ?? false);
    logAiError(canFallback ? "ai.generateObject json_schema (retrying json_object)" : "ai.generateObject", tag, err);
    const salvaged = salvageObject(err, schema);
    if (salvaged) {
      log.info("ai.generateObject: salvaged drifted output", tag);
      return salvaged;
    }
    if (!canFallback) throw err;
    try {
      return await generateObject({
        model: getModel(settings, kind, { forceJsonObject: true }),
        providerOptions,
        schema,
        system,
        prompt,
        maxOutputTokens,
      });
    } catch (error_) {
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
 * `onPartial` receives the raw (deeply-partial) object shape; callers map only
 * the fully-formed elements into their domain type.
 */
export async function streamObjectResilient<OBJECT>(opts: {
  settings: Settings;
  kind: "ask" | "eval";
  schema: z.ZodType<OBJECT>;
  system: string;
  prompt: string;
  onPartial: (partial: unknown) => void;
}) {
  const { settings, kind, schema, system, prompt, onPartial } = opts;
  const providerOptions = getProviderOptions(settings, kind);
  const forceJsonObject = PROVIDER_BY_ID[settings.provider].kind === "openai-compatible";
  const maxOutputTokens = maxOutputTokensFor(settings, kind);
  const tag = { provider: settings.provider, kind, model: settings.models[settings.provider][kind] };

  try {
    const result = streamObject({
      model: getModel(settings, kind, { forceJsonObject }),
      providerOptions,
      schema,
      system,
      prompt,
      maxOutputTokens,
    });
    for await (const partial of result.partialObjectStream) onPartial(partial);
    return { object: await result.object, usage: await result.usage };
  } catch (err) {
    logAiError("ai.streamObject (falling back to non-streamed)", tag, err);
    const res = await generateObjectResilient({ settings, kind, schema, system, prompt });
    onPartial(res.object);
    return { object: res.object, usage: res.usage };
  }
}
