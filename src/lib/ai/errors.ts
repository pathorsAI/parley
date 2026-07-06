import { APICallError, NoObjectGeneratedError } from "ai";
import { log } from "../log";

/**
 * Turn an AI SDK error into a legible, single-line message.
 *
 * The SDK wraps the real failure: e.g. an `APICallError` with
 * message "Failed to process successful response" carries the actual parse /
 * validation failure (and often the provider's real error body) in `cause`.
 * Reading only `err.message` hides all of that. This walks the `cause` chain and
 * pulls out status codes, response bodies, and nested messages so failures are
 * self-diagnosing in the UI instead of an opaque wrapper.
 */
export function describeAiError(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  let depth = 0;

  while (cur && typeof cur === "object" && !seen.has(cur) && depth < 5) {
    seen.add(cur);
    const e = cur as Record<string, unknown>;

    if (typeof e.message === "string" && e.message.trim()) parts.push(e.message.trim());
    if (typeof e.statusCode === "number") parts.push(`HTTP ${e.statusCode}`);
    // The provider's actual error body (e.g. OpenRouter returning an error in a
    // 200 envelope) — the most useful field, truncated to stay readable.
    const body = e.responseBody ?? e.text ?? e.data;
    if (typeof body === "string" && body.trim()) parts.push(truncate(body.trim()));
    // Type-validation errors carry the offending value.
    if (e.value !== undefined && typeof e.value !== "object") parts.push(`value: ${truncate(String(e.value))}`);

    cur = e.cause;
    depth++;
  }

  // De-dup consecutive repeats (cause often re-states the parent message).
  const deduped = parts.filter((p, i) => p && p !== parts[i - 1]);
  const msg = deduped.join(" — ");
  return msg || (err instanceof Error ? err.message : String(err)) || "Unknown error";
}

function truncate(s: string, max = 600): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Classify a hosted-"parley" LLM failure into a stable code so the UI can show
 * an actionable message instead of a raw "HTTP 402". Mirrors the STT classifier
 * in capture.rs: 402 = out of credits, 401 / expired session = auth. Returns
 * null for any other provider or an unrelated failure, so callers fall back to
 * the generic {@link describeAiError} string. Walks the SDK's `cause` chain
 * because the real status usually sits on a nested APICallError.
 */
export function hostedLlmErrorCode(err: unknown, provider: string): "credits" | "auth" | null {
  if (provider !== "parley") return null;
  const seen = new Set<unknown>();
  let cur: unknown = err;
  let depth = 0;
  while (cur && typeof cur === "object" && !seen.has(cur) && depth < 5) {
    seen.add(cur);
    const e = cur as Record<string, unknown>;
    const status = typeof e.statusCode === "number" ? e.statusCode : undefined;
    const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
    if (status === 402 || msg.includes("402")) return "credits";
    if (status === 401 || msg.includes("401") || msg.includes("unauthorized")) return "auth";
    cur = e.cause;
    depth++;
  }
  return null;
}

function parseJson(s: unknown): Record<string, unknown> | undefined {
  if (typeof s !== "string") return undefined;
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Diagnostic fields pulled from an AI SDK error — privacy-safe: status codes,
 * provider error codes, finishReason, token COUNTS, and output LENGTHS only
 * (never content). These are what actually explain a failure, e.g.
 * `finishReason "length"` + a near-empty output ⇒ a reasoning model burned its
 * whole budget on hidden reasoning (Groq → `json_validate_failed`,
 * `failed_generation: ""`).
 */
function aiErrorMeta(err: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!err || typeof err !== "object") return out;
  out.error = (err as { name?: string }).name;

  if (APICallError.isInstance(err)) {
    out.status = err.statusCode;
    out.retryable = err.isRetryable;
    const perr = parseJson(err.responseBody)?.error as Record<string, unknown> | undefined;
    if (perr?.code) out.code = perr.code;
    if (typeof perr?.failed_generation === "string") out.failedGenLen = perr.failed_generation.length;
  }
  if (NoObjectGeneratedError.isInstance(err)) {
    out.finishReason = err.finishReason;
    out.inputTokens = err.usage?.inputTokens;
    out.outputTokens = err.usage?.outputTokens;
    if (typeof err.text === "string") out.textLen = err.text.length;
  }
  return out;
}

/** The raw model output from a failed structured call (the provider's
 *  `failed_generation`, or the generated text the SDK couldn't parse), if any —
 *  for dev-only diagnosis and a possible cross-model repair retry. */
function aiErrorRawText(err: unknown): string | null {
  if (NoObjectGeneratedError.isInstance(err) && typeof err.text === "string" && err.text.trim()) {
    return err.text;
  }
  if (APICallError.isInstance(err)) {
    const fg = (parseJson(err.responseBody)?.error as Record<string, unknown> | undefined)?.failed_generation;
    if (typeof fg === "string" && fg.trim()) return fg;
  }
  return null;
}

/**
 * Log a failed AI structured-output call so failures are diagnosable from the
 * rotating field log (and the in-app Field Log window). Two channels:
 *  - WARN: privacy-safe metadata (provider, model, status, error code,
 *    finishReason, token counts, output length) — always written.
 *  - DEBUG: the RAW model output (failed_generation / unparsed text, truncated).
 *    The log plugin keeps DEBUG only in dev builds, so the actual content is
 *    captured for debugging + a possible repair retry without leaking into
 *    release logs.
 */
export function logAiError(scope: string, fields: Record<string, unknown>, err: unknown): void {
  log.warn(`${scope}: failed`, { ...fields, ...aiErrorMeta(err) });
  const raw = aiErrorRawText(err);
  if (raw) log.debug(`${scope}: raw model output`, { ...fields, response: raw.slice(0, 4000) });
}
