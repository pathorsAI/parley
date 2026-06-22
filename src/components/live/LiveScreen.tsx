import { useMemo } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useStore } from "../../lib/store";
import { MeetingView } from "../MeetingView";
import { WorkPanel } from "../WorkPanel";
import { FindingsPanel } from "../analysis/FindingsPanel";

/**
 * The LIVE coaching screen: transcript (with the analysis-timeline band) on the
 * left, Ask + TODO agenda in the center, and the shared findings panel on the
 * right. Columns follow the user's `layout` preference. A live finding click
 * jumps the transcript via `highlightMs` (consumed by TranscriptPanel).
 */
export function LiveScreen() {
  const layout = useStore((s) => s.settings.layout);
  const setHighlightMs = useStore((s) => s.setHighlightMs);
  const showTranscript = layout !== "assistant";
  const showEvals = layout !== "transcript";

  // Persist the dragged column proportions to localStorage. `panelIds` makes the
  // library store a separate layout per visible set, so each preset (full /
  // assistant / transcript) keeps its own sizes — no reset on reload. key=layout
  // remounts the group on a preset switch so the saved sizes re-apply in-session too.
  const panelIds = useMemo(
    () => [...(showTranscript ? ["transcript"] : []), "work", ...(showEvals ? ["findings"] : [])],
    [showTranscript, showEvals]
  );
  const saved = useDefaultLayout({ id: "parley:live", panelIds, storage: window.localStorage });

  return (
    <ResizablePanelGroup
      key={layout}
      orientation="horizontal"
      className="min-h-0 flex-1"
      defaultLayout={saved.defaultLayout}
      onLayoutChanged={saved.onLayoutChanged}
    >
      {showTranscript && (
        <>
          <ResizablePanel id="transcript" defaultSize={26} minSize={15}>
            <MeetingView />
          </ResizablePanel>
          <ResizableHandle withHandle />
        </>
      )}
      <ResizablePanel id="work" defaultSize={showTranscript && showEvals ? 46 : 60} minSize={30}>
        <WorkPanel />
      </ResizablePanel>
      {showEvals && (
        <>
          <ResizableHandle withHandle />
          <ResizablePanel id="findings" defaultSize={28} minSize={18}>
            <FindingsPanel mode="live" onSeek={setHighlightMs} />
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}
