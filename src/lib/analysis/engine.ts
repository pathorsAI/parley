import { useEffect, useRef } from "react";
import { useLiveStore, useStore, isTrimmed, hasSpokenSegment, meetingBriefText } from "../store";
import { hasProviderKey } from "../ai/settings";
import { analyzeTimeline } from "../ai/timeline";
import { detectMeetingKind } from "../ai/meetingKind";
import { analysisSignature, lensOf } from "./lens";
import { applyKindTemplate, evalsImpliedBy } from "./kindTemplate";
import { readJsonCache, writeJsonCache, clearCacheByPrefix, ANALYSIS_CACHE_PREFIX } from "../cache";
import { clearStudyCache } from "../history/studyCache";
import { landStage, makeRunGuard } from "./runGuard";
import { studyErrorMessage } from "./errorMessage";
import { log } from "../log";
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
  return `${ANALYSIS_CACHE_PREFIX}${fnv1a(raw)}`;
}

/** Drop every cached analysis (all `parley:analysis:*` localStorage entries). */
export function clearAnalysisCache(): number {
  return clearCacheByPrefix(ANALYSIS_CACHE_PREFIX);
}

/**
 * Listen for the native "Clear Cache → Analysis" menu action (Rust emits
 * `cache://clear-analysis`) and clear every derived-output cache: the raw
 * analysis cache here plus the read-only study-output cache. No-op outside
 * Tauri. Returns an unlisten function.
 */
export async function listenForCacheClear(): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { CACHE_CLEAR_ANALYSIS_EVENT, listenEvent } = await import("../ipc/events");
  return listenEvent(CACHE_CLEAR_ANALYSIS_EVENT, () => {
    const n = clearAnalysisCache() + clearStudyCache();
    console.info(`[cache] cleared ${n} cached analyses`);
  });
}

type AnalysisMode = "live" | "replay";
type StoreState = ReturnType<typeof useStore.getState>;

/** REPLAY honors the trim keep-window — trimmed segments are excluded. */
function replaySegments(state: StoreState): TranscriptSegment[] {
  return state.segments.filter((s) => !isTrimmed(s, state.replayTrim));
}

/** Replay analyses ride the deep lane (live ones, runLiveAnalysis, the realtime lane). */
const REPLAY_WORKLOAD: LlmWorkload = "deep";

/** Land a finished findings pass (fresh or from the content cache) in the
 *  store: the findings, the kind they were read through, and the eval set they
 *  reflect. */
function applyFindings(events: TimelineEvent[], kind: MeetingKind | null, evalSig: string): void {
  const store = useStore.getState();
  // A kind detected while the recording was off screen (the user left and came
  // back mid-pass) arrives here instead of from resolveMeetingKind.
  if (kind && store.meetingKind === null) {
    store.setMeetingKind(kind);
    applyKindTemplate(kind);
  }
  store.setFindings(events);
  store.setAnalysisStatus("done");
  store.setAnalyzedEvalSig(evalSig);
}

/**
 * WHICH KIND of meeting this is decides the analysis LENS — the finding fields
 * asked for and the brief's sections. Classify once per recording, on the cheap
 * lane, before the deep pass it shapes.
 *
 * A hand-set kind (the report page's picker, the ingest wizard) is already
 * non-null and is never overwritten. A failed detection stays null and reads as
 * the decision lens — the reading that is wrong in the least damaging way.
 *
 * Only REPLAY classifies: a live meeting is still arriving, and the frame it
 * would be judged by should not flip mid-conversation.
 *
 * The detected kind only goes into the store (and swaps the watchers) while the
 * recording is still on screen — `alive` — so a classification that outlives it
 * can never retag whatever the user opened next. Either way it is returned, and
 * persisted with the findings it shaped.
 */
async function resolveMeetingKind(args: {
  state: StoreState;
  mode: AnalysisMode;
  segments: TranscriptSegment[];
  meetingContext: string;
  alive: () => boolean;
  signal: AbortSignal;
}): Promise<MeetingKind | null> {
  const { state, mode, segments, meetingContext, alive, signal } = args;
  const { settings, speakerNames, meetingKind } = state;
  if (meetingKind !== null) return meetingKind;
  if (mode !== "replay" || !hasProviderKey(settings, "realtime")) return null;

  const kind = await detectMeetingKind({ settings, segments, meetingContext, names: speakerNames, signal });
  if (!kind) return null;
  if (alive()) {
    useStore.getState().setMeetingKind(kind);
    // Watchers follow the kind — but only when the user hasn't hand-picked a set.
    // A custom eval list is a deliberate choice; do not stomp it on a guess.
    applyKindTemplate(kind);
  }
  return kind;
}

/**
 * Run the unified analysis over the current transcript and write time-anchored
 * findings into the store. REPLAY's once-on-load (the loaded recording, in
 * useStore); mode "live" hands off to {@link runLiveAnalysis} (the running
 * meeting, in useLiveStore). Skips silently if there's no LLM key, no transcript, or a
 * run is in flight. Each run REPLACES the findings list — `setFindings` clears
 * the selection and any cached solutions (the model mints fresh ids per pass).
 * A run that outlives its recording being on screen stops writing into the
 * store but still finishes: its findings (and the detected kind) are written
 * onto that recording's saved entry, so reopening it never re-runs the pass (see
 * runGuard.landStage). A run superseded by a newer pass is discarded.
 */
const analysisGuard = makeRunGuard("findings");

/** Cancel the findings pass running for the recording on screen (see
 *  RunGuard.cancel). The caller resets the status and starts the next pass. */
export function cancelAnalysis(): boolean {
  return analysisGuard.cancel();
}

export async function runAnalysis(opts?: {
  /** "live" analyzes the RUNNING meeting (useLiveStore — see runLiveAnalysis);
   *  anything else, the recording the main window has loaded (useStore). */
  mode?: AnalysisMode;
  force?: boolean;
}): Promise<void> {
  if (opts?.mode === "live") return runLiveAnalysis();
  const state = useStore.getState();
  const { settings, speakerNames } = state;
  const mode: AnalysisMode = "replay";
  const segments = replaySegments(state);
  const workload = REPLAY_WORKLOAD;

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
  const run = analysisGuard.begin();
  state.setAnalysisError(null);
  state.setAnalysisStatus("running");

  try {
    const kind = await resolveMeetingKind({
      state,
      mode,
      segments,
      meetingContext,
      alive: run.alive,
      signal: run.signal,
    });
    // A newer pass for this recording took over — its result is the one kept,
    // so don't spend the deep lane on one that would be dropped.
    if (run.superseded()) return;
    const lens = lensOf(kind);
    // On screen, applyKindTemplate may have swapped the eval set — re-read it.
    // Off screen nothing was swapped, so take the set the kind implies.
    const evals = run.alive()
      ? useStore.getState().settings.evaluations
      : evalsImpliedBy(kind, useStore.getState().settings);

    // REPLAY: reuse a cached analysis for the exact same recording + template +
    // speaker names + model — re-analyzing the same upload is then instant + free.
    // (LIVE re-runs over a growing transcript, so it isn't cached.) `force` (the
    // user explicitly picking "re-analyze" from the player menu) skips the cache
    // READ so the model runs fresh — the fresh result still overwrites the cache.
    const cacheKey = analysisCacheKey(settings, segments, evals, meetingContext, speakerNames, kind);
    // Remember which eval set these findings reflect, so the UI can flag them as
    // stale when the template / evals change before the next re-analysis.
    const evalSig = analysisSignature(kind, evals);
    const cached = cacheKey && !opts?.force ? readJsonCache<TimelineEvent[]>(cacheKey) : null;

    const events =
      cached ??
      (await analyzeTimeline({
        settings,
        segments,
        evals,
        meetingContext,
        names: speakerNames,
        mode,
        lens,
        // Regenerating while this pass still runs cancels it (runGuard.cancel),
        // which aborts the request instead of letting it finish unseen.
        signal: run.signal,
        // Stream findings into the store as they're generated so dots + rows appear
        // progressively instead of all at once when the whole pass finishes.
        onPartial: (partial) => {
          if (run.alive()) useStore.getState().setFindings(partial);
        },
      }));
    // The content-keyed cache write is session-independent — always keep it.
    if (cacheKey && !cached) writeJsonCache(cacheKey, events);
    // Saved onto the entry right away — even while it's still on screen — so
    // leaving during the action-items pass can't lose them. `analyzed` stays
    // untouched: it means findings AND action items completed.
    await landStage(run, {
      stage: "findings",
      apply: () => applyFindings(events, kind, evalSig),
      patch: { findings: events, meetingKind: kind },
      persistWhileLoaded: true,
      pushWhileLoaded: false,
    });
  } catch (err) {
    // console.error never reaches the log file; this is the line a "stuck on
    // generating" report gets diagnosed from. A superseded (cancelled) pass is
    // not a failure — it is dropped below.
    if (run.superseded()) log.info("analysis: superseded pass ended", { error: String(err) });
    else log.error("analysis: findings failed", { error: String(err) });
    const message = await studyErrorMessage(err, settings.llmProviders[workload]);
    await landStage(run, {
      stage: "findings",
      error: message,
      apply: () => {
        useStore.getState().setAnalysisError(message);
        useStore.getState().setAnalysisStatus("error");
      },
      patch: null,
    });
  } finally {
    run.end();
  }
}

/** Bumped by every live pass: a pass whose number is no longer the latest, or
 *  whose meeting is no longer the live store's, writes nothing. */
let liveRunSeq = 0;

/**
 * The live meeting's analysis ("Analyze" in the meeting window, and the
 * auto-analyze interval): the transcript so far, on the realtime lane, into
 * the LIVE store. It has its own lock (the live store's `analysisStatus`) and
 * its own run tracking, so it never waits on, cancels or writes over a replay
 * pass the main window runs at the same time — and vice versa. No meeting-kind
 * detection (a live meeting's frame should not flip mid-conversation), so the
 * watcher set a recording's kind picks (applyKindTemplate) is never touched
 * from here. Not cached: the transcript keeps growing.
 */
export async function runLiveAnalysis(): Promise<void> {
  const live = useLiveStore.getState();
  const { settings } = useStore.getState();
  const workload: LlmWorkload = "realtime";
  if (live.analysisStatus === "running") return;
  if (!hasProviderKey(settings, workload)) return;
  const segments = live.segments;
  if (!hasSpokenSegment(segments)) return;

  const meetingId = live.liveMeetingId;
  const token = ++liveRunSeq;
  const alive = () => token === liveRunSeq && useLiveStore.getState().liveMeetingId === meetingId;
  const meetingContext = meetingBriefText(live);
  const evals = settings.evaluations;
  const kind = live.meetingKind;
  live.setAnalysisError(null);
  live.setAnalysisStatus("running");
  try {
    const events = await analyzeTimeline({
      settings,
      segments,
      evals,
      meetingContext,
      names: live.speakerNames,
      mode: "live",
      lens: lensOf(kind),
      onPartial: (partial) => {
        if (alive()) useLiveStore.getState().setFindings(partial);
      },
    });
    if (!alive()) return;
    const st = useLiveStore.getState();
    st.setFindings(events);
    st.setAnalysisStatus("done");
    st.setAnalyzedEvalSig(analysisSignature(kind, evals));
  } catch (err) {
    log.error("analysis: live findings failed", { error: String(err) });
    const message = await studyErrorMessage(err, settings.llmProviders[workload]);
    if (!alive()) return;
    const st = useLiveStore.getState();
    st.setAnalysisError(message);
    st.setAnalysisStatus("error");
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
  const store = useLiveStore.getState();
  store.setDeliveryAssessment(res);
  const lang = useStore.getState().settings.language;
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
  // The running meeting lives in the live store; settings in useStore.
  const meetingStatus = useLiveStore((s) => s.meetingStatus);
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
      const { autoAnalyze, autoAnalyzeSec, todos, segments, speakerNames, markTodosDone } =
        useLiveStore.getState();
      const { settings } = useStore.getState();
      const now = Date.now();

      if (autoAnalyze && now >= lastRun.current.analysis + autoAnalyzeSec * 1000) {
        lastRun.current.analysis = now;
        void runLiveAnalysis();
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
        const prosody = useLiveStore.getState().prosody;
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
