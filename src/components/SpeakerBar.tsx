import { useMemo } from "react";
import { useStore, speakerKey, defaultSpeakerLabel } from "../lib/store";
import { speakerDotClass } from "../lib/speakerColors";
import { Input } from "@/components/ui/input";

interface SpeakerEntry {
  key: string;
  source: "me" | "them";
  speaker: number;
}

/**
 * Live roster: distinct speakers detected in the transcript, each with an
 * editable name. Names flow into the transcript badges and every LLM prompt,
 * so the model sees "重高" instead of "Speaker 1". Also exposes a quick meeting
 * description so analysis has context on who's present and their roles.
 */
export function SpeakerBar() {
  const segments = useStore((s) => s.segments);
  const names = useStore((s) => s.speakerNames);
  const setSpeakerName = useStore((s) => s.setSpeakerName);
  const meetingContext = useStore((s) => s.settings.meetingContext);
  const updateSettings = useStore((s) => s.updateSettings);

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
    <div className="flex shrink-0 flex-col gap-2 border-b px-5 py-2.5">
      <Input
        value={meetingContext}
        onChange={(e) => updateSettings({ meetingContext: e.target.value })}
        placeholder="會議描述 / 與會者角色（例：A 輪募資談判，對方是投資人，我是創辦人）…"
        className="h-8 text-xs"
      />
      {speakers.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-muted-foreground">Speakers:</span>
          {speakers.map((sp) => (
            <div key={sp.key} className="flex items-center gap-1.5">
              <span className={`size-2 shrink-0 rounded-full ${speakerDotClass(sp)}`} />
              <Input
                value={names[sp.key] ?? ""}
                onChange={(e) => setSpeakerName(sp.key, e.target.value)}
                placeholder={defaultSpeakerLabel(sp)}
                className="h-7 w-28 text-xs"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
