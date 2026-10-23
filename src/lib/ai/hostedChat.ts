import { log } from "../log";
import { webviewFetch } from "./webviewFetch";
import type { LlmWorkload } from "../types";

/**
 * How hosted (Parley Cloud) chat calls are throttled and retried.
 *
 * The cloud's LLM proxy sits in front of a provider with a per-minute token
 * budget shared by every user. A desktop app that fires a burst of long
 * requests right after a long meeting syncs (findings, filing, then action
 * items + delivery, then the brief — each 10k+ prompt tokens, and each one
 * multiplied by the SDK's own retries and the format fallbacks) drains that
 * budget for everyone, and once every request fails at once, retrying them all
 * immediately is the worst possible answer. So: at most two hosted chat calls
 * in flight per workload lane, the rest waiting in arrival order; a 429 waits as long
 * as the server's `Retry-After` says (floored by an exponential backoff, capped,
 * with jitter); a 502 gets two short retries; nothing else is retried here.
 *
 * Mirrors the iOS `ChatThrottle.swift` policy.
 */
export interface ChatRetryPolicy {
  /** Retries after the first attempt, per status. */
  maxRateLimitRetries: number;
  maxBadGatewayRetries: number;
  /** The first backoff; each later one doubles it. */
  baseDelayMs: number;
  /** No single wait is longer than this (before jitter), whatever `Retry-After` asks for. */
  maxDelayMs: number;
  /** Up to this fraction of the delay is added at random, so requests that
   *  failed together do not come back together. */
  jitterFraction: number;
}

export const CHAT_RETRY_POLICY: ChatRetryPolicy = {
  maxRateLimitRetries: 3,
  maxBadGatewayRetries: 2,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
  jitterFraction: 0.5,
};

/** Hosted chat calls allowed in flight at once, per lane per webview. */
export const HOSTED_CHAT_CONCURRENCY = 2;

function retryLimit(policy: ChatRetryPolicy, status: number): number | null {
  if (status === 429) return policy.maxRateLimitRetries;
  if (status === 502) return policy.maxBadGatewayRetries;
  return null;
}

/**
 * How long to wait before retry number `retry` (0 for the first retry) after a
 * response with `status`, or `null` to give up and hand the response on.
 * `retryAfterMs` is the parsed `Retry-After` (null when absent); `jitter` is a
 * number in `[0, 1)`, injected so tests can pin it.
 */
export function retryDelayMs(
  policy: ChatRetryPolicy,
  status: number,
  retry: number,
  retryAfterMs: number | null,
  jitter: number,
): number | null {
  const limit = retryLimit(policy, status);
  if (limit === null || retry >= limit) return null;
  const backoff = policy.baseDelayMs * 2 ** retry;
  const wanted = status === 429 ? Math.max(retryAfterMs ?? backoff, backoff) : backoff;
  const capped = Math.min(wanted, policy.maxDelayMs);
  return capped + capped * policy.jitterFraction * jitter;
}

/**
 * `Retry-After` in milliseconds: either delta-seconds or an HTTP date. `null`
 * for a header that is absent or unreadable.
 */
export function parseRetryAfter(header: string | null | undefined, now: number = Date.now()): number | null {
  const raw = header?.trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw) * 1000;
  // An HTTP date names its day and month; without letters, Date.parse would
  // happily read "-3" as a year.
  if (!/[a-z]/i.test(raw)) return null;
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/** Resolve after `ms`, or reject with the signal's reason as soon as it aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Wrap `fn` so only its first call does anything. */
function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

/**
 * A counting semaphore: at most `limit` holders, the rest waiting FIFO. A
 * waiter whose signal aborts leaves the queue and rejects with the reason.
 */
export class ConcurrencyGate {
  private readonly limit: number;
  private holders = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  get inFlight(): number {
    return this.holders;
  }

  get queued(): number {
    return this.waiters.length;
  }

  /** Take a slot; resolves with its release function (safe to call twice). */
  acquire(signal?: AbortSignal | null): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.holders < this.limit) {
      this.holders += 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve(this.releaser());
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(grant);
    });
  }

  /** The slot passes straight to the next waiter; `holders` only falls when nobody waits. */
  private releaser(): () => void {
    return once(() => {
      const next = this.waiters.shift();
      if (next) next();
      else this.holders -= 1;
    });
  }
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface HostedChatFetchDeps {
  fetch: FetchFn;
  gate: ConcurrencyGate;
  policy: ChatRetryPolicy;
  /** A number in `[0, 1)`. */
  jitter: () => number;
  sleep: (ms: number, signal?: AbortSignal | null) => Promise<void>;
}

/** Fetch, retrying 429/502 by the policy. Abort stops a wait at once. */
async function fetchWithRetry(input: RequestInfo | URL, init: RequestInit | undefined, deps: HostedChatFetchDeps) {
  const signal = init?.signal;
  for (let retry = 0; ; retry++) {
    const res = await deps.fetch(input, init);
    const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
    const wait = retryDelayMs(deps.policy, res.status, retry, retryAfter, deps.jitter());
    if (wait === null) return res;
    log.warn("ai.hostedChat: retrying", { status: res.status, retry: retry + 1, waitMs: Math.round(wait) });
    await res.body?.cancel().catch(() => undefined);
    await deps.sleep(wait, signal);
  }
}

/**
 * Hand `res` on with its body wrapped so the gate slot is released only when
 * the body has been read to the end, failed, been cancelled, or the request
 * aborted — a streamed answer is "in flight" until its last chunk.
 */
function releaseWhenBodyEnds(res: Response, release: () => void, signal?: AbortSignal | null): Response {
  if (!res.body) {
    release();
    return res;
  }
  const done = once(release);
  signal?.addEventListener("abort", done, { once: true });
  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: finished, value } = await reader.read();
        if (finished) {
          done();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        done();
        controller.error(err);
      }
    },
    cancel(reason) {
      done();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** Build a fetch that runs every call through `deps.gate` and `deps.policy`. */
export function createHostedChatFetch(deps: HostedChatFetchDeps): FetchFn {
  return async (input, init) => {
    const release = await deps.gate.acquire(init?.signal);
    try {
      const res = await fetchWithRetry(input, init, deps);
      return releaseWhenBodyEnds(res, release, init?.signal);
    } catch (err) {
      release();
      throw err;
    }
  };
}

/**
 * One gate per workload lane. The deep lane carries the long study passes
 * (findings, action items, brief); the realtime lane carries the short,
 * latency-sensitive calls (voice-typing polish, Ask, filing, classification).
 * Separate gates keep a dictation polish from queueing behind two minute-long
 * analyses and missing its own few-second deadline; together they still bound
 * the webview to four hosted calls at once.
 */
export const hostedChatGates: Record<LlmWorkload, ConcurrencyGate> = {
  deep: new ConcurrencyGate(HOSTED_CHAT_CONCURRENCY),
  realtime: new ConcurrencyGate(HOSTED_CHAT_CONCURRENCY),
};

function laneFetch(workload: LlmWorkload): FetchFn {
  return createHostedChatFetch({
    fetch: webviewFetch,
    gate: hostedChatGates[workload],
    policy: CHAT_RETRY_POLICY,
    jitter: Math.random,
    sleep: abortableSleep,
  });
}

const LANE_FETCH: Record<LlmWorkload, FetchFn> = {
  deep: laneFetch("deep"),
  realtime: laneFetch("realtime"),
};

/**
 * The fetch the hosted Parley provider is built with for `workload`:
 * {@link webviewFetch} behind that lane's gate and the retry policy. A caller's
 * abort (polish racing its deadline) ends any queue or backoff wait at once.
 * BYOK providers do not use it.
 */
export function hostedChatFetch(workload: LlmWorkload): FetchFn {
  return LANE_FETCH[workload];
}
