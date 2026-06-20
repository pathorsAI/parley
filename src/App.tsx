import { useEffect } from "react";
import { TitleBar } from "./components/TitleBar";
import { LiveScreen } from "./components/live/LiveScreen";
import { ReplayScreen } from "./components/replay/ReplayScreen";
import { Onboarding } from "./components/Onboarding";
import { AnalysisErrorDialog } from "./components/AnalysisErrorDialog";
import { useStore } from "./lib/store";
import { listenForTranscript } from "./lib/tauriEvents";
import { listenForSettings } from "./lib/settingsSync";
import { listenForSttUsage } from "./lib/usage/log";
import { initTemplatesSync } from "./lib/templatesSync";
import { initSessionSync } from "./lib/sessionSync";
import { initSessionCommands } from "./lib/sessionCommands";
import { useThemePreference } from "./lib/theme";
import { useAnalysisEngine } from "./lib/analysis/engine";

function App() {
  useThemePreference();
  const appMode = useStore((s) => s.appMode);
  const onboarded = useStore((s) => s.settings.onboarded);

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

  // LIVE background engine: optional auto-analyze interval + TODO agenda auto-check.
  useAnalysisEngine();

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {!onboarded && <Onboarding />}
      <AnalysisErrorDialog />
      <TitleBar />
      {appMode === "replay" ? <ReplayScreen /> : <LiveScreen />}
    </div>
  );
}

export default App;
