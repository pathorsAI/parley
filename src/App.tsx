import { useEffect } from "react";
import { TitleBar } from "./components/TitleBar";
import { MeetingView } from "./components/MeetingView";
import { Sidebar } from "./components/sidebar/Sidebar";
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
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_380px] grid-rows-[minmax(0,1fr)] overflow-hidden">
        <MeetingView />
        <Sidebar />
      </div>
    </div>
  );
}

export default App;
