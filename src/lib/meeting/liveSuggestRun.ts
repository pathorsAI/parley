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
  parseSuggestions,
  speechPending,
  stillCurrent,
  type SuggestMode,
  type Turn,
} from "./liveSuggest";

/** How long one request may take before it is not worth showing anymore. */
const REQUEST_TIMEOUT_MS = 6_000;

/** After a failure, stay quiet this long (wall clock): no point asking a
 *  service that is unavailable, over quota or throttling us every second. */
function backoffMs(status: number | null): number {
  if (status === 503) return 5 * 60_000; // not configured on the server
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
  let quietUntil = 0;

  function reset(id: string | null) {
    inFlight?.abort();
    inFlight = null;
    meetingId = id;
    lastRequestAtMs = null;
    lastTurnEndMs = 0;
    lastLullEndMs = 0;
    quietUntil = 0;
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
      const now = useLiveStore.getState();
      // A different meeting, or the conversation moved on: drop it.
      if (now.liveMeetingId !== id || ctrl.signal.aborted) return;
      const turns = finalTurns(now.segments);
      if (!stillCurrent(mode, sent, turns)) {
        log.info("live-suggest: answer arrived stale, dropped", { mode });
        return;
      }
      if (items.length === 0) return;
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
    if (!cloudToken() || Date.now() < quietUntil) return;
    const mode = nextTrigger({
      nowMs,
      turns,
      pending: speechPending(s.segments),
      inFlight: inFlight != null,
      lastRequestAtMs,
      lastTurnEndMs,
      lastLullEndMs,
    });
    if (!mode) return;
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
