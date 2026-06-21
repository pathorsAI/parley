import { useEffect, useMemo, useState } from "react";
import { AudioLines, Loader2, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useStore, speakerKey, defaultSpeakerLabel } from "../../lib/store";
import { speakerDotClass } from "../../lib/speakerColors";
import { runVoiceDiarize } from "../../lib/speakers/diarize";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Source } from "../../lib/types";

/** Speaker-count presets: `null` = auto-detect, then 2–8. */
const COUNT_OPTIONS: (number | null)[] = [null, 2, 3, 4, 5, 6, 7, 8];

/** Payload of the Rust `diarize://progress` event. */
interface DiarizeProgress {
  stage: string;
  /** Items done (segments embedded, or bytes downloaded). */
  received: number;
  /** Total (0 ⇒ indeterminate stage). */
  total: number;
}

interface SpeakerEntry {
  key: string;
  source: Source;
  speaker: number;
  sample: string;
}

/**
 * Group transcript lines by speaker using the recording's AUDIO — slices by the
 * existing timestamps, embeds each slice with a local voice model, and clusters.
 * Solves reversed sides / over-splitting that STT diarization gets wrong.
 *
 * Flow: pick a speaker count (or Auto) → run (with staged progress) → name the
 * speakers it found. No names are needed up front; naming happens after, with a
 * sample line per speaker. Applies straight to the store.
 */
export function VoiceDiarizeDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const segments = useStore((s) => s.segments);
  const speakerNames = useStore((s) => s.speakerNames);
  const setSpeakerName = useStore((s) => s.setSpeakerName);

  const [numSpeakers, setNumSpeakers] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<DiarizeProgress | null>(null);
  // Becomes true after a successful run → switch to the naming step.
  const [named, setNamed] = useState(false);

  // Surface staged progress (download / decode / embed / cluster) on the bar.
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen<DiarizeProgress>("diarize://progress", (e) => {
      if (alive) setProgress(e.payload);
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // Distinct speakers (after diarization), ordered by speaker number, each with
  // its longest line as a sample to help the user tell who's who.
  const speakers = useMemo<SpeakerEntry[]>(() => {
    const map = new Map<string, SpeakerEntry>();
    for (const s of segments) {
      const text = s.text.trim();
      if (!text) continue;
      const key = speakerKey(s);
      const existing = map.get(key);
      if (!existing) {
        map.set(key, { key, source: s.source, speaker: s.speaker, sample: text });
      } else if (text.length > existing.sample.length) {
        existing.sample = text;
      }
    }
    return [...map.values()].sort((a, b) => a.speaker - b.speaker);
  }, [segments]);

  async function run() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      await runVoiceDiarize({ numSpeakers });
      setNamed(true); // move to the naming step
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col rounded-xl border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <AudioLines className="size-4 text-emerald-400" />
          <span className="text-sm font-semibold">{t("speakers.voiceTitle")}</span>
          <button
            type="button"
            className="ml-auto text-muted-foreground hover:text-foreground"
            disabled={busy}
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-3.5">
          {!named ? (
            <>
              <p className="text-[12px] leading-relaxed text-muted-foreground">{t("speakers.voiceIntro")}</p>

              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] text-muted-foreground">{t("speakers.voiceCount")}</span>
                <div className="flex flex-wrap gap-1.5">
                  {COUNT_OPTIONS.map((opt) => {
                    const selected = numSpeakers === opt;
                    return (
                      <button
                        key={opt ?? "auto"}
                        type="button"
                        disabled={busy}
                        onClick={() => setNumSpeakers(opt)}
                        className={`h-8 min-w-9 rounded-md border px-3 text-xs transition-colors disabled:opacity-50 ${
                          selected
                            ? "border-emerald-500/60 bg-emerald-500/15 text-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {opt === null ? t("speakers.voiceAuto") : opt}
                      </button>
                    );
                  })}
                </div>
              </div>

              {busy && <ProgressBar progress={progress} stageLabel={stageLabel(progress, t)} />}

              {error && (
                <p className="rounded-md bg-orange-500/10 px-2.5 py-1.5 text-[11px] text-orange-400">
                  {t("speakers.failed", { error })}
                </p>
              )}
            </>
          ) : (
            <>
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                {t("speakers.voiceFound", { speakers: speakers.length })}
              </p>
              <div className="flex flex-col gap-2.5">
                {speakers.map((sp) => (
                  <div key={sp.key} className="flex items-start gap-2">
                    <span className={`mt-2.5 size-2 shrink-0 rounded-full ${speakerDotClass(sp)}`} />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <Input
                        value={speakerNames[sp.key] ?? ""}
                        onChange={(e) => setSpeakerName(sp.key, e.target.value)}
                        placeholder={defaultSpeakerLabel(sp)}
                        className="h-8 text-sm"
                      />
                      <span className="truncate text-[11px] text-muted-foreground" title={sp.sample}>
                        “{sp.sample}”
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t px-4 py-3">
          {!named ? (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="rounded-md border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                {t("speakers.cancel")}
              </button>
              <Button size="sm" className="h-8 gap-1.5" disabled={busy} onClick={() => void run()}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <AudioLines className="size-3.5" />}
                {busy ? t("speakers.voiceRunning") : t("speakers.voiceRun")}
              </Button>
            </>
          ) : (
            <Button size="sm" className="h-8" onClick={onClose}>
              {t("speakers.voiceDone")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A labeled progress bar; renders an indeterminate pulse when `total` is 0. */
function ProgressBar({ progress, stageLabel }: { progress: DiarizeProgress | null; stageLabel: string }) {
  const indeterminate = !progress || progress.total === 0;
  const pct =
    progress && progress.total > 0 ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : 0;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{stageLabel}</span>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        {indeterminate ? (
          <div className="h-full w-1/3 animate-pulse rounded-full bg-emerald-500/70" />
        ) : (
          <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
        )}
      </div>
    </div>
  );
}

/** Localized label for the current pipeline stage. */
function stageLabel(progress: DiarizeProgress | null, t: ReturnType<typeof useI18n>["t"]): string {
  if (!progress) return t("speakers.voiceRunning");
  switch (progress.stage) {
    case "downloading-model": {
      const pct = progress.total > 0 ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : 0;
      return t("speakers.voiceDownloading", { percent: pct });
    }
    case "decoding":
      return t("speakers.voiceStageDecoding");
    case "embedding":
      return t("speakers.voiceStageEmbedding", { current: progress.received, total: progress.total });
    case "clustering":
      return t("speakers.voiceStageClustering");
    default:
      return t("speakers.voiceRunning");
  }
}
