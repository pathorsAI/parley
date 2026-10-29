import { useEffect, useMemo, useState } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import { Hourglass, Loader2, MicOff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useStore } from "../../lib/store";
import { isWindows } from "../../lib/platform";
import {
  endSilentMeeting,
  keepRecording,
  SILENCE_GRACE_MS,
  SILENCE_PROMPT_MS,
} from "../../lib/meeting/silenceGuard";
import { log } from "../../lib/log";
import { useI18n } from "../../i18n";
import { MeetingView } from "../MeetingView";
import { CoachFeed } from "./CoachFeed";
import { TodosPanel } from "../sidebar/TodosPanel";
import { FindingsPanel } from "../analysis/FindingsPanel";

/**
 * Persistent mic-only warning (⑥): the system-audio capture failing means the
 * OTHER side never reaches the transcript — a 10s toast is gone long before
 * the user notices the silence, so this stays up for the rest of the call
 * (dismissable, re-armed per meeting by startMeeting()).
 *
 * The trigger is the `meeting://warning` event on both platforms, but the
 * cause differs, and so does the sentence: on macOS it is almost always the
 * missing "System Audio Recording" grant; on Windows loopback needs no grant,
 * so the only way to get here is having no output device to capture.
 */
function SystemAudioBanner() {
  const { t } = useI18n();
  const warning = useStore((s) => s.systemAudioWarning);
  const setSystemAudioWarning = useStore((s) => s.setSystemAudioWarning);

  if (!warning) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-warning-border bg-warning px-3 py-1.5 text-xs text-warning-foreground">
      <MicOff className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {t(isWindows() ? "meeting.warning.systemAudioBanner.windows" : "meeting.warning.systemAudioBanner")}
      </span>
      <button
        type="button"
        aria-label={t("common.dismiss")}
        onClick={() => setSystemAudioWarning(false)}
        className="grid size-5 shrink-0 place-items-center rounded hover:bg-warning-border/40"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/**
 * The live transcript lost its connection and the backend is redialling (#570).
 * The meeting is NOT failing: the mic keeps recording, the backend carries a
 * bounded stretch of audio across the gap so a short drop catches up in the
 * transcript, and anything past that is still in the saved recording. So this
 * reads as a pause — warning family and a spinner, the same language as the
 * mobile apps' "reconnecting…" row — never as an error.
 *
 * Not dismissable, unlike the system-audio banner: it describes a state that
 * ends by itself, and it goes away the moment every dropped leg is live again
 * (store.transcriptionLink). Hiding it early would leave a frozen transcript
 * with no explanation.
 */
function TranscriptionLinkBanner() {
  const { t } = useI18n();
  const reconnecting = useStore((s) => s.transcriptionLink === "reconnecting");

  if (!reconnecting) return null;
  return (
    // <output> carries the implicit "status" live-region role, so screen
    // readers announce the drop and the recovery without an explicit role.
    <output className="flex shrink-0 items-center gap-2 border-b border-warning-border bg-warning px-3 py-1.5 text-xs text-warning-foreground">
      <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
      <span className="min-w-0 flex-1">{t("meeting.transcription.reconnectingBanner")}</span>
    </output>
  );
}

/**
 * Nothing is being captured: the backend closed the transcription session
 * rather than redial one that would only idle out, and dials again by itself
 * the moment audio arrives (store.transcriptionNoAudioSources). Usually a
 * microphone that was unplugged or taken by another app — so it says where to
 * look. Hidden while paused (that silence is the user's own) and while the
 * reconnecting banner is up (one banner at a time).
 */
function NoAudioBanner() {
  const { t } = useI18n();
  const show = useStore(
    (s) =>
      s.meetingStatus === "recording" &&
      s.transcriptionLink !== "reconnecting" &&
      s.transcriptionNoAudioSources.length > 0,
  );

  if (!show) return null;
  return (
    <output className="flex shrink-0 items-center gap-2 border-b border-warning-border bg-warning px-3 py-1.5 text-xs text-warning-foreground">
      <MicOff className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{t("meeting.transcription.noAudioBanner")}</span>
    </output>
  );
}

/**
 * The silence guard is asking whether the meeting is over (nothing has been
 * transcribed for a long time — see meeting/silenceGuard.ts). Counts down to
 * the automatic End; either button answers it. Speech coming back withdraws it
 * by itself.
 */
function SilencePromptBanner() {
  const { t } = useI18n();
  const promptAt = useStore((s) => s.silencePromptAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (promptAt == null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [promptAt]);

  if (promptAt == null) return null;
  const seconds = Math.max(0, Math.ceil((promptAt + SILENCE_GRACE_MS - now) / 1000));
  return (
    <output className="flex shrink-0 items-center gap-2 border-b border-warning-border bg-warning px-3 py-1.5 text-xs text-warning-foreground">
      <Hourglass className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        {t("meeting.silence.prompt", {
          minutes: String(Math.round(SILENCE_PROMPT_MS / 60_000)),
          seconds: String(seconds),
        })}
      </span>
      <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={keepRecording}>
        {t("meeting.silence.keep")}
      </Button>
      <Button
        size="sm"
        variant="destructive"
        className="h-6 px-2 text-xs"
        onClick={() =>
          void endSilentMeeting("confirmed").catch((error) =>
            log.error("meeting: silence prompt end failed", { error: String(error) }),
          )
        }
      >
        {t("meeting.silence.end")}
      </Button>
    </output>
  );
}

/** Every in-meeting warning strip, in priority order (each hides itself). */
export function LiveBanners() {
  return (
    <>
      <SystemAudioBanner />
      <TranscriptionLinkBanner />
      <NoAudioBanner />
      <SilencePromptBanner />
    </>
  );
}

/**
 * The LIVE screen, in one of two postures (titlebar-center switcher):
 * - coach (default): transcript rail | coach feed | agenda checklist —
 *   the center belongs to the coach's one voice, not a chat pane.
 * - transcript: full-width transcript + the findings/analysis column.
 */
export function LiveScreen() {
  const layout = useStore((s) => s.settings.layout);
  const setHighlightMs = useStore((s) => s.setHighlightMs);

  // Persist dragged column proportions per posture; key=layout remounts the
  // group so saved sizes re-apply on a posture switch.
  const panelIds = useMemo(
    () =>
      layout === "coach" ? ["transcript", "feed", "todos"] : ["transcript", "findings"],
    [layout]
  );
  const saved = useDefaultLayout({ id: "parley:live", panelIds, storage: globalThis.localStorage });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
    <LiveBanners />
    <ResizablePanelGroup
      key={layout}
      orientation="horizontal"
      className="min-h-0 flex-1"
      defaultLayout={saved.defaultLayout}
      onLayoutChanged={saved.onLayoutChanged}
    >
      {layout === "coach" ? (
        <>
          {/* Pixel minimums (window minWidth is 900): below these the rails'
              one-line rows degrade into clipped fragments. */}
          <ResizablePanel id="transcript" defaultSize={26} minSize="220px">
            <MeetingView />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="feed" defaultSize={48} minSize="320px">
            <CoachFeed onSeek={setHighlightMs} />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="todos" defaultSize={26} minSize="260px">
            <TodosPanel />
          </ResizablePanel>
        </>
      ) : (
        <>
          <ResizablePanel id="transcript" defaultSize={70} minSize="420px">
            <MeetingView />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="findings" defaultSize={30} minSize="260px">
            <FindingsPanel mode="live" onSeek={setHighlightMs} />
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
    </div>
  );
}
