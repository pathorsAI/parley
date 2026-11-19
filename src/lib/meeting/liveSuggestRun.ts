// The store adapter for live suggestions (meeting/liveSuggest.ts holds the
// rules): once a second while a meeting records with 即時建議 on, read the
// transcript, decide whether to ask Parley Cloud, and put the answer on screen
// — unless the conversation has moved past it by the time it lands. Runs in the
// MAIN window, against the live store; the meeting window mirrors the card.

import { useEffect } from "react";
import { CLOUD_ENABLED } from "../flags";
import { log } from "../log";
import { useLiveStore, useStore, meetingBriefText } from "../store";
import { meetingElapsedMs } from "../store/meeting";
import { CloudError, cloudFetch, cloudToken } from "../cloud/client";
import {
  buildRequest,
  cardExpired,
  finalTurns,
  nextTrigger,
  parseStalled,
  parseSuggestions,
  speechPending,
  stillCurrent,
  turnsForTrigger,
  type SuggestMode,
  type Turn,
} from "./liveSuggest";

/** How long one request may take before it is not worth showing anymore. */
const REQUEST_TIMEOUT_MS = 6_000;

/** After a failure, stay quiet this long (wall clock): no point asking a
 *  service that is unavailable, over quota or throttling us every second. */
function backoffMs(status: number | null): number {
  if (status === 503) return 5 * 60_000; // the service is down
  if (status === 402) return 10 * 60_000; // hosted quota used up
  if (status === 429) return 30_000;
  return 15_000;
}

/** One meeting's engine: the trigger's memory, and the request in flight. */
function createEngine() {
  let meetingId = useLiveStore.getState().liveMeetingId;
  let inFlight: AbortController | null = null;
  let lastRequestAtMs: number | null = null;
  let lastTurnEndMs = 0;
  let lastLullEndMs = 0;
  let stalledEndMs = 0;
  let quietUntil = 0;
  /** The last "why not now" logged, so the log says it once per change. */
  let lastWhy = "";

  /** Log what the engine is waiting for, once each time it changes: the trail
   *  that answers "the switch is on, why did nothing show". */
  function note(why: string, data?: Record<string, unknown>) {
    if (why === lastWhy) return;
    lastWhy = why;
    log.info("live-suggest: waiting", { why, ...data });
  }

  function reset(id: string | null) {
    inFlight?.abort();
    inFlight = null;
    meetingId = id;
    lastRequestAtMs = null;
    lastTurnEndMs = 0;
    lastLullEndMs = 0;
    stalledEndMs = 0;
    quietUntil = 0;
    lastWhy = "";
  }

  async function ask(mode: SuggestMode, sent: Turn[], nowMs: number): Promise<void> {
    const s = useLiveStore.getState();
    const lang = useStore.getState().settings.language;
    const body = buildRequest({
      mode,
      language: lang === "en" ? "en" : "zh-TW",
      context: meetingBriefText(s),
      agenda: s.todos,
      playbook: s.meetingPlaybook,
      turns: sent,
      shown: s.liveSuggestLog,
      nowMs,
    });
    const ctrl = new AbortController();
    inFlight = ctrl;
    const startedAt = Date.now();
    log.info("live-suggest: asking", { mode, lines: body.transcript.length });
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    const id = meetingId;
    try {
      const res = await cloudFetch("/v1/live/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Parley-Feature": "live_suggestions" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const json: unknown = await res.json();
      const items = parseSuggestions(mode, json);
      log.info("live-suggest: answered", {
        mode,
        ms: Date.now() - startedAt,
        shown: items.length,
        abstained: (json as { abstained?: unknown } | null)?.abstained ?? null,
      });
      const now = useLiveStore.getState();
      // A different meeting, or the conversation moved on: drop it.
      if (now.liveMeetingId !== id || ctrl.signal.aborted) return;
      const turns = finalTurns(now.segments);
      if (!stillCurrent(mode, turnsForTrigger(sent), turnsForTrigger(turns))) {
        log.info("live-suggest: answer arrived stale, dropped", { mode });
        return;
      }
      if (items.length === 0) {
        // Nothing to say, and the topic has run dry: offer directions soon.
        if (mode === "turn" && parseStalled(json)) stalledEndMs = sent[sent.length - 1]?.endMs ?? 0;
        return;
      }
      now.showLiveSuggestion({ mode, items, atMs: meetingElapsedMs(now), finalsAtShow: turns.length });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      const status = e instanceof CloudError ? e.status : null;
      quietUntil = Date.now() + backoffMs(status);
      log.warn("live-suggest: request failed", { status, error: String(e) });
    } finally {
      clearTimeout(timer);
      if (inFlight === ctrl) inFlight = null;
    }
  }

  function tick(): void {
    const s = useLiveStore.getState();
    if (s.liveMeetingId !== meetingId) reset(s.liveMeetingId);
    if (s.meetingStatus !== "recording") return;
    const nowMs = meetingElapsedMs(s);
    const turns = finalTurns(s.segments);
    if (s.liveSuggestion && cardExpired(s.liveSuggestion, nowMs, turns)) s.clearLiveSuggestion();
    if (!cloudToken()) return note("not signed in to Parley Cloud");
    if (Date.now() < quietUntil) return note("backing off after a failed request");
    const pending = speechPending(s.segments);
    const mode = nextTrigger({
      nowMs,
      turns: turnsForTrigger(turns),
      pending,
      inFlight: inFlight != null,
      lastRequestAtMs,
      lastTurnEndMs,
      lastLullEndMs,
      stalledEndMs,
    });
    if (!mode) {
      const last = turns[turns.length - 1];
      if (inFlight) return note("a request is out");
      if (!last) return note("no finished line yet");
      if (pending) return note("someone is mid-sentence");
      return note(last.who === "me" ? "the user spoke last: waiting for a lull" : "waiting for the line to settle", {
        lines: turns.length,
        theirs: turns.filter((t) => t.who === "them").length,
      });
    }
    lastWhy = "";
    const lastEnd = turns[turns.length - 1]?.endMs ?? 0;
    lastRequestAtMs = nowMs;
    // Both marks move: a line answered as a turn is not then asked about again
    // as a lull, and a lull is asked about once.
    lastTurnEndMs = lastEnd;
    if (mode === "lull") lastLullEndMs = lastEnd;
    void ask(mode, turns, nowMs);
  }

  return {
    tick,
    dispose: () => reset(null),
  };
}

/** How often the engine looks at the transcript. Fine enough for the 1.2 s
 *  settle after a turn; the trigger itself throttles the requests. */
const TICK_MS = 1_000;

/**
 * Run live suggestions while the meeting records and the setting is on.
 * Mounted once in the main window (App.tsx). Turning it off clears the card.
 */
export function useLiveSuggestEngine(): void {
  const recording = useLiveStore((s) => s.meetingStatus === "recording");
  const on = useStore((s) => s.settings.liveSuggestions);

  useEffect(() => {
    if (!CLOUD_ENABLED || !recording || !on) return;
    log.info("live-suggest: engine on");
    const engine = createEngine();
    const id = setInterval(engine.tick, TICK_MS);
    return () => {
      clearInterval(id);
      engine.dispose();
    };
  }, [recording, on]);

  useEffect(() => {
    if (!on) useLiveStore.getState().clearLiveSuggestion();
  }, [on]);
}
