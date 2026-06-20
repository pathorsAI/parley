import { lazy, Suspense } from "react";
import { useStore } from "../lib/store";
import { useI18n } from "../i18n";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";

const AskPanel = lazy(() => import("./sidebar/AskPanel").then((m) => ({ default: m.AskPanel })));
const TodosPanel = lazy(() => import("./sidebar/TodosPanel").then((m) => ({ default: m.TodosPanel })));

/** LIVE center pane: the primary interactive surfaces — Ask and the TODO agenda. */
export function WorkPanel() {
  const { t } = useI18n();
  const todoOpen = useStore((s) => s.todos.filter((t) => !t.done).length);

  return (
    <Tabs defaultValue="ask" className="flex h-full min-h-0 flex-col gap-0">
      <div className="px-3 pt-2.5">
        <TabsList className="w-full">
          <TabsTrigger value="ask">{t("work.ask")}</TabsTrigger>
          <TabsTrigger value="todos" className="gap-1.5">
            {t("work.todos")}
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
      <TabsContent value="todos" className="min-h-0 flex-1 outline-none">
        <Suspense fallback={null}>
          <TodosPanel />
        </Suspense>
      </TabsContent>
    </Tabs>
  );
}
