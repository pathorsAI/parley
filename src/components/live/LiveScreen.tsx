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

  return (
    // key=layout remounts the group so panel sizes reset cleanly on change.
    <ResizablePanelGroup key={layout} orientation="horizontal" className="min-h-0 flex-1">
      {showTranscript && (
        <>
          <ResizablePanel defaultSize={26} minSize={15}>
            <MeetingView />
          </ResizablePanel>
          <ResizableHandle withHandle />
        </>
      )}
      <ResizablePanel defaultSize={showTranscript && showEvals ? 46 : 60} minSize={30}>
        <WorkPanel />
      </ResizablePanel>
      {showEvals && (
        <>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={28} minSize={18}>
            <FindingsPanel mode="live" onSeek={setHighlightMs} />
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}
