import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { hasProviderKey } from "../ai/settings";

let evalBusy = false;

/**
 * Run the WHOLE evaluation set in a single batched model call and write the
 * results back into the store. Used by the "Run all" button and the auto loop.
 * Skips silently if there's no LLM key, no transcript, or a run is in flight.
 */
export async function runAllEvaluations(): Promise<void> {
  const { settings, segments, speakerNames, evaluations, setAllEvalStatus, setEvalResult, setEvalStatus } =
    useStore.getState();
  if (evalBusy) return;
  if (!hasProviderKey(settings)) return;
  if (evaluations.length === 0) return;
  if (!segments.some((s) => s.isFinal && s.text.trim())) return;

  evalBusy = true;
  setAllEvalStatus("running");
  try {
    const { runAllEvaluations: run } = await import("../ai/evaluations");
    const map = await run({ settings, segments, evals: evaluations, names: speakerNames });
    for (const e of useStore.getState().evaluations) {
      if (map[e.id]) setEvalResult(e.id, map[e.id]);
      else setEvalStatus(e.id, "ok");
    }
  } catch (err) {
    console.error("[evals]", err);
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
