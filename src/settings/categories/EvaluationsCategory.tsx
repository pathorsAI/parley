import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { EvalDef } from "../../lib/types";
import { useI18n } from "../../i18n";
import { Section } from "../fields";
import type { SettingsPanelProps } from "./types";

/** Settings › Evaluations: the template library and the active set. The new
 *  template's name is kept by the shell, so a half-typed name survives
 *  switching panels. */
export function EvaluationsCategory({
  settings,
  patch,
  newTplName,
  setNewTplName,
}: Readonly<SettingsPanelProps & { newTplName: string; setNewTplName: (name: string) => void }>) {
  const { t } = useI18n();
  return (
    <Section title={t("settings.evaluations.title")}>
      {/* Template library: apply a preset set, or save the current set. */}
      <div className="flex flex-col gap-2 rounded-lg border p-3">
        <p className="text-[11px] font-medium text-muted-foreground">{t("settings.evaluations.templateHelp")}</p>
        <div className="flex flex-col gap-1.5">
          {settings.evalTemplates.map((tpl) => (
            <div key={tpl.id} className="flex items-center gap-2">
              <span className="flex-1 truncate text-sm">
                {tpl.name}
                <span className="ml-1.5 text-[10px] text-muted-foreground">
                  {t("settings.evaluations.templateMeta", {
                    type: tpl.builtin ? t("common.builtin") : t("common.custom"),
                    count: tpl.evals.length,
                  })}
                </span>
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() =>
                  patch({ evaluations: tpl.evals.map((e) => ({ ...e })) })
                }
              >
                {t("common.apply")}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => patch({ evalTemplates: settings.evalTemplates.filter((t) => t.id !== tpl.id) })}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
        <div className="mt-1 flex items-center gap-2">
          <Input
            value={newTplName}
            onChange={(e) => setNewTplName(e.target.value)}
            placeholder={t("settings.evaluations.newTemplateName")}
            className="h-7 text-xs"
          />
          <Button
            variant="secondary"
            size="sm"
            className="h-7 shrink-0 px-2 text-[11px]"
            disabled={!newTplName.trim()}
            onClick={() => {
              const name = newTplName.trim();
              // Overwrite a custom template with the same name, else add new.
              const evals = settings.evaluations.map((e) => ({ ...e }));
              const exists = settings.evalTemplates.find((t) => !t.builtin && t.name === name);
              const next = exists
                ? settings.evalTemplates.map((t) => (t.id === exists.id ? { ...t, evals } : t))
                : [...settings.evalTemplates, { id: crypto.randomUUID(), name, evals }];
              patch({ evalTemplates: next });
              setNewTplName("");
            }}
          >
            {t("settings.evaluations.saveTemplate")}
          </Button>
        </div>
      </div>

      {/* Active set used in meetings. */}
      <p className="text-[11px] text-muted-foreground">
        {t("settings.evaluations.activeHelp")}
      </p>
      <div className="flex flex-col gap-4">
        {settings.evaluations.map((ev) => (
          <EvalEditor
            key={ev.id}
            ev={ev}
            onChange={(p) => patch({ evaluations: settings.evaluations.map((x) => (x.id === ev.id ? { ...x, ...p } : x)) })}
            onDelete={() => patch({ evaluations: settings.evaluations.filter((x) => x.id !== ev.id) })}
          />
        ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() =>
          patch({
            evaluations: [
              ...settings.evaluations,
              { id: crypto.randomUUID(), name: t("settings.evaluations.defaultNewName"), description: "", prompt: "" },
            ],
          })
        }
      >
        <Plus className="size-3.5" /> {t("settings.evaluations.newEvaluation")}
      </Button>
    </Section>
  );
}

function EvalEditor({
  ev,
  onChange,
  onDelete,
}: Readonly<{
  ev: EvalDef;
  onChange: (p: Partial<EvalDef>) => void;
  onDelete: () => void;
}>) {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Input value={ev.name} onChange={(e) => onChange({ name: e.target.value })} placeholder={t("settings.evaluations.namePlaceholder")} className="h-8 font-medium" />
        <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={onDelete}>
          <Trash2 className="size-4" />
        </Button>
      </div>
      <Input value={ev.description} onChange={(e) => onChange({ description: e.target.value })} placeholder={t("settings.evaluations.descriptionPlaceholder")} className="h-8 text-xs" />
      <Textarea value={ev.prompt} onChange={(e) => onChange({ prompt: e.target.value })} placeholder={t("settings.evaluations.promptPlaceholder")} rows={3} className="max-h-40 overflow-y-auto resize-none text-xs" />
    </div>
  );
}
