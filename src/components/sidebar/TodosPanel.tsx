import { useState } from "react";
import { Check, Square, X, Plus, Sparkles } from "lucide-react";
import { useStore } from "../../lib/store";
import { hasProviderKey } from "../../lib/ai/settings";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { TodoItem } from "../../lib/types";

/**
 * Meeting checklist. Two faces of the same list (S17: todos keep only ACTION
 * items — info-gathering lives on the board slots):
 * - TodosPanel: the whole intelligence rail for GENERAL meetings, with the
 *   manual AI check (general has no extraction pass to ride).
 * - TodosSection: a flat section inside the typed board — auto-checked by the
 *   unified 30s extraction, so no AI button.
 */

function TodoRow({ todo }: Readonly<{ todo: TodoItem }>) {
  const toggleTodo = useStore((s) => s.toggleTodo);
  const removeTodo = useStore((s) => s.removeTodo);
  return (
    <div className="group flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-muted/50">
      <button
        type="button"
        onClick={() => toggleTodo(todo.id)}
        className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
      >
        {todo.done ? <Check className="size-4 text-emerald-500" /> : <Square className="size-4" />}
      </button>
      <span
        className={`flex-1 text-sm leading-snug ${todo.done ? "text-muted-foreground line-through" : ""}`}
      >
        {todo.text}
      </span>
      <button
        type="button"
        onClick={() => removeTodo(todo.id)}
        className="shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground hover:!text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function AddForm({ compact = false }: Readonly<{ compact?: boolean }>) {
  const { t } = useI18n();
  const addTodo = useStore((s) => s.addTodo);
  const [input, setInput] = useState("");
  function add(e: React.FormEvent) {
    e.preventDefault();
    addTodo(input);
    setInput("");
  }
  return (
    <form
      onSubmit={add}
      className={compact ? "flex items-center gap-2 pt-1" : "flex items-center gap-2 border-t p-2.5"}
    >
      <Input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={t("todos.addPlaceholder")}
        className={compact ? "h-7 text-xs" : "h-8 text-sm"}
      />
      <Button
        type="submit"
        size="icon"
        className={compact ? "size-7 shrink-0" : "size-8 shrink-0"}
        disabled={!input.trim()}
      >
        <Plus className="size-4" />
      </Button>
    </form>
  );
}

/** The board-rail section (scenario meetings, 呼吸版): folded to one line —
 *  count + chevron — until opened; action items only, auto-checked by the
 *  unified extraction pass. */
export function TodosSection() {
  const { t } = useI18n();
  const todos = useStore((s) => s.todos);
  const [open, setOpen] = useState(false);
  const done = todos.filter((x) => x.done).length;
  return (
    <div className="flex flex-col gap-1 border-t pt-2">
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        className="flex items-baseline gap-2 text-left"
      >
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          {t("board.todos.title")}
        </span>
        <span className="text-[10px] text-muted-foreground/70">
          {todos.length > 0 ? t("todos.doneCount", { done, total: todos.length }) : t("todos.noItems")}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground/70">
          ＋ {open ? "▴" : "▾"}
        </span>
      </button>
      {open && (
        <>
          {todos.map((x) => (
            <TodoRow key={x.id} todo={x} />
          ))}
          <AddForm compact />
        </>
      )}
    </div>
  );
}

/** The whole-rail panel (GENERAL meetings). */
export function TodosPanel() {
  const { t } = useI18n();
  const todos = useStore((s) => s.todos);
  const [checking, setChecking] = useState(false);

  const done = todos.filter((x) => x.done).length;

  async function aiUpdate() {
    const state = useStore.getState();
    const { settings, todos: cur, speakerNames, markTodosDone } = state;
    if (!hasProviderKey(settings, "realtime") || cur.length === 0) return;
    // TODO agenda auto-check is LIVE-only — use the full live transcript.
    const { segments } = state;
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
        <span className="shrink-0">
          {todos.length > 0 ? t("todos.doneCount", { done, total: todos.length }) : t("todos.noItems")}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-6 shrink-0 px-2 text-[11px]"
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
            todos.map((x) => <TodoRow key={x.id} todo={x} />)
          )}
        </div>
      </ScrollArea>

      <AddForm />
    </div>
  );
}
