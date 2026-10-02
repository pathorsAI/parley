/**
 * The fetch every AI SDK client in the webview is built with. The SDK stamps its own
 * `user-agent` ("ai-sdk/openai-compatible/x ai-sdk/provider-utils/y runtime/browser") on
 * every request. In a browser that is not a CORS-safelisted header: Chromium (WebView2,
 * Windows) silently drops it, but WebKit (WKWebView, macOS) sends it and names it in the
 * preflight's Access-Control-Request-Headers. Parley Cloud allows only Content-Type,
 * Authorization, Idempotency-Key and X-Parley-Client, so on the Mac every hosted LLM call
 * failed its preflight and WebKit rejected fetch with a bare `TypeError: Load failed`,
 * which the SDK passes through unwrapped (it only recognises "fetch failed" / "failed to
 * fetch"). Dropping the header loses nothing: the webview still sends its own User-Agent,
 * and Windows clients have always gone out this way.
 *
 * `globalThis.fetch` is looked up per call rather than captured at import, so a test that
 * stubs the global after this module loaded is still the fetch that runs. Only `init`'s
 * headers are filtered: the SDK always passes a string URL, so a `Request` input carrying
 * headers of its own never reaches here, and is forwarded as-is if one ever does.
 */
export function webviewFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!init?.headers) return globalThis.fetch(input, init);
  const headers = new Headers(init.headers);
  headers.delete("user-agent"); // Headers names are case-insensitive
  // Spread, not rebuild: method, body and the abort signal must reach the real fetch.
  return globalThis.fetch(input, { ...init, headers });
}
