import { generateObject, streamObject } from "ai";
import type { z } from "zod";
import { getModel, getProviderOptions } from "./provider";
import { PROVIDER_BY_ID } from "./providers";
import { log } from "../log";
import type { Settings } from "../types";

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

  try {
    return await generateObject({ model: getModel(settings, kind), providerOptions, schema, system, prompt });
  } catch (err) {
    const info = PROVIDER_BY_ID[settings.provider];
    const canFallback = info.kind === "openai-compatible" && (info.supportsStructuredOutputs ?? false);
    if (!canFallback) throw err;
    log.warn("ai: json_schema failed; retrying in json_object mode", {
      provider: settings.provider,
      kind,
      model: settings.models[settings.provider][kind],
    });
    return await generateObject({
      model: getModel(settings, kind, { forceJsonObject: true }),
      providerOptions,
      schema,
      system,
      prompt,
    });
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

  try {
    const result = streamObject({
      model: getModel(settings, kind, { forceJsonObject }),
      providerOptions,
      schema,
      system,
      prompt,
    });
    for await (const partial of result.partialObjectStream) onPartial(partial);
    return { object: await result.object, usage: await result.usage };
  } catch (err) {
    log.warn("ai: streamObject failed; falling back to a single non-streamed object", {
      provider: settings.provider,
      kind,
    });
    const res = await generateObjectResilient({ settings, kind, schema, system, prompt });
    onPartial(res.object);
    return { object: res.object, usage: res.usage };
  }
}
