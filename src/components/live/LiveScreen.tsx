import { useMemo } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import { MicOff, X } from "lucide-react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useStore } from "../../lib/store";
import { useI18n } from "../../i18n";
import { MeetingView } from "../MeetingView";
import { CoachFeed } from "./CoachFeed";
import { TodosPanel } from "../sidebar/TodosPanel";
import { FindingsPanel } from "../analysis/FindingsPanel";

/**
 * Persistent mic-only warning (⑥): the system-audio tap failing means the
 * OTHER side never reaches the transcript — a 10s toast is gone long before
 * the user notices the silence, so this stays up for the rest of the call
 * (dismissable, re-armed per meeting).
 */
function SystemAudioBanner() {
  const { t } = useI18n();
  const warning = useStore((s) => s.systemAudioWarning);
  const setSystemAudioWarning = useStore((s) => s.setSystemAudioWarning);
  if (!warning) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
      <MicOff className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{t("meeting.warning.systemAudioBanner")}</span>
      <button
        type="button"
        aria-label={t("common.dismiss")}
        onClick={() => setSystemAudioWarning(false)}
        className="grid size-5 shrink-0 place-items-center rounded hover:bg-amber-500/20"
      >
        <X className="size-3.5" />
      </button>
    </div>
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
  const saved = useDefaultLayout({ id: "parley:live", panelIds, storage: window.localStorage });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
    <SystemAudioBanner />
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
