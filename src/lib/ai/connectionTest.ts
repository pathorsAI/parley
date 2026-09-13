import type { TranslationKey } from "../../i18n/messages";
import type { LlmWorkload, Settings } from "../types";
import { PROVIDER_BY_ID, parseHttpUrl } from "./providers";

/**
 * "Test connection" for a self-hosted, OpenAI-compatible endpoint.
 *
 * A user pointing Parley at their own model server has three things to get
 * right — URL, key, model id — and the raw SDK failure for each of them reads
 * the same: `AI_APICallError`. Worse, the interesting ones only surface during a
 * real meeting, by which time nobody is debugging a base URL. So Settings runs
 * one throwaway completion through the SAME code path as analysis and turns
 * whatever comes back into a sentence that names the thing to fix.
 *
 * {@link classifyConnectionError} is pure and carries no heavy imports on
 * purpose: the classification is the part worth unit-testing, and the AI SDK is
 * only pulled in (dynamically) when a test actually runs.
 */

/** How long to wait before giving up. Mirrored in `provider.test.timeout`. */
export const CONNECTION_TEST_TIMEOUT_MS = 15_000;

/** A ready-to-render message: an i18n key plus its interpolation vars. */
export interface ConnectionErrorMessage {
  key: TranslationKey;
  vars?: Record<string, string>;
}

/** What the caller needs in order to write a specific message. */
export interface ConnectionErrorContext {
  /** Host of the configured base URL ("localhost:8000"), for "could not reach". */
  host: string;
  /** The model id that was tried. */
  model: string;
}

export type ConnectionTestResult =
  | { ok: true; model: string; ms: number }
  | { ok: false; error: ConnectionErrorMessage };

/**
 * Turn a failed connection test into a human-readable message.
 *
 * Pure — no SDK, no network, no store. The error shapes it handles are the ones
 * that actually reach us: an `APICallError` carrying `statusCode` (often nested
 * under `cause`), the browser's bare `TypeError: Failed to fetch` when the host
 * is down or the DNS name is wrong, and the `AbortError` our own timeout raises.
 */
export function classifyConnectionError(
  err: unknown,
  { host, model }: ConnectionErrorContext
): ConnectionErrorMessage {
  const chain = errorChain(err);
  const text = chain.map(describe).filter(Boolean).join(" ").toLowerCase();

  // Our own 15 s AbortController, or a transport-level timeout.
  if (chain.some(isAbort)) return { key: "settings.provider.test.timeout" };

  const status = chain.map(statusOf).find((s) => s !== undefined);

  // Nothing answered at all: wrong host, wrong port, server not running, DNS.
  // A transport failure carries no HTTP status, which is what separates it from
  // "the server answered, and said no".
  if (status === undefined && looksUnreachable(chain, text)) {
    return { key: "settings.provider.test.unreachable", vars: { host } };
  }

  if (status === 401 || status === 403) return { key: "settings.provider.test.rejectedKey" };
  // A 404 is nearly always the URL (a gateway mounted somewhere other than the
  // path the user typed), so it must not be reported as a model problem.
  if (status === 404) return { key: "settings.provider.test.notFound" };
  // 400 from an OpenAI-compatible server on a one-word prompt with no schema is
  // almost always the model id; so is any body that talks about models.
  if (status === 400 || /\bmodels?\b/.test(text)) {
    return { key: "settings.provider.test.unknownModel", vars: { model } };
  }

  return { key: "settings.provider.test.raw", vars: { error: rawMessage(chain, err) } };
}

/**
 * Run one throwaway completion against the provider serving `workload` and
 * report what happened. Resolves — it never throws — so the caller can render
 * the outcome inline instead of handling errors.
 *
 * The AI SDK is imported lazily so this module stays cheap for the Settings
 * window (and so the classifier can be unit-tested without mocking it), and
 * `maxRetries: 0` means a misconfigured URL reports back at once rather than
 * after three identical failures.
 */
export async function runConnectionTest(
  settings: Settings,
  workload: LlmWorkload,
  timeoutMs: number = CONNECTION_TEST_TIMEOUT_MS
): Promise<ConnectionTestResult> {
  const provider = settings.llmProviders[workload];
  const model = settings.models[provider][workload];
  const rawBaseUrl = settings.customBaseUrl ?? "";
  const host = parseHttpUrl(rawBaseUrl)?.host ?? rawBaseUrl.trim();
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const [{ generateText }, { getModel }] = await Promise.all([import("ai"), import("./provider")]);
    await generateText({
      model: getModel(settings, workload),
      prompt: "Reply with OK.",
      // Just enough to prove a completion came back; nobody reads the answer.
      maxOutputTokens: 8,
      maxRetries: 0,
      abortSignal: controller.signal,
    });
    return { ok: true, model, ms: Date.now() - startedAt };
  } catch (err) {
    return { ok: false, error: classifyConnectionError(err, { host, model }) };
  } finally {
    globalThis.clearTimeout(timer);
  }
}

/** Is `workload` served by a provider whose endpoint the user supplies? */
export function isUserSuppliedEndpoint(settings: Settings, workload: LlmWorkload): boolean {
  return PROVIDER_BY_ID[settings.llmProviders[workload]]?.userSuppliedBaseUrl === true;
}

/** The error and its `cause` ancestry, as plain records (deduped, depth-capped). */
function errorChain(err: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur) && out.length < 5) {
    seen.add(cur);
    const node = cur as Record<string, unknown>;
    out.push(node);
    cur = node.cause;
  }
  return out;
}

/** Message + response body of one link in the chain, for keyword matching. */
function describe(node: Record<string, unknown>): string {
  const parts = [node.name, node.message, node.code, node.responseBody, node.text];
  return parts.filter((p) => typeof p === "string" && p.trim()).join(" ");
}

function statusOf(node: Record<string, unknown>): number | undefined {
  if (typeof node.statusCode === "number") return node.statusCode;
  if (typeof node.status === "number") return node.status;
  return undefined;
}

function isAbort(node: Record<string, unknown>): boolean {
  if (node.name === "AbortError" || node.name === "TimeoutError") return true;
  const msg = typeof node.message === "string" ? node.message.toLowerCase() : "";
  return /\baborted?\b|\btimed out\b|\btimeout\b/.test(msg);
}

/**
 * Transport-level failure keywords. `Failed to fetch` (Chromium) and
 * `Load failed` (WebKit — which is what Tauri uses on macOS) are the two the
 * webview actually produces; the errno strings show up when the request is made
 * from Node during tests or from a Rust-side proxy.
 */
const UNREACHABLE = /failed to fetch|load failed|fetch failed|cannot connect|network ?error|networkerror|enotfound|econnrefused|ehostunreach|etimedout|econnreset|connection refused|getaddrinfo|socket hang up|err_connection|net::|dns/;

function looksUnreachable(chain: Record<string, unknown>[], text: string): boolean {
  if (UNREACHABLE.test(text)) return true;
  // A bare `TypeError` out of fetch() with no status is a transport failure even
  // when the message is something we don't recognise.
  return chain.some((n) => n.name === "TypeError");
}

/** Fallback: the most specific message we have, on one line. */
function rawMessage(chain: Record<string, unknown>[], err: unknown): string {
  for (const node of chain) {
    if (typeof node.message === "string" && node.message.trim()) return oneLine(node.message);
  }
  return oneLine(typeof err === "string" ? err : String(err)) || "Unknown error";
}

function oneLine(s: string, max = 200): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
