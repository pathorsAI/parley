/**
 * "This provider doesn't serve where you are" — told apart from "your key was
 * rejected".
 *
 * A BYOK call goes straight from the user's machine to the vendor, so a user in
 * Hong Kong or mainland China is refused by OpenAI, Anthropic, Gemini and Groq
 * because of where the request comes from. Those refusals are 403s (400 for
 * Gemini), and reading them as a bad key sends the user re-pasting a key that
 * was never the problem. The fix is a different provider — Parley's hosted
 * model calls from our own cloud, so it works from anywhere.
 *
 * Matching is per provider and needs the body to say so, never the status
 * alone: a bare 403 from OpenRouter or a self-hosted gateway stays a key
 * problem. Pure and dependency-free so the connection test (which avoids heavy
 * imports) and the runtime classifier can share it.
 */

/**
 * Phrases only a region refusal contains, whatever the status or provider:
 * OpenAI's `unsupported_country_region_territory` ("Country, region, or
 * territory not supported", which Anthropic has also been seen to send), and
 * Gemini's FAILED_PRECONDITION "User location is not supported for the API use."
 */
const UNIQUE_MARKERS = [
  "unsupported_country_region_territory",
  "country, region, or territory not supported",
  "user location is not supported",
];

/** The providers that refuse by region and whose refusals we recognise. */
const REGION_PROVIDERS = new Set(["openai", "anthropic", "gemini", "groq"]);

/**
 * Is a failed call to `provider` — HTTP `status` (undefined when unknown) with
 * `text` (message + response body) — a refusal because of the user's region?
 */
export function isRegionRefusal(provider: string, status: number | undefined, text: string): boolean {
  if (!REGION_PROVIDERS.has(provider)) return false;
  const m = text.toLowerCase();
  if (UNIQUE_MARKERS.some((marker) => m.includes(marker))) {
    // The markers are unambiguous; only a status that cannot be a refusal
    // (a 2xx, a 5xx) argues against them.
    return status === undefined || status === 400 || status === 403;
  }
  if (status !== 403) return false;
  // Anthropic answers an unsupported region with 403 `forbidden` "Request not
  // allowed". A key without access reads differently ("does not have
  // permission…", "This organization has been disabled") and stays a key error.
  if (provider === "anthropic") return /\brequest not allowed\b/.test(m);
  // Groq rejects a bad key with 401 `invalid_api_key`; its 403 is the bare
  // `{"error":{"message":"Forbidden"}}` an IP / region block returns.
  if (provider === "groq") return /\bforbidden\b/.test(m) && !/invalid_api_key|invalid api key/.test(m);
  return false;
}

/**
 * {@link isRegionRefusal} over an AI SDK error: walks the `cause` chain (and a
 * RetryError's `lastError`) for the status and the message / response body.
 */
export function isRegionRefusalError(err: unknown, provider: string): boolean {
  const texts: string[] = [];
  let status: number | undefined;
  const seen = new Set<unknown>();
  let cur: unknown = err;
  for (let depth = 0; cur && typeof cur === "object" && !seen.has(cur) && depth < 6; depth++) {
    seen.add(cur);
    const e = cur as Record<string, unknown>;
    if (status === undefined && typeof e.statusCode === "number") status = e.statusCode;
    if (status === undefined && typeof e.status === "number") status = e.status;
    for (const field of [e.message, e.responseBody, e.text]) {
      if (typeof field === "string") texts.push(field);
    }
    cur = e.lastError ?? e.cause;
  }
  if (typeof err === "string") texts.push(err);
  return isRegionRefusal(provider, status, texts.join(" "));
}

/**
 * {@link isRegionRefusal} over an already-flattened message
 * ({@link describeAiError}'s "… — HTTP 403 — {body}"), for surfaces that only
 * kept the string.
 */
export function isRegionRefusalMessage(message: string, provider: string): boolean {
  const status = /\bHTTP (\d{3})\b/.exec(message)?.[1];
  return isRegionRefusal(provider, status ? Number(status) : undefined, message);
}
