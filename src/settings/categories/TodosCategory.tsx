import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { TodoTemplate } from "../../lib/types";
import { useI18n } from "../../i18n";
import { Section } from "../fields";
import type { SettingsPanelProps } from "./types";

/** Settings › To-dos: the agenda checklist templates. */
export function TodosCategory({ settings, patch }: Readonly<SettingsPanelProps>) {
  const { t } = useI18n();
  return (
    <Section title={t("settings.todos.title")}>
      <p className="text-[11px] text-muted-foreground">
        {t("settings.todos.help")}
      </p>
      <div className="flex flex-col gap-4">
        {settings.todoTemplates.map((tpl) => (
          <TodoTemplateEditor
            key={tpl.id}
            tpl={tpl}
            onChange={(p) => patch({ todoTemplates: settings.todoTemplates.map((x) => (x.id === tpl.id ? { ...x, ...p } : x)) })}
            onDelete={() => patch({ todoTemplates: settings.todoTemplates.filter((x) => x.id !== tpl.id) })}
          />
        ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() =>
          patch({
            todoTemplates: [
              ...settings.todoTemplates,
              { id: crypto.randomUUID(), name: t("settings.todos.defaultNewName"), items: [""] },
            ],
          })
        }
      >
        <Plus className="size-3.5" /> {t("settings.todos.addTemplate")}
      </Button>
    </Section>
  );
}

function TodoTemplateEditor({
  tpl,
  onChange,
  onDelete,
}: Readonly<{
  tpl: TodoTemplate;
  onChange: (p: Partial<TodoTemplate>) => void;
  onDelete: () => void;
}>) {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Input value={tpl.name} onChange={(e) => onChange({ name: e.target.value })} placeholder={t("settings.todos.templateName")} className="h-8 font-medium" />
        <span className="shrink-0 text-[10px] text-muted-foreground">{tpl.builtin ? t("common.builtin") : t("common.custom")}</span>
        <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={onDelete}>
          <Trash2 className="size-4" />
        </Button>
      </div>
      <div className="flex flex-col gap-1.5">
        {tpl.items.map((it, i) => (
          <div
            key={`${tpl.id}-${it}-${tpl.items.slice(0, i + 1).filter((item) => item === it).length}`}
            className="flex items-center gap-2"
          >
            <Input
              value={it}
              onChange={(e) => onChange({ items: tpl.items.map((x, j) => (j === i ? e.target.value : x)) })}
              placeholder={t("settings.todos.itemPlaceholder")}
              className="h-8 text-xs"
            />
            <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={() => onChange({ items: tpl.items.filter((_, j) => j !== i) })}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>
      <Button variant="ghost" size="sm" className="w-fit text-[11px]" onClick={() => onChange({ items: [...tpl.items, ""] })}>
        <Plus className="size-3.5" /> {t("settings.todos.addItem")}
      </Button>
    </div>
  );
}
