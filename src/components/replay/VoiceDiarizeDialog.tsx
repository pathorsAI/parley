import { useEffect, useState } from "react";
import { AudioLines, Loader2, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { runVoiceDiarize } from "../../lib/speakers/diarize";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";

/** Speaker-count presets: `null` = auto-detect, then 2–6. */
const COUNT_OPTIONS: (number | null)[] = [null, 2, 3, 4, 5, 6];

/** Payload of the Rust `diarize://progress` event. */
interface DiarizeProgress {
  stage: string;
  received: number;
  total: number;
}

/**
 * Group transcript lines by speaker using the recording's AUDIO — slices by the
 * existing timestamps, embeds each slice with a local voice model, and clusters.
 * Solves reversed sides / over-splitting that text-based re-attribution can't.
 * Applies straight to the store; the speaker roster above can then be renamed.
 */
export function VoiceDiarizeDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [numSpeakers, setNumSpeakers] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadPct, setDownloadPct] = useState<number | null>(null);

  // Surface first-use model download progress on the button.
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen<DiarizeProgress>("diarize://progress", (e) => {
      const { stage, received, total } = e.payload;
      if (stage === "downloading-model" && total > 0) {
        setDownloadPct(Math.min(100, Math.round((received / total) * 100)));
      } else {
        setDownloadPct(null);
      }
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  async function run() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await runVoiceDiarize({ numSpeakers });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setDownloadPct(null);
    }
  }

  const runLabel =
    downloadPct !== null
      ? t("speakers.voiceDownloading", { percent: downloadPct })
      : busy
        ? t("speakers.voiceRunning")
        : t("speakers.voiceRun");

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

          {error && (
            <p className="rounded-md bg-orange-500/10 px-2.5 py-1.5 text-[11px] text-orange-400">
              {t("speakers.failed", { error })}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t px-4 py-3">
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
            {runLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
