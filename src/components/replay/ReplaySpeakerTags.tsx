import { useMemo, useState } from "react";
import { AudioLines } from "lucide-react";
import { useStore, speakerKey, defaultSpeakerLabel } from "../../lib/store";
import { speakerDotClass } from "../../lib/speakerColors";
import { useI18n } from "../../i18n";
import { Input } from "@/components/ui/input";
import { OnboardingHint } from "@/components/OnboardingHint";
import { rememberOwnName, useWhoAmIHint } from "@/lib/onboarding/whoAmI";
import { Button } from "@/components/ui/button";
import { VoiceDiarizeDialog } from "./VoiceDiarizeDialog";
import type { Source, TranscriptSegment } from "../../lib/types";

interface SpeakerEntry {
  key: string;
  source: Source;
  speaker: number;
}

interface ReplaySpeakerTagsProps {
  segments: TranscriptSegment[];
  /** Current speaker-key → custom name map (the store's, so edits reflect here). */
  names: Record<string, string>;
  /** Heading text (reuses the live `meeting.speakers` string). */
  label: string;
}

/**
 * Compact, editable speaker roster for the replay transcript — mirrors the live
 * SpeakerBar but scoped to replay. Distinct speakers are derived from the loaded
 * segments; typing a name calls `setSpeakerName(speakerKey, name)`, which is the
 * same store action the live view uses. Because the replay transcript, evals, and
 * Ask all read the store's `speakerNames`, renaming one speaker here updates every
 * one of that speaker's transcript lines and the analysis context at once.
 */
export function ReplaySpeakerTags({ segments, names, label }: Readonly<ReplaySpeakerTagsProps>) {
  const { t } = useI18n();
  const setSpeakerName = useStore((s) => s.setSpeakerName);
  const whoAmI = useWhoAmIHint();
  const [voiceOpen, setVoiceOpen] = useState(false);
  // A just-saved live meeting is still having its speakers corrected from the
  // audio in the background (history.saveLiveToHistory). A manual pass now
  // would race that one onto the same lines, so it waits — with the reason
  // on the button rather than a silent dead control.
  const correcting = useStore(
    (s) => s.replay?.id != null && s.postSaveDiarizingId === s.replay.id
  );

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

  if (speakers.length === 0) return null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {speakers.map((sp) => (
        <div key={sp.key} className="flex items-center gap-1.5">
          <span className={`size-2 shrink-0 rounded-full ${speakerDotClass(sp)}`} />
          <Input
            value={names[sp.key] ?? ""}
            onChange={(e) => {
              setSpeakerName(sp.key, e.target.value);
              whoAmI.onRename(e.target.value);
            }}
            onBlur={(e) => rememberOwnName(sp, e.target.value)}
            placeholder={defaultSpeakerLabel(sp)}
            className="h-7 w-28 text-xs"
          />
        </div>
      ))}
      {/* STT diarization is often wrong — cluster by the actual VOICE instead. */}
      {/* The wrapper carries the tooltip: a disabled <button> fires no pointer
          events, so its own title would never show the reason. */}
      <span
        className="ml-auto"
        title={correcting ? t("speakers.voiceBusyPostSave") : t("speakers.voiceTitle")}
      >
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[11px]"
          onClick={() => setVoiceOpen(true)}
          disabled={correcting}
        >
          <AudioLines className="size-3" />
          {t("speakers.voiceButton")}
        </Button>
      </span>
      {voiceOpen && !correcting && <VoiceDiarizeDialog onClose={() => setVoiceOpen(false)} />}
      {whoAmI.visible && (
        <OnboardingHint text={t("speakers.hintWhoAmI")} onDismiss={whoAmI.dismiss} className="basis-full" />
      )}
    </div>
  );
}
