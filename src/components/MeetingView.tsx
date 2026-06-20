import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { TranscriptPanel } from "./TranscriptPanel";
import { SpeakerBar } from "./SpeakerBar";
import { useStore, transcriptAsText } from "../lib/store";
import { useI18n } from "../i18n";
import { Button } from "@/components/ui/button";

/** Build a markdown record of the meeting: context, transcript, flagged evals. */
function buildMarkdown(): string {
  const { segments, evaluations, speakerNames, meetingContext } = useStore.getState();
  const now = new Date();
  const lines = [`# Parley meeting — ${now.toLocaleString()}`, ""];
  if (meetingContext.trim()) {
    lines.push(`**Context:** ${meetingContext.trim()}`, "");
  }
  const flagged = evaluations.filter((e) => e.status === "flag" && e.result);
  if (flagged.length) {
    lines.push("## Flags", "");
    for (const e of flagged) {
      lines.push(`- **${e.name}** (${e.result!.severity}): ${e.result!.summary}`);
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
      <SpeakerBar />
      <div className="min-h-0 flex-1">
        <TranscriptPanel />
      </div>
    </div>
  );
}
