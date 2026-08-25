import { useEffect, useRef } from "react";
import { useStore, isTrimmed, hasSpokenSegment, meetingBriefText } from "../store";
import { hasProviderKey } from "../ai/settings";
import { analyzeTimeline } from "../ai/timeline";
import { detectMeetingKind } from "../ai/meetingKind";
import { analysisSignature, lensOf } from "./lens";
import { applyKindTemplate } from "./kindTemplate";
import { readJsonCache, writeJsonCache, clearCacheByPrefix } from "../cache";
import { clearStudyCache } from "../history/studyCache";
import { makeRunGuard } from "./runGuard";
import { translate } from "../../i18n";
import { isTauri } from "../tauriEvents";
import type {
  DeliveryAssessment,
  EvalDef,
  LlmWorkload,
  MeetingKind,
  Settings,
  TimelineEvent,
  ToneVerdict,
  TranscriptSegment,
} from "../types";

/** Bump when the analysis prompt/output shape changes, to invalidate caches. */
const ANALYSIS_CACHE_VERSION = "8";

/** Deterministic 32-bit FNV-1a hash → hex; good enough for a content cache key. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (const char of s) {
    h ^= char.codePointAt(0) ?? 0;
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
  names: Record<string, string>,
  kind: MeetingKind | null
): string {
  // Replay analyses ride the deep lane (see runAnalysis) — key the cache on it.
  const deepProvider = settings.llmProviders.deep;
  const model = `${deepProvider}:${settings.models[deepProvider]?.deep ?? ""}:${settings.reasoningEffort?.deep ?? ""}`;
  const segSig = segments
    .filter((s) => s.isFinal && s.text.trim())
    .map((s) => `${s.id}|${s.speaker}|${s.startMs}|${s.endMs}|${s.text}`)
    .join("\n");
  const evalSig = analysisSignature(kind, evals);
  // The self-profile feeds the prompt (who is "us" vs "them"), so a change
  // to it must invalidate the cache and re-analyze.
  const profile = `${settings.userName}|${settings.userRole}|${settings.userCompany}|${settings.userBackground}`;
  const raw = `${ANALYSIS_CACHE_VERSION} ${model} ${kind ?? "?"} ${profile} ${meetingContext} ${JSON.stringify(names)} ${evalSig} ${segSig}`;
  return `parley:analysis:${fnv1a(raw)}`;
}

/** Drop every cached analysis (all `parley:analysis:*` localStorage entries). */
export function clearAnalysisCache(): number {
  return clearCacheByPrefix("parley:analysis:");
}

/**
 * Listen for the native "Clear Cache → Analysis" menu action (Rust emits
 * `cache://clear-analysis`) and clear every derived-output cache: the raw
 * analysis cache here plus the read-only study-output cache. No-op outside
 * Tauri. Returns an unlisten function.
 */
export async function listenForCacheClear(): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen("cache://clear-analysis", () => {
    const n = clearAnalysisCache() + clearStudyCache();
    console.info(`[cache] cleared ${n} cached analyses`);
  });
}

type AnalysisMode = "live" | "replay";
type StoreState = ReturnType<typeof useStore.getState>;

/** LIVE vs REPLAY for this run: an explicit request wins, else the app mode. */
function resolveMode(state: StoreState, requested?: AnalysisMode): AnalysisMode {
  if (requested) return requested;
  return state.appMode === "study" ? "replay" : "live";
}

/** REPLAY honors the trim keep-window — trimmed segments are excluded. */
function segmentsForMode(state: StoreState, mode: AnalysisMode): TranscriptSegment[] {
  if (mode === "replay") return state.segments.filter((s) => !isTrimmed(s, state.replayTrim));
  return state.segments;
}

/** Replay analyses ride the deep lane; live ones the realtime lane. */
function workloadForMode(mode: AnalysisMode): LlmWorkload {
  return mode === "replay" ? "deep" : "realtime";
}

/** Apply a cached replay analysis, if there is one. True when it was applied. */
function applyCachedAnalysis(cacheKey: string, evalSig: string): boolean {
  const cached = readJsonCache<TimelineEvent[]>(cacheKey);
  if (!cached) return false;
  const state = useStore.getState();
  state.setFindings(cached);
  state.setAnalysisStatus("done");
  useStore.setState({ analyzedEvalSig: evalSig });
  return true;
}

/** The message the UI shows for a failed pass — hosted credit/auth exhaustion
 *  gets its own copy, everything else falls back to the raw provider error. */
async function analysisErrorMessage(err: unknown, provider: string): Promise<string> {
  const { describeAiError, hostedLlmErrorCode } = await import("../ai/errors");
  const { translate } = await import("../../i18n/messages");
  const code = hostedLlmErrorCode(err, provider);
  const lang = useStore.getState().settings.language;
  if (code === "credits") return translate(lang, "analysis.error.credits");
  if (code === "auth") return translate(lang, "analysis.error.auth");
  return describeAiError(err);
}

/**
 * Run the unified analysis over the current transcript and write time-anchored
 * findings into the shared store slice. Used by LIVE's "Analyze" button (mode
 * "live", over the transcript so far) and REPLAY's once-on-load (mode "replay",
 * whole recording). Skips silently if there's no LLM key, no transcript, or a
 * run is in flight. Each run REPLACES the findings list — `setFindings` clears
 * the selection and any cached solutions (the model mints fresh ids per pass).
 * A run that outlives its session or is superseded by a newer pass stops
 * writing (see runGuard) — its results are discarded, never misfiled.
 */
const analysisGuard = makeRunGuard();
export async function runAnalysis(opts?: {
  mode?: AnalysisMode;
  force?: boolean;
}): Promise<void> {
  const state = useStore.getState();
  const { settings, speakerNames } = state;
  const mode = resolveMode(state, opts?.mode);
  const segments = segmentsForMode(state, mode);
  const workload = workloadForMode(mode);

  // Reentrancy guard: the status IS the lock (set synchronously below, so two
  // back-to-back calls can't interleave — JS is single-threaded between awaits).
  if (state.analysisStatus === "running") return;
  if (!hasProviderKey(settings, workload)) return;
  if (!hasSpokenSegment(segments)) return;

  // The brief folds the per-deal BATNA / target / bottom line into the context,
  // so it both feeds the prompt AND keys the cache (editing setup → re-analysis).
  const meetingContext = meetingBriefText(state);

  // Take the lock BEFORE the first await. The status IS the reentrancy guard
  // and the pipeline scheduler dispatches every idle stage on each store tick —
  // the classification below both awaits AND writes to the store, so leaving the
  // status idle across it would dispatch a second (and third) analysis pass off
  // its own progress.
  const alive = analysisGuard.begin();
  state.setAnalysisError(null);
  state.setAnalysisStatus("running");

  // WHICH KIND of meeting this is decides the analysis LENS — the finding
  // fields asked for and the brief's sections. Classify once per recording, on
  // the cheap lane, before the deep pass it shapes; a hand-set kind (the report
  // page's picker) is already non-null and is never overwritten. A failed
  // detection stays null and reads as the decision lens, which is the reading
  // that is wrong in the least damaging way.
  let kind = state.meetingKind;
  if (kind === null && mode === "replay" && hasProviderKey(settings, "realtime")) {
    kind = await detectMeetingKind({ settings, segments, meetingContext, names: speakerNames });
    if (!alive()) return;
    if (kind) {
      useStore.getState().setMeetingKind(kind);
      // Watchers follow the kind — but only when the user hasn't hand-picked a
      // set. A custom eval list is a deliberate choice; do not stomp it.
      applyKindTemplate(kind);
    }
  }
  const lens = lensOf(kind);
  // applyKindTemplate may have swapped the eval set; re-read it.
  const evals = useStore.getState().settings.evaluations;

  // REPLAY: reuse a cached analysis for the exact same recording + template +
  // speaker names + model — re-analyzing the same upload is then instant + free.
  // (LIVE re-runs over a growing transcript, so it isn't cached.) `force` (the
  // user explicitly picking "re-analyze" from the player menu) skips the cache
  // READ so the model runs fresh — the fresh result still overwrites the cache.
  const cacheKey =
    mode === "replay"
      ? analysisCacheKey(settings, segments, evals, meetingContext, speakerNames, kind)
      : null;
  // Remember which eval set these findings reflect, so the UI can flag them as
  // stale when the template / evals change before the next re-analysis.
  const evalSig = analysisSignature(kind, evals);
  // A cache hit lands the findings and flips the status to "done" itself.
  if (cacheKey && !opts?.force && applyCachedAnalysis(cacheKey, evalSig)) return;

  try {
    const events = await analyzeTimeline({
      settings,
      segments,
      evals,
      meetingContext,
      names: speakerNames,
      mode,
      lens,
      // Stream findings into the store as they're generated so dots + rows appear
      // progressively instead of all at once when the whole pass finishes.
      onPartial: (partial) => {
        if (alive()) useStore.getState().setFindings(partial);
      },
    });
    // The content-keyed cache write is session-independent — always keep it.
    if (cacheKey) writeJsonCache(cacheKey, events);
    if (!alive()) return;
    useStore.getState().setFindings(events);
    useStore.getState().setAnalysisStatus("done");
    useStore.setState({ analyzedEvalSig: evalSig });
  } catch (err) {
    console.error("[analysis]", err);
    if (!alive()) return;
    const message = await analysisErrorMessage(err, settings.llmProviders[workload]);
    useStore.getState().setAnalysisError(message);
    useStore.getState().setAnalysisStatus("error");
  }
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

/**
 * Store a fresh delivery assessment and raise at most ONE nudge from it: tone
 * first when it's sharp/aggressive/rude, otherwise over-frequent fillers — the
 * two never stack.
 */
function applyDeliveryAssessment(
  res: DeliveryAssessment,
  toneFlagged: ReadonlySet<ToneVerdict>
): void {
  const store = useStore.getState();
  store.setDeliveryAssessment(res);
  const lang = store.settings.language;
  if (toneFlagged.has(res.tone)) {
    store.pushDeliveryNudge({
      kind: "tone",
      severity: res.tone === "sharp" ? "info" : "warn",
      message: translate(lang, "delivery.nudge.tone"),
      evidence: res.toneEvidence || undefined,
    });
  } else if (res.fillers.level === "frequent") {
    store.pushDeliveryNudge({
      kind: "filler",
      severity: "info",
      message: translate(lang, "delivery.nudge.filler"),
      evidence: res.fillers.examples.slice(0, 3).join("、") || undefined,
    });
  }
}

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
      const {
        autoAnalyze,
        autoAnalyzeSec,
        todos,
        settings,
        segments,
        speakerNames,
        markTodosDone,
      } = useStore.getState();
      const now = Date.now();

      if (autoAnalyze && now >= lastRun.current.analysis + autoAnalyzeSec * 1000) {
        lastRun.current.analysis = now;
        void runAnalysis({ mode: "live" });
      }

      // Auto-check the TODO agenda every ~45s while recording. The manual "AI"
      // button on the checklist runs the same pass on demand.
      if (
        now >= lastRun.current.todos + 45_000 &&
        !todoBusy.current &&
        hasProviderKey(settings, "realtime") &&
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

      // Delivery coaching (tone + over-frequent fillers) — opt-in, cheap,
      // cooldowned. Fires only when there's fresh speech. Stores the full
      // assessment for the live Delivery panel, and surfaces NUDGES (never a
      // finding) so it stays out of the evaluations/timeline list.
      const maxEndMs = segments.reduce((m, s) => (s.isFinal ? Math.max(m, s.endMs) : m), 0);
      if (
        settings.delivery.tone &&
        !toneBusy.current &&
        hasProviderKey(settings, "realtime") &&
        now >= lastRun.current.tone + TONE_COOLDOWN_MS &&
        maxEndMs > lastToneEndMs.current + TONE_MIN_NEW_SPEECH_MS
      ) {
        lastRun.current.tone = now;
        lastToneEndMs.current = maxEndMs;
        toneBusy.current = true;
        const prosody = useStore.getState().prosody;
        import("../ai/delivery")
          .then(async ({ analyzeDelivery, TONE_FLAGGED }) => {
            const res = await analyzeDelivery({
              settings,
              segments,
              names: speakerNames,
              prosody,
              mode: "live",
            });
            if (res) applyDeliveryAssessment(res, TONE_FLAGGED);
          })
          .catch((e) => console.error("[delivery]", e))
          .finally(() => {
            toneBusy.current = false;
          });
      }
    };

    const interval = setInterval(tick, 3000);
    return () => clearInterval(interval);
  }, [meetingStatus]);
}
