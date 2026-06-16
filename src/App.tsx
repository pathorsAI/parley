import { useEffect } from "react";
import { TitleBar } from "./components/TitleBar";
import { MeetingView } from "./components/MeetingView";
import { WorkPanel } from "./components/WorkPanel";
import { EvaluationsPanel } from "./components/sidebar/EvaluationsPanel";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { listenForTranscript } from "./lib/tauriEvents";
import { listenForSettings } from "./lib/settingsSync";
import { useEvaluationEngine } from "./lib/evaluations/engine";

function App() {
  // Subscribe to backend transcript events and settings updates from the
  // settings window for the app's lifetime.
  useEffect(() => {
    const unTranscript = listenForTranscript();
    const unSettings = listenForSettings();
    return () => {
      unTranscript.then((fn) => fn());
      unSettings.then((fn) => fn());
    };
  }, []);

  // Auto-rerun evaluations on their intervals while recording.
  useEvaluationEngine();

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <TitleBar />
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        {/* Left: transcript reference rail */}
        <ResizablePanel defaultSize={24} minSize={15}>
          <MeetingView />
        </ResizablePanel>
        <ResizableHandle withHandle />
        {/* Center: primary interactive work (Ask / TODO) */}
        <ResizablePanel defaultSize={48} minSize={30}>
          <WorkPanel />
        </ResizablePanel>
        <ResizableHandle withHandle />
        {/* Right: always-visible evaluation monitors */}
        <ResizablePanel defaultSize={28} minSize={18}>
          <EvaluationsPanel />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

export default App;
