import { lazy, Suspense } from "react";
import { useStore } from "../../lib/store";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";

const AskPanel = lazy(() => import("./AskPanel").then((module) => ({ default: module.AskPanel })));
const EvaluationsPanel = lazy(() =>
  import("./EvaluationsPanel").then((module) => ({ default: module.EvaluationsPanel }))
);
const TodosPanel = lazy(() =>
  import("./TodosPanel").then((module) => ({ default: module.TodosPanel }))
);

export function Sidebar() {
  const flagged = useStore((s) =>
    s.evaluations.filter((e) => e.status === "flag").length
  );
  const todoOpen = useStore((s) => s.todos.filter((t) => !t.done).length);

  return (
    <aside className="flex h-full min-h-0 flex-col border-l">
      <Tabs defaultValue="ask" className="flex h-full min-h-0 flex-col gap-0">
        <div className="px-3 pt-2.5">
          <TabsList className="w-full">
            <TabsTrigger value="ask">Ask</TabsTrigger>
            <TabsTrigger value="evals" className="gap-1.5">
              Evals
              {flagged > 0 && (
                <Badge variant="destructive" className="h-4 min-w-4 px-1 text-[10px]">
                  {flagged}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="todos" className="gap-1.5">
              TODO
              {todoOpen > 0 && (
                <Badge variant="secondary" className="h-4 min-w-4 px-1 text-[10px]">
                  {todoOpen}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="ask" className="min-h-0 flex-1 outline-none">
          <Suspense fallback={null}>
            <AskPanel />
          </Suspense>
        </TabsContent>
        <TabsContent value="evals" className="min-h-0 flex-1 outline-none">
          <Suspense fallback={null}>
            <EvaluationsPanel />
          </Suspense>
        </TabsContent>
        <TabsContent value="todos" className="min-h-0 flex-1 outline-none">
          <Suspense fallback={null}>
            <TodosPanel />
          </Suspense>
        </TabsContent>
      </Tabs>
    </aside>
  );
}
