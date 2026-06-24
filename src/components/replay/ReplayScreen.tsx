import { useDefaultLayout } from "react-resizable-panels";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useI18n } from "../../i18n";
import { useStore } from "../../lib/store";
import { isTauri } from "../../lib/tauriEvents";
import { evalSignature, findActiveTemplate } from "../../lib/evaluations/presets";
import { AnalysisTimeline } from "../analysis/AnalysisTimeline";
import { AnalyzeMenu } from "../analysis/AnalyzeMenu";
import { FindingsPanel } from "../analysis/FindingsPanel";
import { selectAndSeek } from "../analysis/useAnalysis";
import { AskPanel } from "../sidebar/AskPanel";
import { ReplayPlayerBar } from "./ReplayPlayerBar";
import { ReplayTranscript } from "./ReplayTranscript";
import { ReplaySpeakerTags } from "./ReplaySpeakerTags";
import { ActionItemsPanel } from "./ActionItemsPanel";
import { useReplayPlayer } from "./useReplayPlayer";
import { useReplayAnalysis } from "./useReplayAnalysis";
import { useReplayPlayheadMs, useReplaySession, useReplayTrim } from "./spine";

/**
 * The REPLAY screen: play an uploaded recording and review the whole-recording
 * analysis. The analysis runs ONCE on load (see useReplayAnalysis); dragging the
 * playhead is navigation/viewing only — it never re-runs anything. The timeline
 * and findings list are the shared analysis subsystem (identical to LIVE);
 * clicking a finding seeks the audio and opens its "how it should have been
 * done" drilldown. The center pane is Ask + post-meeting Action items.
 */
export function ReplayScreen() {
  const { t } = useI18n();

  const session = useReplaySession();
  const playheadMs = useReplayPlayheadMs();
  const player = useReplayPlayer(session?.durationMs ?? 0, session?.audioOffsetMs ?? 0);

  // Run the whole-recording analysis once, then chain action items.
  useReplayAnalysis();

  // Read the working transcript + speakerNames from the STORE (seeded on
  // enterReplay, then rewritten by voice diarization / edits) — not the static
  // session snapshot — so re-diarized speakers show and stay in sync with what
  // the analysis sees.
  const segments = useStore((s) => s.segments);
  const speakerNames = useStore((s) => s.speakerNames);
  const trim = useReplayTrim();
  const findings = useStore((s) => s.findings);
  const analysisStatus = useStore((s) => s.analysisStatus);
  const analysisError = useStore((s) => s.analysisError);
  const selectedId = useStore((s) => s.selectedFindingId);
  const evalTemplates = useStore((s) => s.settings.evalTemplates);
  const evaluations = useStore((s) => s.settings.evaluations);
  const analyzedEvalSig = useStore((s) => s.analyzedEvalSig);

  // Persist the dragged column proportions (transcript / center / findings) to
  // localStorage so they survive reloads.
  const saved = useDefaultLayout({ id: "parley:replay", storage: window.localStorage });

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {t("replay.empty")}
      </div>
    );
  }

  // Which eval template is active, and whether the findings predate an eval change.
  const activeTemplate = findActiveTemplate(evalTemplates, evaluations);
  const templateStale =
    findings.length > 0 && analysisStatus === "done" && evalSignature(evaluations) !== analyzedEvalSig;

  // Save the recording's audio out to a folder the user picks, then reveal it.
  async function exportRecording() {
    if (!isTauri()) return;
    try {
      const ext = session!.audioPath.split(".").pop() || "ogg";
      const base = session!.name.replace(/\.[^./\\]+$/, "") || "recording";
      const { save } = await import("@tauri-apps/plugin-dialog");
      const dst = await save({
        defaultPath: `${base}.${ext}`,
        filters: [{ name: "Audio", extensions: [ext] }],
      });
      if (!dst) return;
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("export_recording", { src: session!.audioPath, dst });
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(dst);
    } catch (e) {
      console.error("[export]", e);
      useStore.getState().showToast({
        kind: "error",
        message: t("replay.exportFailed", { error: e instanceof Error ? e.message : String(e) }),
        retry: exportRecording,
      });
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Hidden audio element — the player hook drives + observes it. */}
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
      />

      <ReplayPlayerBar
        name={session.name}
        durationMs={session.durationMs}
        player={player}
        rightSlot={<AnalyzeMenu />}
        onExport={isTauri() ? exportRecording : undefined}
        labels={{
          title: t("replay.title"),
          play: t("replay.play"),
          pause: t("replay.pause"),
          playhead: t("replay.playhead"),
          exportAudio: t("replay.export"),
          trim: t("replay.trim"),
          trimApply: t("replay.trimApply"),
          trimming: t("replay.trimming"),
          trimReset: t("replay.trimReset"),
          trimKept: t("replay.trimKept"),
          trimNote: t("replay.trimNote"),
          trimStart: t("replay.trimStart"),
          trimEnd: t("replay.trimEnd"),
        }}
      />

      <AnalysisTimeline
        findings={findings}
        status={analysisStatus}
        error={analysisError}
        axisMaxMs={session.durationMs}
        playheadMs={playheadMs}
        selectedId={selectedId}
        onSelect={(e) => selectAndSeek(e, player.seek)}
        templateName={activeTemplate ? activeTemplate.name : t("timeline.templateCustom")}
        stale={templateStale}
      />

      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={saved.defaultLayout}
        onLayoutChanged={saved.onLayoutChanged}
      >
        <ResizablePanel id="transcript" defaultSize={42} minSize={24}>
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex h-9 shrink-0 items-center border-b px-4">
              <span className="text-xs font-medium text-foreground">{t("replay.transcript")}</span>
            </div>
            <ReplaySpeakerTags segments={segments} names={speakerNames} label={t("meeting.speakers")} />
            <div className="min-h-0 flex-1">
              <ReplayTranscript
                segments={segments}
                speakerNames={speakerNames}
                trim={trim}
                playheadMs={playheadMs}
                playing={player.playing}
                onSeek={player.seek}
                emptyLabel={t("replay.empty")}
              />
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel id="center" defaultSize={34} minSize={22}>
          <Tabs defaultValue="actions" className="flex h-full min-h-0 flex-col gap-0">
            <div className="px-3 pt-2.5">
              <TabsList className="w-full">
                <TabsTrigger value="ask">{t("work.ask")}</TabsTrigger>
                <TabsTrigger value="actions">{t("actionItems.title")}</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="ask" className="min-h-0 flex-1 outline-none">
              <AskPanel />
            </TabsContent>
            <TabsContent value="actions" className="min-h-0 flex-1 outline-none">
              <ActionItemsPanel onSeek={player.seek} />
            </TabsContent>
          </Tabs>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel id="findings" defaultSize={24} minSize={18}>
          <FindingsPanel mode="replay" onSeek={player.seek} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
