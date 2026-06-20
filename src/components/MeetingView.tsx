import { useEffect, useState } from "react";
import { Copy, Check } from "lucide-react";
import { TranscriptPanel } from "./TranscriptPanel";
import { SpeakerBar } from "./SpeakerBar";
import { AnalysisTimeline } from "./analysis/AnalysisTimeline";
import { selectAndSeek } from "./analysis/useAnalysis";
import { runAnalysis } from "../lib/analysis/engine";
import { useStore, transcriptAsText, formatClock } from "../lib/store";
import { useI18n } from "../i18n";
import { Button } from "@/components/ui/button";

/** Build a markdown record of the meeting: context, transcript, analysis findings. */
function buildMarkdown(): string {
  const { segments, findings, speakerNames, meetingContext } = useStore.getState();
  const now = new Date();
  const lines = [`# Parley meeting — ${now.toLocaleString()}`, ""];
  if (meetingContext.trim()) {
    lines.push(`**Context:** ${meetingContext.trim()}`, "");
  }
  if (findings.length) {
    lines.push("## Findings", "");
    for (const f of findings) {
      lines.push(`- [${formatClock(f.atMs)}] **${f.title}** (${f.side}, ${f.severity}): ${f.detail}`);
    }
    lines.push("");
  }
  lines.push("## Transcript", "", transcriptAsText(segments, speakerNames) || "(empty)", "");
  return lines.join("\n");
}

export function MeetingView() {
  const { t } = useI18n();
  const hasSegments = useStore((s) => s.segments.some((x) => x.isFinal && x.text.trim()));
  const [copied, setCopied] = useState(false);

  // Shared analysis state — the live timeline band aligned to elapsed meeting time.
  const findings = useStore((s) => s.findings);
  const analysisStatus = useStore((s) => s.analysisStatus);
  const analysisError = useStore((s) => s.analysisError);
  const selectedId = useStore((s) => s.selectedFindingId);
  const highlightMs = useStore((s) => s.highlightMs);
  const setHighlightMs = useStore((s) => s.setHighlightMs);
  const meetingStartedAt = useStore((s) => s.meetingStartedAt);
  const recording = useStore((s) => s.meetingStatus === "recording");
  const maxEndMs = useStore((s) => s.segments.reduce((m, x) => Math.max(m, x.endMs), 0));

  // Tick once a second so the axis right-edge advances while recording.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [recording]);

  const elapsedMs = recording && meetingStartedAt ? nowMs - meetingStartedAt : maxEndMs;
  const axisMaxMs = Math.max(elapsedMs, maxEndMs, 1);
  const showTimeline = findings.length > 0 || analysisStatus === "running" || analysisStatus === "error";

  async function copy() {
    try {
      await navigator.clipboard.writeText(buildMarkdown());
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (e) {
      console.error("copy transcript failed", e);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-5">
        <span className="text-xs font-medium text-foreground">{t("meeting.transcript")}</span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={!hasSegments} onClick={copy}>
            {copied ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
            {copied ? t("meeting.copied") : t("meeting.copy")}
          </Button>
        </div>
      </div>
      {showTimeline && (
        <AnalysisTimeline
          findings={findings}
          status={analysisStatus}
          error={analysisError}
          axisMaxMs={axisMaxMs}
          playheadMs={highlightMs ?? elapsedMs}
          selectedId={selectedId}
          onSelect={(e) => selectAndSeek(e, setHighlightMs)}
          onReanalyze={() => void runAnalysis({ mode: "live" })}
        />
      )}
      <SpeakerBar />
      <div className="min-h-0 flex-1">
        <TranscriptPanel />
      </div>
    </div>
  );
}
