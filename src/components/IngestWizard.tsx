import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AudioLines, Check, Loader2, Mic, Pause, Play, Scissors } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useStore, speakerKey, defaultSpeakerLabel, formatClock, hasSpokenSegment, type ReplayTrim } from "../lib/store";
import { speakerDotClass } from "../lib/speakerColors";
import { hasProviderKey } from "../lib/ai/settings";
import { runAnalysis } from "../lib/analysis/engine";
import { saveUploadToHistory } from "../lib/history/history";
import { useI18n } from "../i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MeetingContextField } from "./MeetingContextField";
import { ReplayTranscript } from "./replay/ReplayTranscript";
import { Scrubber } from "./replay/Scrubber";
import { TrimBar } from "./replay/TrimBar";
import { useReplayPlayer } from "./replay/useReplayPlayer";
import { useReplaySession } from "./replay/spine";
import type { Source } from "../lib/types";

/** Speaker-count presets: `null` = auto-detect, then 2–8. */
const COUNT_OPTIONS: (number | null)[] = [null, 2, 3, 4, 5, 6, 7, 8];

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
 * While the wizard is OPEN the study pipeline defers auto-analysis (it reads
 * `ingestWizardOpen` — see lib/analysis/studyPipeline.ts), so loading the
 * session behind the dialog can't trigger a pass; this wizard runs the first
 * analysis explicitly at Confirm. Closing on any path un-defers, and the
 * pipeline picks up whatever is still missing.
 */
export function IngestWizard() {
  const { t } = useI18n();
  const open = useStore((s) => s.ingestWizardOpen);
  const step = useStore((s) => s.ingestWizardStep);
  const wizardError = useStore((s) => s.ingestWizardError);
  const setStep = useStore((s) => s.setIngestWizardStep);
  const close = useStore((s) => s.closeIngestWizard);
  const enterReplay = useStore((s) => s.enterReplay);
  const segments = useStore((s) => s.segments);
  const speakerNames = useStore((s) => s.speakerNames);
  const setSpeakerName = useStore((s) => s.setSpeakerName);
  const analysisStatus = useStore((s) => s.analysisStatus);
  const analysisError = useStore((s) => s.analysisError);
  const evalTemplates = useStore((s) => s.settings.evalTemplates);
  const updateSettings = useStore((s) => s.updateSettings);

  // Player for the pre-diarize trim step (drives a local <audio>). Store-backed,
  // so it shares the playhead with the (idle, behind-the-modal) replay screen.
  const session = useReplaySession();
  const player = useReplayPlayer(session?.durationMs ?? 0, session?.audioOffsetMs ?? 0);

  const [numSpeakers, setNumSpeakers] = useState<number | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [txStage, setTxStage] = useState<string | null>(null);
  const [dz, setDz] = useState<DiarizeProgress | null>(null);
  const [trimDraft, setTrimDraft] = useState<ReplayTrim | null>(null);
  const [trimming, setTrimming] = useState(false);
  const startedRef = useRef<string | null>(null);
  const failedRef = useRef<"transcribing" | "diarizing" | "analyzing" | null>(null);

  // Diarization staged progress (Rust `diarize://progress` events).
  useEffect(() => {
    if (!open) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen<DiarizeProgress>("diarize://progress", (e) => {
      if (alive) setDz(e.payload);
    }).then((u) => {
      if (alive) {
        unlisten = u;
      } else {
        u();
      }
    });
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
      // Preview + optional first trim BEFORE diarization, so cut intro/tail audio
      // never spawns spurious speakers or skews the analysis.
      setTrimDraft(null);
      setStep("trim");
    } catch (e) {
      failedRef.current = "transcribing";
      setStep("error", errMsg(e));
    }
  }

  // Destructively cut the recording to the drafted keep-window, then stay on the
  // trim step (the now-shorter recording can be trimmed again before diarizing).
  async function applyTrim() {
    if (!trimDraft || trimming) return;
    const d = trimDraft;
    setTrimming(true);
    try {
      const { trimRecording } = await import("../lib/replay/trim");
      await trimRecording(d);
      setTrimDraft(null);
    } catch (e) {
      console.error("[trim]", e);
    } finally {
      setTrimming(false);
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

  /**
   * Land on the results page WITHOUT running analysis, keeping the transcribed
   * recording as a transcript-only history entry so the upload is never lost.
   * Used by "analyze later", the no-LLM-key path, and Cancel once a transcript
   * exists. Skips the save when the analysis pipeline is already running/done (it
   * auto-saves WITH findings via the study pipeline) or when the session was
   * already persisted.
   */
  function finishTranscriptOnly() {
    const st = useStore.getState();
    const { replay, loadedHistoryId, analysisStatus } = st;
    const hasSpoken = hasSpokenSegment(st.segments);
    if (replay && hasSpoken && !loadedHistoryId && analysisStatus !== "running" && analysisStatus !== "done") {
      // Fire-and-forget: saveUploadToHistory marks the entry loaded before its slow
      // Opus compress, so a later manual re-analysis overwrites it in place.
      saveUploadToHistory(replay).catch((e) =>
        console.error("[ingest] transcript-only save failed", e),
      );
    }
    close();
  }

  function confirmAnalyze() {
    // No LLM key → can't analyze; keep the transcript-only recording and land on
    // the (diarized) results page.
    if (!hasProviderKey(useStore.getState().settings, "deep")) {
      finishTranscriptOnly();
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
    // Once a transcript exists (we entered replay after transcription), NEVER
    // discard it — persist it transcript-only and land on the results page so the
    // upload isn't lost. Before that (count/transcribing, app still LIVE) there's
    // nothing to save; exitReplay would wipe a stopped live meeting's transcript,
    // so just close.
    if (useStore.getState().appMode === "replay") {
      finishTranscriptOnly();
    } else {
      close();
    }
  }

  const wide = step === "review" || step === "trim";

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
                        {opt ?? t("speakers.voiceAuto")}
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

          {step === "trim" && session && (
            <>
              <p className="text-[12px] leading-relaxed text-muted-foreground">{t("ingest.trimIntro")}</p>
              {/* Local audio for the preview; the player hook drives + observes it. */}
              <audio
                ref={player.audioRef}
                src={session.audioSrc}
                preload="metadata"
                onTimeUpdate={player.onTimeUpdate}
                onLoadedMetadata={player.onLoadedMetadata}
                onPlay={player.onPlay}
                onPause={player.onPause}
                onEnded={player.onEnded}
                className="hidden"
              >
                <track kind="captions" srcLang="en" src="data:text/vtt,WEBVTT%0A" default />
              </audio>
              {/* Transport + scrubber: listen to find the cut points. */}
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="size-7 shrink-0"
                  onClick={player.toggle}
                  aria-label={player.playing ? t("replay.pause") : t("replay.play")}
                >
                  {player.playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                </Button>
                <span className="w-9 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                  {formatClock(player.playheadMs)}
                </span>
                <Scrubber
                  valueMs={player.playheadMs}
                  durationMs={session.durationMs}
                  onScrub={player.seek}
                  onCommit={player.seek}
                  onScrubStart={player.beginScrub}
                  onScrubEnd={player.endScrub}
                  ariaLabel={t("replay.playhead")}
                />
                <span className="w-9 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                  {formatClock(session.durationMs)}
                </span>
              </div>
              {/* Trim handles + apply (destructive cut). */}
              <div className="flex flex-col gap-2 rounded-md border px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Scissors className="size-3 shrink-0" />
                    <span className="truncate">
                      {trimDraft
                        ? t("replay.trimKept", {
                            start: formatClock(trimDraft.startMs),
                            end: formatClock(trimDraft.endMs),
                          })
                        : t("ingest.trimNone")}
                    </span>
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    {trimDraft && (
                      <button
                        type="button"
                        onClick={() => setTrimDraft(null)}
                        disabled={trimming}
                        className="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                      >
                        {t("replay.trimReset")}
                      </button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-6 gap-1 px-2 text-[11px]"
                      disabled={!trimDraft || trimming}
                      onClick={applyTrim}
                    >
                      {trimming ? <Loader2 className="size-3 animate-spin" /> : <Scissors className="size-3" />}
                      {t("replay.trimApply")}
                    </Button>
                  </div>
                </div>
                <TrimBar
                  durationMs={session.durationMs}
                  trim={trimDraft}
                  onChange={setTrimDraft}
                  startLabel={t("replay.trimStart")}
                  endLabel={t("replay.trimEnd")}
                />
              </div>
              {/* Full transcript preview (lit); drafted cuts show struck-through. */}
              <div className="mt-1 flex min-h-0 flex-col gap-1">
                <span className="text-[11px] text-muted-foreground">{t("ingest.transcriptPreview")}</span>
                <div className="h-56 overflow-hidden rounded-md border">
                  <ReplayTranscript
                    segments={segments}
                    speakerNames={speakerNames}
                    trim={trimDraft}
                    playheadMs={player.playheadMs}
                    playing={player.playing}
                    onSeek={player.seek}
                    emptyLabel={t("replay.empty")}
                    preview
                  />
                </div>
              </div>
            </>
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
              {/* Compact one-line rows: dot + name + the speaker's longest line. */}
              <div className="flex flex-col gap-1">
                {speakers.map((sp) => (
                  <div key={sp.key} className="flex items-center gap-2">
                    <span className={`size-2 shrink-0 rounded-full ${speakerDotClass(sp)}`} />
                    <Input
                      value={speakerNames[sp.key] ?? ""}
                      onChange={(e) => setSpeakerName(sp.key, e.target.value)}
                      placeholder={defaultSpeakerLabel(sp)}
                      className="h-7 w-32 shrink-0 text-xs"
                    />
                    <span
                      className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
                      title={sp.sample}
                    >
                      “{sp.sample}”
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-1 flex min-h-0 flex-col gap-1">
                <span className="text-[11px] text-muted-foreground">{t("ingest.transcriptPreview")}</span>
                <div className="h-56 overflow-hidden rounded-md border">
                  <ReplayTranscript
                    segments={segments}
                    speakerNames={speakerNames}
                    trim={null}
                    playheadMs={0}
                    playing={false}
                    onSeek={() => {}}
                    emptyLabel={t("replay.empty")}
                    preview
                  />
                </div>
              </div>
            </>
          )}

          {step === "template" && (
            <>
              <p className="text-[12px] leading-relaxed text-muted-foreground">{t("ingest.templateIntro")}</p>
              <div className="flex flex-col gap-1.5">
                {evalTemplates.map((tpl) => {
                  const selected = templateId === tpl.id;
                  return (
                    <button
                      key={tpl.id}
                      type="button"
                      onClick={() => applyTemplate(tpl.id)}
                      className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                        selected
                          ? "border-emerald-500/60 bg-emerald-500/15 text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <span className="font-medium">{tpl.name}</span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                        {t("ingest.templateEvals", { count: tpl.evals.length })}
                      </span>
                    </button>
                  );
                })}
              </div>
              {/* Last chance to add background before the analysis runs. */}
              <div className="border-t pt-3">
                <MeetingContextField />
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
          {step === "trim" && (
            <Button size="sm" className="h-8 gap-1.5" disabled={trimming} onClick={() => setStep("diarizing")}>
              {t("ingest.trimNext")}
            </Button>
          )}
          {step === "review" && (
            <Button size="sm" className="h-8 gap-1.5" onClick={() => setStep("template")}>
              {t("ingest.next")}
            </Button>
          )}
          {step === "template" &&
            (templateId ? (
              <Button size="sm" className="h-8 gap-1.5" onClick={confirmAnalyze}>
                <Check className="size-3.5" />
                {t("ingest.confirm")}
              </Button>
            ) : (
              // No template picked → don't force analysis; save transcript-only and
              // land on the results page, letting them analyze later from the timeline.
              <Button size="sm" variant="outline" className="h-8" onClick={finishTranscriptOnly}>
                {t("ingest.skipAnalysis")}
              </Button>
            ))}
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
}: Readonly<{
  icon: ReactNode;
  label: string;
  sub?: string;
  progress?: number | null;
}>) {
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
function StepDots({ step }: Readonly<{ step: string }>) {
  const order = ["count", "transcribing", "trim", "diarizing", "review", "template", "analyzing"];
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
