import { useState } from "react";
import { FileText, RefreshCw, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useStore } from "../../lib/store";
import { runAllEvaluations } from "../../lib/evaluations/engine";
import { generatePostMeetingReport } from "../../lib/ai/report";
import { hasProviderKey } from "../../lib/ai/settings";
import { PROVIDER_BY_ID } from "../../lib/ai/providers";
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

export function EvaluationsPanel() {
  const { t } = useI18n();
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
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

  const [report, setReport] = useState("");
  const [reportStatus, setReportStatus] = useState<"idle" | "generating" | "done">("idle");

  function applyTemplate(id: string) {
    const tpl = templates.find((t) => t.id === id);
    if (!tpl) return;
    updateSettings({ evaluations: tpl.evals.map((e) => ({ ...e })) });
    setSelectedTemplateId(id);
  }

  async function generateReport() {
    const s = useStore.getState();
    setReport("");
    setReportStatus("generating");
    try {
      await generatePostMeetingReport({
        settings: s.settings,
        segments: s.segments,
        evaluations: s.evaluations,
        todos: s.todos,
        names: s.speakerNames,
        meetingContext: s.meetingContext,
        onDelta: (chunk) => setReport((prev) => prev + chunk),
      });
    } catch (e) {
      console.error("[report] failed", e);
    } finally {
      setReportStatus("done");
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-xs font-medium">{t("evaluations.title")}</span>
        <Select value={templates.some((tpl) => tpl.id === selectedTemplateId) ? selectedTemplateId : ""} onValueChange={applyTemplate}>
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
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2.5 text-[11px]"
          disabled={reportStatus === "generating" || keyMissing}
          onClick={() => void generateReport()}
          title={t("evaluations.reportHint")}
        >
          <FileText className={`size-3 ${reportStatus === "generating" ? "animate-pulse" : ""}`} />
          {t("evaluations.report")}
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
          {t("evaluations.missingKey", { provider: PROVIDER_BY_ID[provider]?.label ?? provider })}
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 px-3 pb-3">
          {reportStatus !== "idle" && (
            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs font-semibold tracking-tight">
                  {t("evaluations.report")}
                  {reportStatus === "generating" && (
                    <span className="ml-2 font-normal text-muted-foreground">{t("evaluations.reportGenerating")}</span>
                  )}
                </span>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setReportStatus("idle");
                    setReport("");
                  }}
                >
                  <X className="size-3.5" />
                </button>
              </div>
              <div className="prose prose-invert prose-sm max-w-none select-text text-foreground prose-p:my-1.5 prose-headings:mb-1 prose-headings:mt-3 prose-ul:my-1.5 prose-li:my-0.5">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{report || "…"}</ReactMarkdown>
              </div>
            </div>
          )}
          {evaluations.map((e) => (
            <EvaluationCard key={e.id} evaluation={e} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
