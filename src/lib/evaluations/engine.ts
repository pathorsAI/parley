import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { hasProviderKey } from "../ai/settings";

/**
 * Run one evaluation against the current store state and write its status/result
 * back into the store. Shared by manual rerun buttons and the auto engine.
 * Skips silently if there's no LLM key or no transcript yet.
 */
export async function triggerEvaluation(id: string): Promise<void> {
  const { settings, segments, speakerNames, evaluations, setEvalStatus, setEvalResult } =
    useStore.getState();
  const evaluation = evaluations.find((e) => e.id === id);
  if (!evaluation || evaluation.status === "running") return;
  if (!hasProviderKey(settings)) return;
  if (!segments.some((s) => s.isFinal && s.text.trim())) return;

  setEvalStatus(id, "running");
  try {
    const { runEvaluation } = await import("../ai/evaluations");
    const result = await runEvaluation({ settings, evaluation, segments, names: speakerNames });
    setEvalResult(id, result);
  } catch (err) {
    console.error(`[eval:${id}]`, err);
    setEvalStatus(id, "error");
  }
}

/**
 * Background engine: while a meeting is recording, rerun each `auto` evaluation
 * on its own interval. Mount once near the app root.
 */
export function useEvaluationEngine() {
  const meetingStatus = useStore((s) => s.meetingStatus);
  // Track the last run time per evaluation (and the todo checker) across ticks.
  const lastRun = useRef<Record<string, number>>({});
  const todoBusy = useRef(false);

  useEffect(() => {
    if (meetingStatus !== "recording") return;

    const tick = () => {
      const { evaluations, todos, settings, segments, speakerNames, markTodosDone } =
        useStore.getState();
      const now = Date.now();
      for (const e of evaluations) {
        if (e.mode !== "auto" || !e.autoEverySec) continue;
        const due = (lastRun.current[e.id] ?? 0) + e.autoEverySec * 1000;
        if (now >= due && e.status !== "running") {
          lastRun.current[e.id] = now;
          void triggerEvaluation(e.id);
        }
      }

      // Auto-check the TODO checklist every ~45s while recording.
      const todoDue = (lastRun.current.__todos ?? 0) + 45_000;
      if (
        now >= todoDue &&
        !todoBusy.current &&
        hasProviderKey(settings) &&
        todos.some((t) => !t.done)
      ) {
        lastRun.current.__todos = now;
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

    // Check every 5s which autos are due; their own intervals gate actual runs.
    const interval = setInterval(tick, 5000);
    return () => clearInterval(interval);
  }, [meetingStatus]);
}
