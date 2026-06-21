import { useMemo } from "react";
import { useStore, speakerKey } from "../lib/store";
import { speakerDotClass } from "../lib/speakerColors";
import { useI18n } from "../i18n";
import { Input } from "@/components/ui/input";
import { MeetingContextButton } from "./MeetingContextButton";
import type { Source } from "../lib/types";

interface SpeakerEntry {
  key: string;
  source: Source;
  speaker: number;
}

/**
 * Live roster: distinct speakers detected in the transcript, each with an
 * editable name. Names flow into the transcript badges and every LLM prompt,
 * so the model sees "重高" instead of "Speaker 1". Also exposes a quick meeting
 * description so analysis has context on who's present and their roles.
 */
export function SpeakerBar() {
  const { t } = useI18n();
  const segments = useStore((s) => s.segments);
  const names = useStore((s) => s.speakerNames);
  const setSpeakerName = useStore((s) => s.setSpeakerName);

  function defaultLabel(sp: Pick<SpeakerEntry, "source" | "speaker">) {
    if (sp.source === "mix") return t("speaker.speaker", { number: sp.speaker || 1 });
    if (sp.source === "me") {
      return (sp.speaker || 1) <= 1 ? t("speaker.you") : t("speaker.speaker", { number: sp.speaker });
    }
    return sp.speaker > 0 ? t("speaker.remote", { number: sp.speaker }) : t("speaker.them");
  }

  // Distinct speakers in first-appearance order.
  const speakers = useMemo<SpeakerEntry[]>(() => {
    const seen = new Set<string>();
    const out: SpeakerEntry[] = [];
    for (const s of [...segments].sort((a, b) => a.startMs - b.startMs)) {
      if (!s.text.trim()) continue;
      const key = speakerKey(s);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, source: s.source, speaker: s.speaker });
    }
    return out;
  }, [segments]);

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-5 py-2.5">
      <MeetingContextButton />
      {speakers.length > 0 && (
        <>
          <span className="text-[11px] text-muted-foreground">{t("meeting.speakers")}</span>
          {speakers.map((sp) => (
            <div key={sp.key} className="flex items-center gap-1.5">
              <span className={`size-2 shrink-0 rounded-full ${speakerDotClass(sp)}`} />
              <Input
                value={names[sp.key] ?? ""}
                onChange={(e) => setSpeakerName(sp.key, e.target.value)}
                placeholder={defaultLabel(sp)}
                className="h-7 w-28 text-xs"
              />
            </div>
          ))}
        </>
      )}
    </div>
  );
}
