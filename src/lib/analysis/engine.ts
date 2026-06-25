import { useEffect, useRef } from "react";
import { useStore, isTrimmed, meetingBriefText, type AppMode } from "../store";
import { hasProviderKey } from "../ai/settings";
import { analyzeTimeline } from "../ai/timeline";
import { evalSignature } from "../evaluations/presets";
import { translate } from "../../i18n";
import { isTauri } from "../tauriEvents";
import type { EvalDef, Settings, TimelineEvent, TranscriptSegment } from "../types";

let analysisBusy = false;

/** Bump when the analysis prompt/output shape changes, to invalidate caches. */
const ANALYSIS_CACHE_VERSION = "6";

/** Deterministic 32-bit FNV-1a hash → hex; good enough for a content cache key. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * Cache key for a whole-recording analysis: every input that changes the result —
 * the model, the eval set, the meeting context, the speaker names, and the exact
 * transcript (ids/speakers/times/text). Same inputs → same findings (cache hit);
 * any change (new template, renamed speaker, different trim) → recompute.
 */
function analysisCacheKey(
  settings: Settings,
  segments: TranscriptSegment[],
  evals: EvalDef[],
  meetingContext: string,
  names: Record<string, string>
): string {
  const model = `${settings.provider}:${settings.models[settings.provider]?.eval ?? ""}:${settings.reasoningEffort?.eval ?? ""}`;
  const segSig = segments
    .filter((s) => s.isFinal && s.text.trim())
    .map((s) => `${s.id}|${s.speaker}|${s.startMs}|${s.endMs}|${s.text}`)
    .join("\n");
  const evalSig = evalSignature(evals);
  // The self-profile feeds the prompt (who is "us" vs "them"), so a change
  // to it must invalidate the cache and re-analyze.
  const profile = `${settings.userName}|${settings.userRole}|${settings.userCompany}|${settings.userBackground}`;
  const raw = `${ANALYSIS_CACHE_VERSION} ${model} ${profile} ${meetingContext} ${JSON.stringify(names)} ${evalSig} ${segSig}`;
  return `parley:analysis:${fnv1a(raw)}`;
}

function readAnalysisCache(key: string): TimelineEvent[] | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as TimelineEvent[]) : null;
  } catch {
    return null;
  }
}

function writeAnalysisCache(key: string, events: TimelineEvent[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(events));
  } catch {
    /* quota/serialization — caching is best-effort */
  }
}

/** Drop every cached analysis (all `parley:analysis:*` localStorage entries). */
export function clearAnalysisCache(): number {
  let removed = 0;
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith("parley:analysis:")) {
        localStorage.removeItem(k);
        removed++;
      }
    }
  } catch {
    /* ignore */
  }
  return removed;
}

/**
 * Listen for the native "Clear Cache → Analysis" menu action (Rust emits
 * `cache://clear-analysis`) and clear the localStorage analysis cache. No-op
 * outside Tauri. Returns an unlisten function.
 */
export async function listenForCacheClear(): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen("cache://clear-analysis", () => {
    const n = clearAnalysisCache();
    console.info(`[cache] cleared ${n} cached analyses`);
  });
}

/**
 * Run the unified analysis over the current transcript and write time-anchored
 * findings into the shared store slice. Used by LIVE's "Analyze" button (mode
 * "live", over the transcript so far) and REPLAY's once-on-load (mode "replay",
 * whole recording). Skips silently if there's no LLM key, no transcript, or a
 * run is in flight. Each run REPLACES the findings list — `setFindings` clears
 * the selection and any cached solutions (the model mints fresh ids per pass).
 */
export async function runAnalysis(opts?: { mode?: AppMode; force?: boolean }): Promise<void> {
  const state = useStore.getState();
  const { settings, speakerNames } = state;
  // The brief folds the per-deal BATNA / target / bottom line into the context, so
  // it both feeds the prompt AND keys the cache (editing setup → re-analysis).
  const meetingContext = meetingBriefText(state);
  const mode = opts?.mode ?? state.appMode;
  // REPLAY: honor the trim keep-window — trimmed segments are excluded from analysis.
  const segments =
    mode === "replay" ? state.segments.filter((s) => !isTrimmed(s, state.replayTrim)) : state.segments;

  if (analysisBusy) return;
  if (!hasProviderKey(settings)) return;
  if (!segments.some((s) => s.isFinal && s.text.trim())) return;

  // REPLAY: reuse a cached analysis for the exact same recording + template +
  // speaker names + model — re-analyzing the same upload is then instant + free.
  // (LIVE re-runs over a growing transcript, so it isn't cached.) `force` (the
  // user explicitly picking "re-analyze" from the player menu) skips the cache
  // READ so the model runs fresh — the fresh result still overwrites the cache.
  const cacheKey =
    mode === "replay"
      ? analysisCacheKey(settings, segments, settings.evaluations, meetingContext, speakerNames)
      : null;
  // Remember which eval set these findings reflect, so the UI can flag them as
  // stale when the template / evals change before the next re-analysis.
  const evalSig = evalSignature(settings.evaluations);
  if (cacheKey && !opts?.force) {
    const cached = readAnalysisCache(cacheKey);
    if (cached) {
      state.setFindings(cached);
      state.setAnalysisStatus("done");
      useStore.setState({ analyzedEvalSig: evalSig });
      return;
    }
  }

  analysisBusy = true;
  state.setAnalysisError(null);
  state.setAnalysisStatus("running");
  try {
    const events = await analyzeTimeline({
      settings,
      segments,
      evals: settings.evaluations,
      meetingContext,
      names: speakerNames,
      mode,
      // Stream findings into the store as they're generated so dots + rows appear
      // progressively instead of all at once when the whole pass finishes.
      onPartial: (partial) => useStore.getState().setFindings(partial),
    });
    if (cacheKey) writeAnalysisCache(cacheKey, events);
    useStore.getState().setFindings(events);
    useStore.getState().setAnalysisStatus("done");
    useStore.setState({ analyzedEvalSig: evalSig });
  } catch (err) {
    console.error("[analysis]", err);
    const { describeAiError } = await import("../ai/errors");
    useStore.getState().setAnalysisError(describeAiError(err));
    useStore.getState().setAnalysisStatus("error");
  } finally {
    analysisBusy = false;
  }
}

/**
 * REPLAY "re-analyze all": run a fresh whole-recording analysis, then regenerate
 * the post-meeting action items off it. Driven by the player's Analyze menu.
 * Forces a fresh analysis (bypasses the cache); action items only regenerate if
 * the analysis actually succeeded (so a failed pass doesn't wipe good items).
 */
export async function reanalyzeAll(): Promise<void> {
  await runAnalysis({ mode: "replay", force: true });
  if (useStore.getState().analysisStatus !== "done") return;
  const { regenerateActionItems } = await import("./actionItems");
  regenerateActionItems();
}

/**
 * LIVE background engine: while recording, optionally auto-run the analysis on an
 * interval, and auto-check the TODO agenda checklist. Mount once at the root.
 * Replaces the old `useEvaluationEngine`; the TODO auto-check is preserved here
 * since the agenda checklist is a LIVE-only concern.
 */
/** Min ms between tone checks (and so the fastest a tone nudge can repeat). */
const TONE_COOLDOWN_MS = 15_000;
/** New finalized speech (ms) required since the last tone check before re-running. */
const TONE_MIN_NEW_SPEECH_MS = 2_000;

export function useAnalysisEngine() {
  const meetingStatus = useStore((s) => s.meetingStatus);
  const lastRun = useRef<{ analysis: number; todos: number; tone: number }>({
    analysis: 0,
    todos: 0,
    tone: 0,
  });
  const todoBusy = useRef(false);
  const toneBusy = useRef(false);
  /** Latest finalized segment end already seen by the tone check (per meeting). */
  const lastToneEndMs = useRef(0);

  useEffect(() => {
    if (meetingStatus !== "recording") return;
    // Fresh meeting → forget the previous meeting's transcript high-water mark and
    // wall-clock cooldown markers, so the first speech can trigger checks promptly
    // instead of being suppressed by a prior meeting's cadence.
    lastToneEndMs.current = 0;
    lastRun.current = { analysis: 0, todos: 0, tone: 0 };

    const tick = () => {
      const { autoAnalyze, autoAnalyzeSec, todos, settings, segments, speakerNames, markTodosDone } =
        useStore.getState();
      const now = Date.now();

      if (autoAnalyze && now >= lastRun.current.analysis + autoAnalyzeSec * 1000) {
        lastRun.current.analysis = now;
        void runAnalysis({ mode: "live" });
      }

      // Auto-check the TODO checklist every ~45s while recording.
      if (
        now >= lastRun.current.todos + 45_000 &&
        !todoBusy.current &&
        hasProviderKey(settings) &&
        todos.some((t) => !t.done)
      ) {
        lastRun.current.todos = now;
        todoBusy.current = true;
        import("../ai/todos")
          .then(({ checkTodos }) => checkTodos({ settings, segments, todos, names: speakerNames }))
          .then((ids) => ids.length && markTodosDone(ids))
          .catch((e) => console.error("[todos]", e))
          .finally(() => {
            todoBusy.current = false;
          });
      }

      // Tone (aggressive/rude) coaching — opt-in, cheap, cooldowned. Fires only
      // when there's fresh speech, and surfaces a NUDGE (never a finding) so it
      // stays out of the evaluations/timeline list (the user's chosen UX).
      const maxEndMs = segments.reduce((m, s) => (s.isFinal ? Math.max(m, s.endMs) : m), 0);
      if (
        settings.delivery.tone &&
        !toneBusy.current &&
        hasProviderKey(settings) &&
        now >= lastRun.current.tone + TONE_COOLDOWN_MS &&
        maxEndMs > lastToneEndMs.current + TONE_MIN_NEW_SPEECH_MS
      ) {
        lastRun.current.tone = now;
        lastToneEndMs.current = maxEndMs;
        toneBusy.current = true;
        const prosody = useStore.getState().prosody;
        import("../ai/tone")
          .then(({ analyzeTone, TONE_FLAGGED }) =>
            analyzeTone({ settings, segments, names: speakerNames, prosody }).then((res) => {
              if (!res || !TONE_FLAGGED.has(res.tone)) return;
              const lang = useStore.getState().settings.language;
              useStore.getState().pushDeliveryNudge({
                kind: "tone",
                severity: res.tone === "sharp" ? "info" : "warn",
                message: res.nudge || translate(lang, "delivery.nudge.tone"),
                evidence: res.evidence || undefined,
              });
            })
          )
          .catch((e) => console.error("[tone]", e))
          .finally(() => {
            toneBusy.current = false;
          });
      }
    };

    const interval = setInterval(tick, 3000);
    return () => clearInterval(interval);
  }, [meetingStatus]);
}
