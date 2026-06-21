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
