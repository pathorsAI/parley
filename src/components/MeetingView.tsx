import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, Check } from "lucide-react";
import { TranscriptPanel } from "./TranscriptPanel";
import { SpeakerBar } from "./SpeakerBar";
import { useStore, transcriptAsText } from "../lib/store";
import { isTauri } from "../lib/tauriEvents";
import { Button } from "@/components/ui/button";

/** Build a markdown record of the meeting: context, transcript, flagged evals. */
function buildMarkdown(): string {
  const { segments, evaluations, settings, speakerNames } = useStore.getState();
  const now = new Date();
  const lines = [`# Parley meeting — ${now.toLocaleString()}`, ""];
  if (settings.meetingContext.trim()) {
    lines.push(`**Context:** ${settings.meetingContext.trim()}`, "");
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
  const hasSegments = useStore((s) => s.segments.some((x) => x.isFinal && x.text.trim()));
  const [saved, setSaved] = useState<string | null>(null);

  async function save() {
    if (!isTauri()) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    try {
      const path = await invoke<string>("save_transcript", {
        filename: `parley-${stamp}.md`,
        contents: buildMarkdown(),
      });
      setSaved(path);
      setTimeout(() => setSaved(null), 4000);
    } catch (e) {
      console.error("save_transcript failed", e);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-5">
        <span className="text-xs font-medium text-foreground">Transcript</span>
        <div className="flex items-center gap-2">
          {saved && (
            <span className="flex items-center gap-1 text-[11px] text-emerald-400">
              <Check className="size-3" /> 已儲存
            </span>
          )}
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={!hasSegments} onClick={save}>
            <Download className="size-3" />
            Save
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
