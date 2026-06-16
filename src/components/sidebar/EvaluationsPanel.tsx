import { RefreshCw } from "lucide-react";
import { useStore } from "../../lib/store";
import { runAllEvaluations } from "../../lib/evaluations/engine";
import { hasProviderKey } from "../../lib/ai/settings";
import { useI18n } from "../../i18n";
import { EvaluationCard } from "./EvaluationCard";
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

const PROVIDER_LABEL = { anthropic: "Claude", openrouter: "OpenRouter", groq: "Groq" } as const;

export function EvaluationsPanel() {
  const { t } = useI18n();
  const evaluations = useStore((s) => s.evaluations);
  const templates = useStore((s) => s.settings.evalTemplates);
  const provider = useStore((s) => s.settings.provider);
  const keyMissing = useStore((s) => !hasProviderKey(s.settings));
  const updateSettings = useStore((s) => s.updateSettings);
  const autoEval = useStore((s) => s.autoEval);
  const autoEvalSec = useStore((s) => s.autoEvalSec);
  const setAutoEval = useStore((s) => s.setAutoEval);
  const setAutoEvalSec = useStore((s) => s.setAutoEvalSec);
  const running = useStore((s) => s.evaluations.some((e) => e.status === "running"));

  function applyTemplate(id: string) {
    const tpl = templates.find((t) => t.id === id);
    if (tpl) updateSettings({ evaluations: tpl.evals.map((e) => ({ ...e })) });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-xs font-medium">{t("evaluations.title")}</span>
        <Select value="" onValueChange={applyTemplate}>
          <SelectTrigger size="sm" className="ml-auto h-7 w-[150px] text-[11px]">
            <SelectValue placeholder={t("evaluations.applyTemplate")} />
          </SelectTrigger>
          <SelectContent>
            {templates.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-2 px-3 py-2">
        <Button
          variant="default"
          size="sm"
          className="h-7 px-2.5 text-[11px]"
          disabled={running}
          onClick={() => void runAllEvaluations()}
        >
          <RefreshCw className={`size-3 ${running ? "animate-spin" : ""}`} />
          {t("evaluations.runAll")}
        </Button>
        {/* Auto: re-run the whole set every N seconds while recording. */}
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={autoEval}
            onChange={(e) => setAutoEval(e.target.checked)}
            className="size-3.5 accent-primary"
          />
          {t("evaluations.autoEvery")}
          <Input
            type="number"
            value={autoEvalSec}
            onChange={(e) => setAutoEvalSec(Number(e.target.value))}
            className="h-6 w-12 px-1 text-center text-[11px]"
            disabled={!autoEval}
          />
          {t("evaluations.autoSeconds")}
        </label>
      </div>

      {keyMissing && (
        <div className="mx-3 mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-300">
          {t("evaluations.missingKey", { provider: PROVIDER_LABEL[provider] })}
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 px-3 pb-3">
          {evaluations.map((e) => (
            <EvaluationCard key={e.id} evaluation={e} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
