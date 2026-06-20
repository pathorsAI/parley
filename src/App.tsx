import { useEffect } from "react";
import { TitleBar } from "./components/TitleBar";
import { MeetingView } from "./components/MeetingView";
import { ReplayView } from "./components/replay/ReplayView";
import { WorkPanel } from "./components/WorkPanel";
import { EvaluationsPanel } from "./components/sidebar/EvaluationsPanel";
import { Onboarding } from "./components/Onboarding";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useStore } from "./lib/store";
import { listenForTranscript } from "./lib/tauriEvents";
import { listenForSettings } from "./lib/settingsSync";
import { listenForSttUsage } from "./lib/usage/log";
import { initTemplatesSync } from "./lib/templatesSync";
import { initSessionSync } from "./lib/sessionSync";
import { initSessionCommands } from "./lib/sessionCommands";
import { useThemePreference } from "./lib/theme";
import { useEvaluationEngine } from "./lib/evaluations/engine";

function App() {
  useThemePreference();
  const appMode = useStore((s) => s.appMode);
  const layout = useStore((s) => s.settings.layout);
  const onboarded = useStore((s) => s.settings.onboarded);
  const showTranscript = layout !== "assistant";
  const showEvals = layout !== "transcript";

  useEffect(() => {
    const unTranscript = listenForTranscript();
    const unSettings = listenForSettings();
    const unTemplates = initTemplatesSync();
    const unSession = initSessionSync();
    const unSessionCmds = initSessionCommands();
    const unSttUsage = listenForSttUsage();
    return () => {
      unTranscript.then((fn) => fn());
      unSettings.then((fn) => fn());
      unTemplates();
      unSession();
      unSessionCmds();
      unSttUsage.then((fn) => fn());
    };
  }, []);

  // Auto-rerun evaluations on their intervals while recording.
  useEvaluationEngine();

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {!onboarded && <Onboarding />}
      <TitleBar />
      {appMode === "replay" ? (
        <ReplayView />
      ) : (
        /* key=layout remounts the group so panel sizes reset cleanly on change. */
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
                <EvaluationsPanel />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      )}
    </div>
  );
}

export default App;
