import { useMemo } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useStore } from "../../lib/store";
import { MeetingView } from "../MeetingView";
import { CoachFeed } from "./CoachFeed";
import { IntelligenceBoard } from "./IntelligenceBoard";
import { GlanceView } from "./GlanceView";
import { FindingsPanel } from "../analysis/FindingsPanel";

/**
 * The LIVE screen, in one of three postures (titlebar-center switcher):
 * - coach (default): transcript rail | coach feed | intelligence board —
 *   the center belongs to the coach's one voice, not a chat pane.
 * - transcript: full-width transcript + the findings/analysis column.
 * - glance: a single narrow now-column for docking beside the meeting app.
 */
export function LiveScreen() {
  const layout = useStore((s) => s.settings.layout);
  const setHighlightMs = useStore((s) => s.setHighlightMs);

  // Persist dragged column proportions per posture; key=layout remounts the
  // group so saved sizes re-apply on a posture switch.
  const panelIds = useMemo(
    () =>
      layout === "coach"
        ? ["transcript", "feed", "board"]
        : layout === "transcript"
          ? ["transcript", "findings"]
          : ["glance"],
    [layout]
  );
  const saved = useDefaultLayout({ id: "parley:live", panelIds, storage: window.localStorage });

  if (layout === "glance") {
    return <GlanceView onSeek={setHighlightMs} />;
  }

  return (
    <ResizablePanelGroup
      key={layout}
      orientation="horizontal"
      className="min-h-0 flex-1"
      defaultLayout={saved.defaultLayout}
      onLayoutChanged={saved.onLayoutChanged}
    >
      {layout === "coach" ? (
        <>
          <ResizablePanel id="transcript" defaultSize={26} minSize={15}>
            <MeetingView />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="feed" defaultSize={48} minSize={30}>
            <CoachFeed onSeek={setHighlightMs} />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="board" defaultSize={26} minSize={16}>
            <IntelligenceBoard />
          </ResizablePanel>
        </>
      ) : (
        <>
          <ResizablePanel id="transcript" defaultSize={70} minSize={40}>
            <MeetingView />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="findings" defaultSize={30} minSize={18}>
            <FindingsPanel mode="live" onSeek={setHighlightMs} />
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}
