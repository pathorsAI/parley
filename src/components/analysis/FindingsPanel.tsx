import type { ReactNode } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { useStore } from "../../lib/store";
import { runAnalysis } from "../../lib/analysis/engine";
import { missingProviderRequirement, providerGateKey } from "../../lib/ai/settings";
import { PROVIDER_BY_ID } from "../../lib/ai/providers";
import { useI18n } from "../../i18n";
import { log } from "../../lib/log";
import { FindingRow } from "./FindingRow";
import { openSolution, selectAndSeek } from "./useAnalysis";
import { DeliveryPanel } from "../delivery/DeliveryPanel";
import { useStudyArtifactDisplay } from "../../lib/analysis/studyPipeline";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
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
  // null = configured. Otherwise the i18n key naming what's still missing.
  const gate = useStore((s) =>
    providerGateKey(missingProviderRequirement(s.settings, "realtime"), "evaluations.missingKey")
  );
  const autoAnalyze = useStore((s) => s.autoAnalyze);
  const autoAnalyzeSec = useStore((s) => s.autoAnalyzeSec);
  const setAutoAnalyze = useStore((s) => s.setAutoAnalyze);
  const setAutoAnalyzeSec = useStore((s) => s.setAutoAnalyzeSec);
  const running = analysisStatus === "running";

  let list: ReactNode;
  if (mode === "replay" && findings.length === 0) {
    // Replay's one analysis pass: placeholder rows while it is coming, the
    // empty message only once it has run.
    list = <ReplayFindingsPending />;
  } else if (findings.length === 0 && !running) {
    list = <p className="px-1 pt-6 text-center text-xs text-muted-foreground">{t("analysis.emptyLive")}</p>;
  } else {
    list = (
      // Rows are hairline-separated list items, not boxed cards — bleed the
      // list to the pane edges so the row hover/selection spans full width.
      <ul className="-mx-3 flex flex-col">
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
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-xs font-semibold">{t("timeline.title")}</span>
        {findings.length > 0 && (
          <span className="text-[11px] tabular-nums text-muted-foreground">{findings.length}</span>
        )}
        <MeetingKindPicker className="ml-auto h-7 w-[150px]" />
      </div>

      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        {mode === "live" && (
          <Button
            variant="secondary"
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

      {/* A replay that already has findings (the sample, or an entry analysed
          elsewhere) has nothing to gate: the banner would nag about a key the
          page is not going to use. */}
      {gate && !(mode === "replay" && findings.length > 0) && (
        <div className="mx-3 mb-2 rounded-md border border-warning-border bg-warning px-2.5 py-1.5 text-[11px] text-warning-foreground">
          {t(gate, { provider: PROVIDER_BY_ID[provider]?.label ?? provider })}
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 px-3 pb-3">
          {/* Ambient delivery meters, above the findings — LIVE only (the study
              report page owns the post-call delivery scorecard). */}
          {mode === "live" && <DeliveryPanel mode="live" />}

          {list}
        </div>
      </ScrollArea>
    </div>
  );
}

/** Replay with no findings yet. A child component so the pipeline subscription
 *  only exists in the study tense — the live pane never mounts it. */
function ReplayFindingsPending() {
  const { t } = useI18n();
  const display = useStudyArtifactDisplay("findings");
  if (display !== "running" && display !== "queued") {
    return <p className="px-1 pt-6 text-center text-xs text-muted-foreground">{t("timeline.empty")}</p>;
  }
  return (
    <ul className="-mx-3 flex flex-col" aria-busy="true">
      <li className="sr-only" role="status">
        {display === "running" ? t("timeline.analyzing") : t("studyGen.status.queued")}
      </li>
      {["w-2/5", "w-1/2", "w-1/3", "w-3/5"].map((w) => (
        <FindingRowSkeleton key={w} titleWidth={w} />
      ))}
    </ul>
  );
}

/** A FindingRow-shaped placeholder: severity dot, time + title line, a two-line
 *  detail, and the "how to reply" link — same padding and divider. */
function FindingRowSkeleton({ titleWidth }: Readonly<{ titleWidth: string }>) {
  return (
    <li className="border-b border-border px-4 py-3 last:border-b-0" aria-hidden="true">
      <div className="flex items-start gap-2">
        <Skeleton className="mt-1.5 size-[7px] shrink-0 rounded-full" />
        <div className="min-w-0 flex-1">
          <div className="flex h-5 items-center gap-1.5">
            <Skeleton className="h-3 w-8" />
            <Skeleton className={`h-3.5 ${titleWidth}`} />
          </div>
          <div className="mt-0.5 flex flex-col gap-1.5 py-1">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        </div>
      </div>
      <Skeleton className="mt-2 mb-0.5 ml-[15px] h-3 w-16" />
    </li>
  );
}
