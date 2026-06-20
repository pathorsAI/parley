import { useEffect, useRef } from "react";
import { useStore, isTrimmed, type AppMode } from "../store";
import { hasProviderKey } from "../ai/settings";
import { analyzeTimeline } from "../ai/timeline";

let analysisBusy = false;

/**
 * Run the unified analysis over the current transcript and write time-anchored
 * findings into the shared store slice. Used by LIVE's "Analyze" button (mode
 * "live", over the transcript so far) and REPLAY's once-on-load (mode "replay",
 * whole recording). Skips silently if there's no LLM key, no transcript, or a
 * run is in flight. Each run REPLACES the findings list — `setFindings` clears
 * the selection and any cached solutions (the model mints fresh ids per pass).
 */
export async function runAnalysis(opts?: { mode?: AppMode }): Promise<void> {
  const state = useStore.getState();
  const { settings, speakerNames, meetingContext } = state;
  const mode = opts?.mode ?? state.appMode;
  // REPLAY: honor the trim keep-window — trimmed segments are excluded from analysis.
  const segments =
    mode === "replay" ? state.segments.filter((s) => !isTrimmed(s, state.replayTrim)) : state.segments;

  if (analysisBusy) return;
  if (!hasProviderKey(settings)) return;
  if (!segments.some((s) => s.isFinal && s.text.trim())) return;

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
    });
    useStore.getState().setFindings(events);
    useStore.getState().setAnalysisStatus("done");
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
 * LIVE background engine: while recording, optionally auto-run the analysis on an
 * interval, and auto-check the TODO agenda checklist. Mount once at the root.
 * Replaces the old `useEvaluationEngine`; the TODO auto-check is preserved here
 * since the agenda checklist is a LIVE-only concern.
 */
export function useAnalysisEngine() {
  const meetingStatus = useStore((s) => s.meetingStatus);
  const lastRun = useRef<{ analysis: number; todos: number }>({ analysis: 0, todos: 0 });
  const todoBusy = useRef(false);

  useEffect(() => {
    if (meetingStatus !== "recording") return;

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
    };

    const interval = setInterval(tick, 3000);
    return () => clearInterval(interval);
  }, [meetingStatus]);
}
