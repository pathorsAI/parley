import { useEffect, useRef } from "react";
import { useStore, visibleSegments } from "../store";
import { hasProviderKey } from "../ai/settings";
import { log } from "../log";

let evalBusy = false;

/**
 * Run the WHOLE evaluation set in a single batched model call and write the
 * results back into the store. Used by the "Run all" button and the auto loop.
 * Skips silently if there's no LLM key, no transcript, or a run is in flight.
 */
export async function runAllEvaluations(): Promise<void> {
  const state = useStore.getState();
  const { settings, speakerNames, evaluations, setAllEvalStatus, setEvalResult, setEvalStatus } = state;
  // In replay mode this masks the transcript to the current playhead, so a re-run
  // judges only what had been said by that moment.
  const segments = visibleSegments(state);
  if (evalBusy) return log.debug("evals: skipped", { reason: "busy" });
  if (!hasProviderKey(settings)) return log.debug("evals: skipped", { reason: "no key" });
  if (evaluations.length === 0) return;
  if (!segments.some((s) => s.isFinal && s.text.trim()))
    return log.debug("evals: skipped", { reason: "no transcript" });

  evalBusy = true;
  state.setEvalError(null);
  setAllEvalStatus("running");
  try {
    log.info("evals: run all", { evals: evaluations.length, segments: segments.length });
    const { runAllEvaluations: run } = await import("../ai/evaluations");
    const map = await run({ settings, segments, evals: evaluations, names: speakerNames });
    for (const e of useStore.getState().evaluations) {
      if (map[e.id]) setEvalResult(e.id, map[e.id]);
      else setEvalStatus(e.id, "ok");
    }
    log.info("evals: run all ok", { evals: evaluations.length });
  } catch (err) {
    log.error("evals: run all failed", { error: String(err) });
    const { describeAiError } = await import("../ai/errors");
    useStore.getState().setEvalError(describeAiError(err));
    setAllEvalStatus("error");
  } finally {
    evalBusy = false;
  }
}

/**
 * Background engine: while recording, optionally auto-rerun the whole evaluation
 * set on an interval, and auto-check the TODO checklist. Mount once at the root.
 */
export function useEvaluationEngine() {
  const meetingStatus = useStore((s) => s.meetingStatus);
  const lastRun = useRef<{ evals: number; todos: number }>({ evals: 0, todos: 0 });
  const todoBusy = useRef(false);

  useEffect(() => {
    if (meetingStatus !== "recording") return;

    const tick = () => {
      const { autoEval, autoEvalSec, todos, settings, segments, speakerNames, markTodosDone } =
        useStore.getState();
      const now = Date.now();

      if (autoEval && now >= lastRun.current.evals + autoEvalSec * 1000) {
        lastRun.current.evals = now;
        void runAllEvaluations();
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
        log.debug("todos: auto-check");
        import("../ai/todos")
          .then(({ checkTodos }) => checkTodos({ settings, segments, todos, names: speakerNames }))
          .then((ids) => {
            if (ids.length) {
              markTodosDone(ids);
              log.info("todos: marked done", { count: ids.length });
            }
          })
          .catch((e) => log.error("todos: auto-check failed", { error: String(e) }))
          .finally(() => {
            todoBusy.current = false;
          });
      }
    };

    const interval = setInterval(tick, 3000);
    return () => clearInterval(interval);
  }, [meetingStatus]);
}
