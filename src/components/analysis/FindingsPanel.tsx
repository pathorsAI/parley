import { Loader2, Sparkles } from "lucide-react";
import { useStore } from "../../lib/store";
import { runAnalysis } from "../../lib/analysis/engine";
import { hasProviderKey } from "../../lib/ai/settings";
import { PROVIDER_BY_ID } from "../../lib/ai/providers";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import { FindingRow } from "./FindingRow";
import { openSolution, selectAndSeek } from "./useAnalysis";
import { DeliveryPanel } from "../delivery/DeliveryPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MeetingKindPicker } from "../MeetingKindPicker";

/**
 * The right-hand analysis pane, shared by both modes. Renders the findings list
 * (each row drills into "how it should have been done") and the meeting-kind
 * picker that decides how they are read. In LIVE it also surfaces the primary "Analyze" action (+ an optional
 * auto-interval) and the ambient delivery card; in REPLAY the analysis runs once
 * on load, so it just shows status — the debrief and delivery live on the study
 * report page now, not here.
 */
export function FindingsPanel({
  mode,
  onSeek,
}: Readonly<{
  mode: "live" | "replay";
  onSeek: (ms: number) => void;
}>) {
  const { t } = useI18n();
  const findings = useStore((s) => s.findings);
  const selectedId = useStore((s) => s.selectedFindingId);
  const analysisStatus = useStore((s) => s.analysisStatus);
  const provider = useStore((s) => s.settings.llmProviders.realtime);
  const keyMissing = useStore((s) => !hasProviderKey(s.settings, "realtime"));
  const autoAnalyze = useStore((s) => s.autoAnalyze);
  const autoAnalyzeSec = useStore((s) => s.autoAnalyzeSec);
  const setAutoAnalyze = useStore((s) => s.setAutoAnalyze);
  const setAutoAnalyzeSec = useStore((s) => s.setAutoAnalyzeSec);
  const running = analysisStatus === "running";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-xs font-medium">{t("timeline.title")}</span>
        <MeetingKindPicker className="ml-auto h-7 w-[150px]" />
      </div>

      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        {mode === "live" && (
          <Button
            variant="default"
            size="sm"
            className="h-7 px-2.5 text-[11px]"
            disabled={running}
            onClick={() => runAnalysis({ mode: "live" }).catch((error) => log.error("analysis: live run failed", { error: String(error) }))}
            title={t("analysis.hint")}
          >
            {running ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
            {running ? t("analysis.analyzing") : t("analysis.run")}
          </Button>
        )}
        {mode === "live" && (
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={autoAnalyze}
              onChange={(e) => setAutoAnalyze(e.target.checked)}
              className="size-3.5 accent-primary"
            />
            {t("evaluations.autoEvery")}
            <Input
              type="number"
              value={autoAnalyzeSec}
              onChange={(e) => setAutoAnalyzeSec(Number(e.target.value))}
              className="h-6 w-12 px-1 text-center text-[11px]"
              disabled={!autoAnalyze}
            />
            {t("evaluations.autoSeconds")}
          </label>
        )}
      </div>

      {keyMissing && (
        <div className="mx-3 mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-300">
          {t("evaluations.missingKey", { provider: PROVIDER_BY_ID[provider]?.label ?? provider })}
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 px-3 pb-3">
          {/* Ambient delivery meters, above the findings — LIVE only (the study
              report page owns the post-call delivery scorecard). */}
          {mode === "live" && <DeliveryPanel mode="live" />}

          {findings.length === 0 && analysisStatus !== "running" ? (
            <p className="px-1 pt-6 text-center text-xs text-muted-foreground">
              {mode === "live" ? t("analysis.emptyLive") : t("timeline.empty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {findings.map((f) => (
                <FindingRow
                  key={f.id}
                  event={f}
                  selected={selectedId === f.id}
                  onSelect={(e) => selectAndSeek(e, onSeek)}
                  onOpenSolution={(e) => openSolution(e, onSeek)}
                />
              ))}
            </ul>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
