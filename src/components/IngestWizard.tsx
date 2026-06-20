import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AudioLines, Check, Loader2, Mic } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useStore, speakerKey, defaultSpeakerLabel } from "../lib/store";
import { speakerDotClass } from "../lib/speakerColors";
import { hasProviderKey } from "../lib/ai/settings";
import { runAnalysis } from "../lib/analysis/engine";
import { useI18n } from "../i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ReplayTranscript } from "./replay/ReplayTranscript";
import type { Source } from "../lib/types";

/** Speaker-count presets: `null` = auto-detect, then 2–6. */
const COUNT_OPTIONS: (number | null)[] = [null, 2, 3, 4, 5, 6];

interface DiarizeProgress {
  stage: string;
  received: number;
  total: number;
}

interface SpeakerEntry {
  key: string;
  source: Source;
  speaker: number;
  sample: string;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Guided upload pipeline. Opened by the titlebar after a file is picked; runs as
 * one flow over the analysis page: ask speaker count → transcribe → diarize by
 * voice → review & name the speakers (with a transcript preview) → on Confirm,
 * run the whole-recording analysis → close into the results page.
 *
 * The whole-recording analysis is gated (store `analysisGate: "deferred"`, armed
 * by openIngestWizard) so it can't auto-run when the session loads behind the
 * dialog; this wizard runs it explicitly at Confirm.
 */
export function IngestWizard() {
  const { t } = useI18n();
  const open = useStore((s) => s.ingestWizardOpen);
  const step = useStore((s) => s.ingestWizardStep);
  const wizardError = useStore((s) => s.ingestWizardError);
  const setStep = useStore((s) => s.setIngestWizardStep);
  const close = useStore((s) => s.closeIngestWizard);
  const enterReplay = useStore((s) => s.enterReplay);
  const exitReplay = useStore((s) => s.exitReplay);
  const segments = useStore((s) => s.segments);
  const speakerNames = useStore((s) => s.speakerNames);
  const setSpeakerName = useStore((s) => s.setSpeakerName);
  const analysisStatus = useStore((s) => s.analysisStatus);
  const analysisError = useStore((s) => s.analysisError);
  const evalTemplates = useStore((s) => s.settings.evalTemplates);
  const updateSettings = useStore((s) => s.updateSettings);

  const [numSpeakers, setNumSpeakers] = useState<number | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [txStage, setTxStage] = useState<string | null>(null);
  const [dz, setDz] = useState<DiarizeProgress | null>(null);
  const startedRef = useRef<string | null>(null);
  const failedRef = useRef<"transcribing" | "diarizing" | "analyzing" | null>(null);

  // Diarization staged progress (Rust `diarize://progress` events).
  useEffect(() => {
    if (!open) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen<DiarizeProgress>("diarize://progress", (e) => {
      if (alive) setDz(e.payload);
    }).then((u) => (alive ? (unlisten = u) : u()));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [open]);

  // Step driver: launch each async step exactly once on entry.
  useEffect(() => {
    if (!open) return;
    if (step === "transcribing" && startedRef.current !== "transcribing") {
      startedRef.current = "transcribing";
      void runTranscription();
    } else if (step === "diarizing" && startedRef.current !== "diarizing") {
      startedRef.current = "diarizing";
      void runDiarization();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step]);

  // Analyzing watcher: close when the analysis finishes; surface failures.
  useEffect(() => {
    if (!open || step !== "analyzing") return;
    if (analysisStatus === "done") {
      close();
    } else if (analysisStatus === "error") {
      failedRef.current = "analyzing";
      setStep("error", analysisError ?? "Analysis failed");
    }
  }, [open, step, analysisStatus, analysisError, close, setStep]);

  // Distinct speakers (after diarization), each with its longest line as a sample.
  const speakers = useMemo<SpeakerEntry[]>(() => {
    const map = new Map<string, SpeakerEntry>();
    for (const s of segments) {
      const text = s.text.trim();
      if (!text) continue;
      const key = speakerKey(s);
      const existing = map.get(key);
      if (!existing) map.set(key, { key, source: s.source, speaker: s.speaker, sample: text });
      else if (text.length > existing.sample.length) existing.sample = text;
    }
    return [...map.values()].sort((a, b) => a.speaker - b.speaker);
  }, [segments]);

  if (!open) return null;

  async function runTranscription() {
    setTxStage("decoding");
    try {
      const { settings, ingestAudioPath } = useStore.getState();
      if (!ingestAudioPath) throw new Error("No recording selected");
      const { transcribeRecording } = await import("../lib/replay/ingest");
      const session = await transcribeRecording(settings, ingestAudioPath, {
        onProgress: (p) => setTxStage(p.stage),
      });
      // Load the session behind the dialog (analysis stays gated until Confirm).
      enterReplay(session);
      setStep("diarizing");
    } catch (e) {
      failedRef.current = "transcribing";
      setStep("error", errMsg(e));
    }
  }

  async function runDiarization() {
    setDz(null);
    try {
      const { runVoiceDiarize } = await import("../lib/speakers/diarize");
      await runVoiceDiarize({ numSpeakers });
      setStep("review");
    } catch (e) {
      failedRef.current = "diarizing";
      setStep("error", errMsg(e));
    }
  }

  function applyTemplate(id: string) {
    const tpl = evalTemplates.find((x) => x.id === id);
    if (!tpl) return;
    // Set the active evaluations for THIS analysis (same path the live panel uses).
    updateSettings({ evaluations: tpl.evals.map((e) => ({ ...e })) });
    setTemplateId(id);
  }

  function confirmReview() {
    // No LLM key → skip analysis, just land on the (diarized) results page.
    if (!hasProviderKey(useStore.getState().settings)) {
      close();
      return;
    }
    setStep("analyzing");
    void runAnalysis({ mode: "replay" });
  }

  function retry() {
    const failed = failedRef.current;
    failedRef.current = null;
    if (failed === "transcribing") {
      startedRef.current = null;
      setStep("transcribing");
    } else if (failed === "diarizing") {
      startedRef.current = null;
      setStep("diarizing");
    } else if (failed === "analyzing") {
      setStep("analyzing");
      void runAnalysis({ mode: "replay" });
    } else {
      cancel();
    }
  }

  function cancel() {
    startedRef.current = null;
    failedRef.current = null;
    // Only tear down replay if we actually entered it (transcription step done).
    // On count/transcribing the app is still LIVE — exitReplay would wipe a
    // stopped live meeting's transcript/findings. Just disarm the gate instead.
    if (useStore.getState().appMode === "replay") {
      exitReplay();
    } else {
      useStore.setState({ analysisGate: "open" });
    }
    close();
  }

  const wide = step === "review";

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-6">
      <div
        className={`flex max-h-[88vh] w-full flex-col rounded-xl border bg-background shadow-xl ${
          wide ? "max-w-2xl" : "max-w-md"
        }`}
      >
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <AudioLines className="size-4 text-emerald-400" />
          <span className="text-sm font-semibold">{t("ingest.title")}</span>
          <StepDots step={step} />
        </div>

        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-4">
          {step === "count" && (
            <>
              <p className="text-[12px] leading-relaxed text-muted-foreground">{t("ingest.countIntro")}</p>
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] text-muted-foreground">{t("speakers.voiceCount")}</span>
                <div className="flex flex-wrap gap-1.5">
                  {COUNT_OPTIONS.map((opt) => {
                    const selected = numSpeakers === opt;
                    return (
                      <button
                        key={opt ?? "auto"}
                        type="button"
                        onClick={() => setNumSpeakers(opt)}
                        className={`h-8 min-w-9 rounded-md border px-3 text-xs transition-colors ${
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
            </>
          )}

          {step === "transcribing" && (
            <Stage
              icon={<Loader2 className="size-4 animate-spin text-sky-400" />}
              label={t(`replay.stage.${txStage ?? "decoding"}` as never)}
              sub={t("ingest.transcribingSub")}
            />
          )}

          {step === "diarizing" && (
            <Stage
              icon={<Loader2 className="size-4 animate-spin text-emerald-400" />}
              label={diarizeLabel(dz, t)}
              sub={t("ingest.diarizingSub")}
              progress={dz && dz.total > 0 ? dz.received / dz.total : null}
            />
          )}

          {step === "review" && (
            <>
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                {t("ingest.reviewIntro", { speakers: speakers.length })}
              </p>
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] text-muted-foreground">{t("ingest.template")}</span>
                <Select value={templateId} onValueChange={applyTemplate}>
                  <SelectTrigger size="sm" className="h-8 text-xs">
                    <SelectValue placeholder={t("evaluations.applyTemplate")} />
                  </SelectTrigger>
                  <SelectContent>
                    {evalTemplates.map((tpl) => (
                      <SelectItem key={tpl.id} value={tpl.id}>
                        {tpl.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
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
              <div className="mt-1 flex flex-col gap-1">
                <span className="text-[11px] text-muted-foreground">{t("ingest.transcriptPreview")}</span>
                <div className="h-64 overflow-hidden rounded-md border">
                  <ReplayTranscript
                    segments={segments}
                    speakerNames={speakerNames}
                    trim={null}
                    playheadMs={0}
                    playing={false}
                    onSeek={() => {}}
                    emptyLabel={t("replay.empty")}
                  />
                </div>
              </div>
            </>
          )}

          {step === "analyzing" && (
            <Stage
              icon={<Loader2 className="size-4 animate-spin text-sky-400" />}
              label={t("ingest.analyzing")}
              sub={t("ingest.analyzingSub")}
            />
          )}

          {step === "error" && (
            <div className="flex items-start gap-2 rounded-md bg-orange-500/10 px-3 py-2.5 text-[12px] text-orange-400">
              <Mic className="mt-0.5 size-4 shrink-0" />
              <span>{t("ingest.failed", { error: wizardError ?? "—" })}</span>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t px-4 py-3">
          <button
            type="button"
            onClick={cancel}
            className="rounded-md border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            {t("ingest.cancel")}
          </button>
          {step === "count" && (
            <Button size="sm" className="h-8 gap-1.5" onClick={() => setStep("transcribing")}>
              <Check className="size-3.5" />
              {t("ingest.start")}
            </Button>
          )}
          {step === "review" && (
            <Button size="sm" className="h-8 gap-1.5" onClick={confirmReview}>
              <Check className="size-3.5" />
              {t("ingest.confirm")}
            </Button>
          )}
          {step === "error" && (
            <Button size="sm" className="h-8" onClick={retry}>
              {t("ingest.retry")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A centered stage indicator with an optional determinate progress bar. */
function Stage({
  icon,
  label,
  sub,
  progress,
}: {
  icon: ReactNode;
  label: string;
  sub?: string;
  progress?: number | null;
}) {
  return (
    <div className="flex flex-col items-center gap-2 py-6 text-center">
      {icon}
      <span className="text-sm font-medium text-foreground">{label}</span>
      {sub && <span className="text-[11px] text-muted-foreground">{sub}</span>}
      <div className="mt-1 h-1.5 w-48 overflow-hidden rounded-full bg-muted">
        {progress != null ? (
          <div
            className="h-full rounded-full bg-emerald-500 transition-all"
            style={{ width: `${Math.min(100, Math.round(progress * 100))}%` }}
          />
        ) : (
          <div className="h-full w-1/3 animate-pulse rounded-full bg-emerald-500/70" />
        )}
      </div>
    </div>
  );
}

/** Tiny step progress dots (count → transcribe → diarize → review → analyze). */
function StepDots({ step }: { step: string }) {
  const order = ["count", "transcribing", "diarizing", "review", "analyzing"];
  const idx = order.indexOf(step);
  return (
    <div className="ml-auto flex items-center gap-1">
      {order.map((s, i) => (
        <span
          key={s}
          className={`size-1.5 rounded-full ${i <= idx && idx >= 0 ? "bg-emerald-500" : "bg-muted"}`}
        />
      ))}
    </div>
  );
}

/** Localized label for the current diarization stage. */
function diarizeLabel(dz: DiarizeProgress | null, t: ReturnType<typeof useI18n>["t"]): string {
  if (!dz) return t("speakers.voiceRunning");
  switch (dz.stage) {
    case "downloading-model": {
      const pct = dz.total > 0 ? Math.min(100, Math.round((dz.received / dz.total) * 100)) : 0;
      return t("speakers.voiceDownloading", { percent: pct });
    }
    case "decoding":
      return t("speakers.voiceStageDecoding");
    case "embedding":
      return t("speakers.voiceStageEmbedding", { current: dz.received, total: dz.total });
    case "clustering":
      return t("speakers.voiceStageClustering");
    default:
      return t("speakers.voiceRunning");
  }
}
