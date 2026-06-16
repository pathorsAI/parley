import { useState } from "react";
import { Check, Square, X, Plus, Sparkles } from "lucide-react";
import { useStore } from "../../lib/store";
import { hasProviderKey } from "../../lib/ai/settings";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Meeting checklist. Apply a template (from Settings) to load items, add/check/
 * remove ad-hoc, and let the AI auto-check items that have been covered.
 */
export function TodosPanel() {
  const { t } = useI18n();
  const todos = useStore((s) => s.todos);
  const addTodo = useStore((s) => s.addTodo);
  const toggleTodo = useStore((s) => s.toggleTodo);
  const removeTodo = useStore((s) => s.removeTodo);
  const templates = useStore((s) => s.settings.todoTemplates);
  const applyTodoTemplate = useStore((s) => s.applyTodoTemplate);
  const [input, setInput] = useState("");
  const [checking, setChecking] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");

  const done = todos.filter((t) => t.done).length;

  async function aiUpdate() {
    const { settings, segments, todos: cur, speakerNames, markTodosDone } = useStore.getState();
    if (!hasProviderKey(settings) || cur.length === 0) return;
    setChecking(true);
    try {
      const { checkTodos } = await import("../../lib/ai/todos");
      const ids = await checkTodos({ settings, segments, todos: cur, names: speakerNames });
      if (ids.length) markTodosDone(ids);
    } catch (e) {
      console.error("checkTodos failed", e);
    } finally {
      setChecking(false);
    }
  }

  function add(e: React.FormEvent) {
    e.preventDefault();
    addTodo(input);
    setInput("");
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
        <span className="shrink-0">
          {todos.length > 0 ? t("todos.doneCount", { done, total: todos.length }) : t("todos.noItems")}
        </span>
        <Select
          value={templates.some((tpl) => tpl.id === selectedTemplateId) ? selectedTemplateId : ""}
          onValueChange={(id) => {
            const template = templates.find((x) => x.id === id);
            if (!template) return;
            applyTodoTemplate(template.items);
            setSelectedTemplateId(id);
          }}
        >
          <SelectTrigger size="sm" className="ml-auto h-6 w-[140px] text-[11px]">
            <SelectValue placeholder={t("todos.applyTemplate")} />
          </SelectTrigger>
          <SelectContent>
            {templates.map((t) => (
              <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          className="h-6 shrink-0 px-2 text-[11px]"
          disabled={checking || todos.length === 0}
          onClick={aiUpdate}
          title={t("todos.aiTitle")}
        >
          <Sparkles className={`size-3 ${checking ? "animate-pulse" : ""}`} />
          AI
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1 px-3 pb-3">
          {todos.length === 0 ? (
            <p className="px-1 pt-6 text-center text-xs text-muted-foreground">
              {t("todos.empty")}
            </p>
          ) : (
            todos.map((t) => (
              <div key={t.id} className="group flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-muted/50">
                <button onClick={() => toggleTodo(t.id)} className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground">
                  {t.done ? <Check className="size-4 text-emerald-500" /> : <Square className="size-4" />}
                </button>
                <span className={`flex-1 text-sm leading-snug ${t.done ? "text-muted-foreground line-through" : ""}`}>
                  {t.text}
                </span>
                <button
                  onClick={() => removeTodo(t.id)}
                  className="shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground hover:!text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      </ScrollArea>

      <form onSubmit={add} className="flex items-center gap-2 border-t p-2.5">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("todos.addPlaceholder")}
          className="h-8 text-sm"
        />
        <Button type="submit" size="icon" className="size-8 shrink-0" disabled={!input.trim()}>
          <Plus className="size-4" />
        </Button>
      </form>
    </div>
  );
}
