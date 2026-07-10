import { lazy, Suspense } from "react";
import { useI18n } from "../../i18n";

const TodosPanel = lazy(() =>
  import("../sidebar/TodosPanel").then((m) => ({ default: m.TodosPanel }))
);

/**
 * The LIVE right rail: accumulated STATE of the conversation (总体设计 §03/§04).
 * v1 carries the goals section (the todo agenda's new home); the meeting-type
 * intelligence templates (negotiation numbers ledger, sales objection tracker,
 * partnership leverage map) land here next — each as another section.
 */
export function IntelligenceBoard() {
  const { t } = useI18n();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-3 pt-2.5 pb-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("board.title")}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <Suspense fallback={null}>
          <TodosPanel />
        </Suspense>
      </div>
      <p className="shrink-0 border-t px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        {t("board.upcoming")}
      </p>
    </div>
  );
}
